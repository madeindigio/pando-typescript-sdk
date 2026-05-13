/**
 * JSON-RPC 2.0 transport layer for the Pando ACP stdio protocol.
 *
 * This module handles:
 * - Finding the pando binary on the host system.
 * - Spawning `pando acp` as a subprocess.
 * - Writing newline-delimited JSON-RPC requests to its stdin.
 * - Reading newline-delimited JSON-RPC responses/notifications from its stdout.
 * - Routing responses to pending request promises.
 * - Routing `agent/event` notifications to per-session event queues.
 */

import { EventEmitter } from "node:events";
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, accessSync, constants as fsConstants } from "node:fs";
import { sep as pathSep, join as pathJoin } from "node:path";

import {
  PandoBinaryNotFoundError,
  PandoConnectionError,
  PandoRPCError,
} from "./exceptions.js";
import { parseAgentEvent } from "./events.js";
import type {
  AgentEvent,
  AgentEventParams,
  JsonRpcMessage,
  PermissionCallback,
  PermissionRequest,
} from "./types.js";

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the `pando` binary.
 *
 * Resolution order:
 * 1. The `pandoPath` argument (if provided).
 * 2. The `PANDO_PATH` environment variable.
 * 3. Each directory listed in `PATH` (cross-platform).
 *
 * @throws {PandoBinaryNotFoundError} When the binary cannot be found.
 */
export function findPandoBinary(pandoPath?: string): string {
  const searched: string[] = [];

  // 1. Explicit argument
  if (pandoPath) {
    searched.push(pandoPath);
    if (existsSync(pandoPath) && isExecutable(pandoPath)) {
      return pandoPath;
    }
  }

  // 2. PANDO_PATH env var
  const envPath = process.env["PANDO_PATH"];
  if (envPath) {
    searched.push(envPath);
    if (existsSync(envPath) && isExecutable(envPath)) {
      return envPath;
    }
  }

  // 3. Search PATH
  const pathEnv = process.env["PATH"] ?? "";
  const pathDirs = pathEnv.split(pathSep === "\\" ? ";" : ":");
  const binaryName = process.platform === "win32" ? "pando.exe" : "pando";

  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = pathJoin(dir, binaryName);
    searched.push(candidate);
    if (existsSync(candidate) && isExecutable(candidate)) {
      return candidate;
    }
  }

  throw new PandoBinaryNotFoundError(searched);
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session event emitter / queue
// ---------------------------------------------------------------------------

/**
 * Per-session event emitter that buffers events until an async consumer
 * retrieves them.
 */
class SessionEventQueue extends EventEmitter {
  private readonly _queue: AgentEvent[] = [];
  private _done = false;
  private _error: Error | undefined;

  push(event: AgentEvent): void {
    this._queue.push(event);
    this.emit("data");
  }

  complete(): void {
    this._done = true;
    this.emit("data");
  }

  fail(err: Error): void {
    this._error = err;
    this._done = true;
    this.emit("data");
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
    while (true) {
      while (this._queue.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        yield this._queue.shift()!;
      }
      if (this._done) {
        if (this._error) throw this._error;
        return;
      }
      await new Promise<void>((resolve) => this.once("data", resolve));
    }
  }
}

// ---------------------------------------------------------------------------
// JsonRpcTransport
// ---------------------------------------------------------------------------

/** Options for constructing a {@link JsonRpcTransport}. */
export interface TransportOptions {
  /** Path to the pando binary. Resolved via {@link findPandoBinary} if omitted. */
  pandoPath?: string | undefined;
  /** Working directory for the spawned subprocess. */
  cwd?: string | undefined;
  /** Additional environment variables to pass to the subprocess. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Optional permission callback for tool approval. */
  onPermission?: PermissionCallback | undefined;
}

/**
 * Low-level JSON-RPC 2.0 transport over a `pando acp` stdio subprocess.
 *
 * Manages the child process lifecycle, request/response correlation, and
 * per-session event routing.
 *
 * Consumers should use {@link PandoAgent} rather than this class directly.
 */
export class JsonRpcTransport extends EventEmitter {
  private child: ChildProcess | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  private readonly sessionQueues = new Map<string, SessionEventQueue>();
  private _connected = false;
  private readonly _pandoPath: string;
  private readonly _cwd: string | undefined;
  private readonly _env: NodeJS.ProcessEnv | undefined;
  private readonly _onPermission: PermissionCallback | undefined;

  constructor(options: TransportOptions = {}) {
    super();
    this._pandoPath = findPandoBinary(options.pandoPath);
    this._cwd = options.cwd;
    this._env = options.env;
    this._onPermission = options.onPermission;
  }

  /** Whether the transport subprocess is alive and connected. */
  get connected(): boolean {
    return this._connected;
  }

