/**
 * PandoAgent — high-level client for Pando running in ACP stdio mode.
 *
 * Spawns `pando acp` as a long-running subprocess and communicates with it
 * using JSON-RPC 2.0 over newline-delimited stdin/stdout.
 *
 * @example
 * ```typescript
 * import { PandoAgent } from '@pando-ai/sdk';
 *
 * const agent = new PandoAgent({ cwd: '/path/to/project' });
 * await agent.connect();
 *
 * const session = await agent.createSession('My task');
 * const response = await session.ask('Explain the main function');
 * console.log(response);
 *
 * await agent.disconnect();
 * ```
 *
 * @example Using `await using` (Node 18+ with `Symbol.asyncDispose`):
 * ```typescript
 * await using agent = new PandoAgent({ cwd: '/project' });
 * await agent.connect();
 * const session = await agent.createSession('task');
 * console.log(await session.ask('Hello'));
 * // agent.disconnect() is called automatically on scope exit
 * ```
 */

import { JsonRpcTransport } from "./transport.js";
import { PandoSession } from "./session.js";
import { PandoConnectionError } from "./exceptions.js";
import type {
  PermissionCallback,
  SessionInfo,
  ModelInfo,
} from "./types.js";

/**
 * Options for constructing a {@link PandoAgent}.
 */
export interface PandoAgentOptions {
  /**
   * Working directory passed to `pando acp --cwd`.
   * Defaults to `process.cwd()` when omitted.
   */
  cwd?: string | undefined;
  /**
   * Model identifier to use for all sessions by default.
   * Can be overridden per-session via {@link PandoSession.setModel}.
   */
  model?: string | undefined;
  /**
   * Persona name to apply to each new session.
   * Built-in values: `assistant`, `software-engineer`, `qa`, `system-engineer`.
   */
  persona?: string | undefined;
  /**
   * Path to the `pando` binary.
   * Resolved automatically via `PANDO_PATH` env var and `PATH` if omitted.
   */
  pandoPath?: string | undefined;
  /**
   * Callback invoked when the agent requests tool permission.
   * Return `true` to approve, `false` to deny.
   * When omitted all permissions are handled by the agent's default behavior.
   */
  onToolPermission?: PermissionCallback | undefined;
}

/**
 * High-level client for Pando in ACP stdio mode.
 *
 * Manages a single `pando acp` subprocess and exposes typed methods for
 * session management and RPC operations.
 */
export class PandoAgent {
  private readonly _transport: JsonRpcTransport;
  private readonly _options: PandoAgentOptions;
  private _connected = false;

  /**
   * Create a new {@link PandoAgent} instance.
   *
   * The agent is not connected until {@link connect} is called.
   *
   * @param options - Agent configuration options.
   */
  constructor(options: PandoAgentOptions = {}) {
    this._options = options;
    this._transport = new JsonRpcTransport({
      pandoPath: options.pandoPath,
      cwd: options.cwd ?? process.cwd(),
      onPermission: options.onToolPermission,
    });
  }

  /** Whether the agent is connected to a running pando subprocess. */
  get connected(): boolean {
    return this._connected;
  }

  /**
   * Spawn the `pando acp` subprocess and establish the JSON-RPC connection.
   *
   * Must be called before any other method. Safe to call only once; subsequent
   * calls are no-ops if already connected.
   *
   * @throws {PandoBinaryNotFoundError} If the pando binary cannot be located.
   * @throws {PandoConnectionError} If the subprocess fails to start.
   */
  async connect(): Promise<void> {
    if (this._connected) return;
    await this._transport.connect();
    this._connected = true;
  }

  /**
   * Gracefully disconnect from the pando subprocess.
   *
   * Sends an end-of-file to stdin, causing the pando ACP server to exit.
   * Waits up to 3 seconds before sending SIGKILL.
   */
  async disconnect(): Promise<void> {
    if (!this._connected) return;
    this._connected = false;
    await this._transport.disconnect();
  }