  /**
   * Spawn the `pando acp` subprocess and start processing its stdio.
   *
   * @throws {PandoConnectionError} If the process fails to start.
   */
  async connect(): Promise<void> {
    if (this._connected) {
      return;
    }

    const child = spawn(this._pandoPath, ["acp"], {
      cwd: this._cwd,
      env: { ...process.env, ...this._env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child = child;

    child.on("error", (err) => {
      this._onProcessError(new PandoConnectionError(`pando process error: ${err.message}`));
    });

    child.on("close", (code) => {
      if (this._connected) {
        this._onProcessError(
          new PandoConnectionError(`pando process exited unexpectedly`, code ?? -1)
        );
      }
    });

    // Pipe stderr to process.stderr for debugging.
    child.stderr?.pipe(process.stderr);

    // Set up readline interface for newline-delimited JSON.
    const rl = createInterface({
      input: child.stdout!,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      this._onLine(line);
    });

    rl.on("close", () => {
      if (this._connected) {
        this._onProcessError(
          new PandoConnectionError("pando stdout closed unexpectedly")
        );
      }
    });

    this._connected = true;
  }

  /**
   * Send a JSON-RPC 2.0 request and await the response.
   *
   * @param method - RPC method name.
   * @param params - Optional params object.
   * @returns The `result` field of the JSON-RPC response.
   * @throws {PandoRPCError} On JSON-RPC error responses.
   * @throws {PandoConnectionError} If the process is not connected.
   */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this._connected || !this.child?.stdin) {
      throw new PandoConnectionError("Transport is not connected. Call connect() first.");
    }

    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });

      const written = this.child!.stdin!.write(message + "\n");
      if (!written) {
        // Handle backpressure: wait for drain before failing.
        this.child!.stdin!.once("drain", () => {
          // The write already happened; nothing to do here.
        });
      }
    });
  }

  /**
   * Get (or create) an async event iterator for a specific session.
   * Yields events until the session completes or encounters an error.
   *
   * @param sessionId - The ACP session ID to subscribe to.
   */
  getSessionEvents(sessionId: string): AsyncGenerator<AgentEvent> {
    let queue = this.sessionQueues.get(sessionId);
    if (!queue) {
      queue = new SessionEventQueue();
      this.sessionQueues.set(sessionId, queue);
    }
    return queue[Symbol.asyncIterator]();
  }

  /**
   * Create a new session event queue for the given session ID.
   * Replaces any existing queue.
   */
  createSessionQueue(sessionId: string): void {
    const queue = new SessionEventQueue();
    this.sessionQueues.set(sessionId, queue);
  }

  /**
   * Mark a session queue as complete (no more events).
   */
  completeSession(sessionId: string): void {
    this.sessionQueues.get(sessionId)?.complete();
    this.sessionQueues.delete(sessionId);
  }

  /**
   * Gracefully disconnect: close the subprocess stdin (which triggers ACP server
   * to shut down) and mark as disconnected.
   */
  async disconnect(): Promise<void> {
    if (!this._connected) return;
    this._connected = false;

    // Reject all pending requests.
    const err = new PandoConnectionError("Transport disconnected");
    for (const [, { reject }] of this.pending) {
      reject(err);
    }
    this.pending.clear();

    // Complete all session queues.
    for (const [, queue] of this.sessionQueues) {
      queue.fail(err);
    }
    this.sessionQueues.clear();

    // Close child process.
    if (this.child) {
      this.child.stdin?.end();
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.child?.kill("SIGKILL");
          resolve();
        }, 3000);
        this.child?.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      this.child = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: line processing
  // ---------------------------------------------------------------------------

  private _onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      // Ignore non-JSON lines (e.g. log output).
      return;
    }

    // Check if this is a response to a pending request (has an id).
    if ("id" in msg && typeof msg.id === "number") {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);

      if ("error" in msg && msg.error) {
        entry.reject(new PandoRPCError(msg.error.code, msg.error.message));
      } else if ("result" in msg) {
        entry.resolve(msg.result);
      }
      return;
    }

    // Check if this is a notification (no id).
    if ("method" in msg) {
      this._onNotification(msg.method, msg.params);
    }
  }

  private _onNotification(method: string, params: unknown): void {
    if (method !== "agent/event") return;

    const rawParams = params as AgentEventParams;
    if (!rawParams || typeof rawParams !== "object") return;

    const sessionId = rawParams.sessionId;
    if (!sessionId) return;

    // Handle permission_request events specially.
    if ((rawParams.type as string) === "permission_request") {
      this._handlePermissionRequest(rawParams).catch(() => {
        // Permission handling errors are non-fatal.
      });
      return;
    }

    const event = parseAgentEvent(rawParams);
    if (!event) return;

    // Route to session queue.
    let queue = this.sessionQueues.get(sessionId);
    if (!queue) {
      queue = new SessionEventQueue();
      this.sessionQueues.set(sessionId, queue);
    }

    queue.push(event);

    // Complete the queue on terminal events.
    if (event.type === "response" || event.type === "error") {
      queue.complete();
      this.sessionQueues.delete(sessionId);
    }
  }

  private async _handlePermissionRequest(params: AgentEventParams): Promise<void> {
    if (!this._onPermission) return;

    const request: PermissionRequest = {
      sessionId: params.sessionId,
      toolName: (params as unknown as Record<string, string>)["toolName"] ?? "",
      description: (params as unknown as Record<string, string>)["description"] ?? "",
      action: (params as unknown as Record<string, string>)["action"] ?? "",
      path: (params as unknown as Record<string, string>)["path"] ?? "",
      params: ((params as unknown as Record<string, unknown>)["params"] as Record<string, unknown>) ?? {},
    };

    const approved = await this._onPermission(request);

    // Send permission response back to the agent.
    try {
      await this.request("permission/respond", {
        sessionId: params.sessionId,
        approved,
      });
    } catch {
      // Best-effort.
    }
  }

  private _onProcessError(err: PandoConnectionError): void {
    this._connected = false;

    for (const [, { reject }] of this.pending) {
      reject(err);
    }
    this.pending.clear();

    for (const [, queue] of this.sessionQueues) {
      queue.fail(err);
    }
    this.sessionQueues.clear();

    this.emit("error", err);
  }
}