  /**
   * Required for `await using` support (`Symbol.asyncDispose`).
   * Calls {@link disconnect} automatically when leaving the scope.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.disconnect();
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  /**
   * Create a new conversation session.
   *
   * The returned {@link PandoSession} is ready for prompts. Remember to call
   * {@link PandoSession.close} when done to release server-side resources.
   *
   * @param title - Optional human-readable title for the session.
   *   Used in session lists.
   * @returns A new session object bound to the underlying ACP connection.
   *
   * @example
   * ```typescript
   * const session = await agent.createSession('Bug fix task');
   * const answer = await session.ask('What files have TODO comments?');
   * await session.close();
   * ```
   */
  async createSession(title?: string): Promise<PandoSession> {
    this._assertConnected();

    const result = await this._transport.request<{ sessionId: string }>(
      "session/create",
      {
        title: title ?? "New Session",
        cwd: this._options.cwd ?? process.cwd(),
        mcpServers: [],
      }
    );

    const session = new PandoSession(result.sessionId, this._transport);

    // Apply default model if configured.
    if (this._options.model) {
      try {
        await session.setModel(this._options.model);
      } catch {
        // Non-fatal: the model override is best-effort.
      }
    }

    // Apply default persona if configured.
    if (this._options.persona) {
      try {
        await session.setPersona(this._options.persona);
      } catch {
        // Non-fatal.
      }
    }

    return session;
  }

  /**
   * Load an existing session by its ID.
   *
   * The server will replay the conversation history to the client and return
   * a session ready for new prompts.
   *
   * @param sessionId - The session ID to load.
   * @returns A session object for the existing conversation.
   */
  async loadSession(sessionId: string): Promise<PandoSession> {
    this._assertConnected();

    await this._transport.request("session/load", {
      sessionId,
      cwd: this._options.cwd ?? process.cwd(),
    });

    return new PandoSession(sessionId, this._transport);
  }

  /**
   * List all sessions stored on the server.
   *
   * @returns An array of session info objects.
   */
  async listSessions(): Promise<SessionInfo[]> {
    this._assertConnected();

    const result = await this._transport.request<{
      sessions: Array<{
        sessionId: string;
        title?: string;
        updatedAt?: string;
        cwd?: string;
      }>;
    }>("session/list");

    return result.sessions.map((s) => ({
      sessionId: s.sessionId,
      title: s.title,
      updatedAt: s.updatedAt,
      cwd: s.cwd,
    }));
  }

  // ---------------------------------------------------------------------------
  // Persona management
  // ---------------------------------------------------------------------------

  /**
   * List all available persona names.
   *
   * @returns An array of persona name strings (e.g. `["assistant", "software-engineer"]`).
   */
  async listPersonas(): Promise<string[]> {
    this._assertConnected();
    const result = await this._transport.request<{ personas: string[] }>(
      "persona/list"
    );
    return result.personas;
  }

  /**
   * Get the currently active global persona.
   *
   * @returns The name of the active persona.
   */
  async getPersona(): Promise<string> {
    this._assertConnected();
    const result = await this._transport.request<{ active: string }>(
      "persona/get"
    );
    return result.active;
  }

  /**
   * Set the global active persona.
   *
   * @param name - Persona name (must be one of the values returned by {@link listPersonas}).
   */
  async setPersona(name: string): Promise<void> {
    this._assertConnected();
    await this._transport.request("persona/set", { name });
  }

  // ---------------------------------------------------------------------------
  // Model management
  // ---------------------------------------------------------------------------

  /**
   * List all models available to the agent.
   *
   * @returns An array of {@link ModelInfo} objects.
   */
  async listModels(): Promise<ModelInfo[]> {
    this._assertConnected();
    const result = await this._transport.request<{
      models: Array<{
        id: string;
        name: string;
        provider: string;
        description?: string;
        badges?: string[];
        canReason?: boolean;
      }>;
    }>("model/list");

    return result.models.map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      description: m.description,
      badges: m.badges,
      canReason: m.canReason,
    }));
  }

  /**
   * Set the global active model.
   *
   * @param modelId - Model identifier (e.g. `claude-sonnet-4-6`).
   */
  async setModel(modelId: string): Promise<void> {
    this._assertConnected();
    await this._transport.request("model/set", { modelId });
  }

  // ---------------------------------------------------------------------------
  // Tool management
  // ---------------------------------------------------------------------------

  /**
   * List all tools available to the agent.
   *
   * @returns An array of tool descriptor objects.
   */
  async listTools(): Promise<Array<{ name: string; description: string }>> {
    this._assertConnected();
    const result = await this._transport.request<{
      tools: Array<{ name: string; description: string }>;
    }>("tool/list");
    return result.tools;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _assertConnected(): void {
    if (!this._connected) {
      throw new PandoConnectionError(
        "PandoAgent is not connected. Call connect() before using the agent."
      );
    }
  }
}
