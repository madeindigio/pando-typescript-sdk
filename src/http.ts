/**
 * PandoHttpClient — REST API client for pando running in HTTP server mode.
 *
 * Connects to a `pando serve` or `pando app` instance via the HTTP REST API.
 * Supports session management, SSE streaming, models, and personas.
 *
 * @example
 * ```typescript
 * import { PandoHttpClient } from '@pando-ai/sdk';
 *
 * const client = new PandoHttpClient({ baseUrl: 'http://localhost:8765' });
 *
 * const session = await client.sessions.create('My task');
 * for await (const chunk of client.sessions.sendMessage(session.id, 'Fix lint')) {
 *   process.stdout.write(chunk.delta ?? '');
 * }
 * ```
 */

import * as https from "node:https";
import type { HttpSession, HttpStreamChunk, ModelInfo } from "./types.js";
import { PandoConnectionError } from "./exceptions.js";

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

/**
 * Options for constructing a {@link PandoHttpClient}.
 */
export interface PandoHttpClientOptions {
  /**
   * Base URL of the pando HTTP server (e.g. `http://localhost:8765`).
   */
  baseUrl: string;
  /**
   * When `true`, TLS certificate validation is disabled (useful for self-signed
   * certs in local development). Default: `false`.
   */
  rejectUnauthorized?: boolean | undefined;
  /**
   * Request timeout in milliseconds. Default: `60_000`.
   */
  timeout?: number | undefined;
  /**
   * Bearer token for API authentication.
   */
  apiToken?: string | undefined;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/**
 * Build a fetch-compatible `RequestInit` with optional TLS agent and auth.
 */
function buildFetchInit(
  method: string,
  body: unknown | undefined,
  options: {
    rejectUnauthorized: boolean;
    timeout: number;
    apiToken?: string | undefined;
  }
): RequestInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (options.apiToken) {
    headers["Authorization"] = `Bearer ${options.apiToken}`;
  }

  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(options.timeout),
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  // For HTTPS URLs with rejectUnauthorized: false, inject a custom agent.
  if (!options.rejectUnauthorized) {
    // Node.js fetch (undici) respects the dispatcher option or agent.
    // We attach a custom dispatcher-compatible value for self-signed certs.
    // Since Node 18+ uses undici under the hood we use the https.Agent approach
    // via a custom fetch call if needed.
    (init as Record<string, unknown>)["agent"] = new https.Agent({
      rejectUnauthorized: false,
    });
  }

  return init;
}

async function fetchJSON<T>(
  url: string,
  method: string,
  body: unknown,
  opts: { rejectUnauthorized: boolean; timeout: number; apiToken?: string | undefined }
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, buildFetchInit(method, body, opts));
  } catch (err) {
    throw new PandoConnectionError(
      `HTTP request to ${url} failed: ${(err as Error).message}`
    );
  }

  if (!response.ok) {
    let errorText = "";
    try {
      const errJson = (await response.json()) as { error?: string };
      errorText = errJson.error ?? "";
    } catch {
      errorText = await response.text().catch(() => "");
    }
    throw new PandoConnectionError(
      `HTTP ${response.status} ${response.statusText} from ${url}${errorText ? `: ${errorText}` : ""}`
    );
  }

  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Sub-clients
// ---------------------------------------------------------------------------

/**
 * Session management sub-client.
 */
export class SessionsClient {
  constructor(
    private readonly _baseUrl: string,
    private readonly _opts: {
      rejectUnauthorized: boolean;
      timeout: number;
      apiToken?: string | undefined;
    }
  ) {}

  /**
   * Create a new session.
   *
   * @param title - Optional human-readable session title.
   * @returns The created session.
   */
  async create(title?: string): Promise<HttpSession> {
    const result = await fetchJSON<{ session: HttpSession }>(
      `${this._baseUrl}/api/v1/sessions`,
      "POST",
      { title: title ?? "New Session" },
      this._opts
    );
    return result.session;
  }

  /**
   * List all sessions.
   *
   * @returns Array of session objects.
   */
  async list(): Promise<HttpSession[]> {
    const result = await fetchJSON<{ sessions: HttpSession[] }>(
      `${this._baseUrl}/api/v1/sessions`,
      "GET",
      undefined,
      this._opts
    );
    return result.sessions;
  }

  /**
   * Get a session by ID (including its messages).
   *
   * @param sessionId - Session identifier.
   */
  async get(sessionId: string): Promise<HttpSession> {
    const result = await fetchJSON<{ session: HttpSession }>(
      `${this._baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      "GET",
      undefined,
      this._opts
    );
    return result.session;
  }

  /**
   * Delete a session and all its messages.
   *
   * @param sessionId - Session identifier.
   */
  async delete(sessionId: string): Promise<void> {
    await fetchJSON<unknown>(
      `${this._baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      "DELETE",
      undefined,
      this._opts
    );
  }

  /**
   * Rename a session.
   *
   * @param sessionId - Session identifier.
   * @param title - New title.
   * @returns The updated session.
   */
  async rename(sessionId: string, title: string): Promise<HttpSession> {
    const result = await fetchJSON<{ session: HttpSession }>(
      `${this._baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      "PATCH",
      { title },
      this._opts
    );
    return result.session;
  }

  /**
   * Send a message to a session and stream SSE events back.
   *
   * The generator yields {@link HttpStreamChunk} values for each SSE event.
   * The `delta` convenience field is populated for `content_delta` events.
   *
   * @param sessionId - Session to send the message to.
   * @param prompt - The prompt text.
   *
   * @example
   * ```typescript
   * for await (const chunk of client.sessions.sendMessage(sessionId, 'Hello')) {
   *   if (chunk.event === 'content_delta') {
   *     process.stdout.write(chunk.delta ?? '');
   *   }
   * }
   * ```
   */
  async *sendMessage(
    sessionId: string,
    prompt: string
  ): AsyncGenerator<HttpStreamChunk> {
    const url = `${this._baseUrl}/api/v1/chat/stream`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (this._opts.apiToken) {
      headers["Authorization"] = `Bearer ${this._opts.apiToken}`;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ sessionId, prompt }),
        signal: AbortSignal.timeout(this._opts.timeout),
      });
    } catch (err) {
      throw new PandoConnectionError(
        `SSE request failed: ${(err as Error).message}`
      );
    }

    if (!response.ok) {
      throw new PandoConnectionError(
        `HTTP ${response.status} from ${url}`
      );
    }

    if (!response.body) {
      throw new PandoConnectionError("Response body is null");
    }

    yield* this._parseSSEStream(response.body);
  }

  /**
   * Stream messages from an existing background session (reconnect).
   *
   * @param sessionId - Session to reconnect to.
   */
  async *streamSession(sessionId: string): AsyncGenerator<HttpStreamChunk> {
    const url = `${this._baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/stream`;

    const headers: Record<string, string> = {
      Accept: "text/event-stream",
    };
    if (this._opts.apiToken) {
      headers["Authorization"] = `Bearer ${this._opts.apiToken}`;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this._opts.timeout),
      });
    } catch (err) {
      throw new PandoConnectionError(
        `SSE reconnect failed: ${(err as Error).message}`
      );
    }

    if (!response.ok) {
      throw new PandoConnectionError(`HTTP ${response.status} from ${url}`);
    }

    if (!response.body) {
      throw new PandoConnectionError("Response body is null");
    }

    yield* this._parseSSEStream(response.body);
  }

  private async *_parseSSEStream(
    body: ReadableStream<Uint8Array>
  ): AsyncGenerator<HttpStreamChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE blocks (separated by double newlines).
        const blocks = buffer.split("\n\n");
        // The last element is an incomplete block; keep it.
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          const chunk = this._parseSSEBlock(block);
          if (chunk) {
            yield chunk;
            if (chunk.event === "done") return;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private _parseSSEBlock(block: string): HttpStreamChunk | null {
    const lines = block.split("\n");
    let event = "message";
    let dataStr = "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        event = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        dataStr = line.slice(6).trim();
      }
    }

    if (!dataStr) return null;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataStr) as Record<string, unknown>;
    } catch {
      data = { raw: dataStr };
    }

    const chunk: HttpStreamChunk = { event, data };

    // Populate convenience delta field.
    if (event === "content_delta") {
      const text = data["text"] ?? data["delta"];
      if (typeof text === "string") {
        chunk.delta = text;
      }
    }

    return chunk;
  }
}

/**
 * Model management sub-client.
 */
export class ModelsClient {
  constructor(
    private readonly _baseUrl: string,
    private readonly _opts: {
      rejectUnauthorized: boolean;
      timeout: number;
      apiToken?: string | undefined;
    }
  ) {}

  /**
   * List all available models.
   *
   * @returns Array of model info objects.
   */
  async list(): Promise<ModelInfo[]> {
    const result = await fetchJSON<{ models: ModelInfo[] }>(
      `${this._baseUrl}/api/v1/models`,
      "GET",
      undefined,
      this._opts
    );
    return result.models;
  }

  /**
   * Set the globally active model.
   *
   * @param modelId - Model identifier.
   */
  async setActive(modelId: string): Promise<void> {
    await fetchJSON<unknown>(
      `${this._baseUrl}/api/v1/models/active`,
      "PUT",
      { model: modelId },
      this._opts
    );
  }
}

/**
 * Persona management sub-client.
 */
export class PersonasClient {
  constructor(
    private readonly _baseUrl: string,
    private readonly _opts: {
      rejectUnauthorized: boolean;
      timeout: number;
      apiToken?: string | undefined;
    }
  ) {}

  /**
   * List all available personas.
   *
   * @returns Array of persona name strings.
   */
  async list(): Promise<string[]> {
    const result = await fetchJSON<{ personas: string[] }>(
      `${this._baseUrl}/api/v1/personas`,
      "GET",
      undefined,
      this._opts
    );
    return result.personas;
  }

  /**
   * Get the currently active persona.
   *
   * @returns The active persona name.
   */
  async getActive(): Promise<string> {
    const result = await fetchJSON<{ active: string }>(
      `${this._baseUrl}/api/v1/personas/active`,
      "GET",
      undefined,
      this._opts
    );
    return result.active;
  }

  /**
   * Set the active persona.
   *
   * @param name - Persona name.
   */
  async setActive(name: string): Promise<void> {
    await fetchJSON<unknown>(
      `${this._baseUrl}/api/v1/personas/active`,
      "PUT",
      { name },
      this._opts
    );
  }
}

// ---------------------------------------------------------------------------
// PandoHttpClient
// ---------------------------------------------------------------------------

/**
 * REST API client for a pando HTTP server instance.
 *
 * Provides typed sub-clients for sessions, models, and personas.
 *
 * @example
 * ```typescript
 * const client = new PandoHttpClient({
 *   baseUrl: 'http://localhost:8765',
 *   apiToken: 'my-token',
 * });
 *
 * const sessions = await client.sessions.list();
 * const models = await client.models.list();
 * await client.models.setActive('claude-sonnet-4-6');
 * ```
 */
export class PandoHttpClient {
  /** Session management operations. */
  readonly sessions: SessionsClient;
  /** Model management operations. */
  readonly models: ModelsClient;
  /** Persona management operations. */
  readonly personas: PersonasClient;

  private readonly _baseUrl: string;
  private readonly _opts: {
    rejectUnauthorized: boolean;
    timeout: number;
    apiToken?: string | undefined;
  };

  /**
   * @param options - HTTP client configuration.
   */
  constructor(options: PandoHttpClientOptions) {
    this._baseUrl = options.baseUrl.replace(/\/$/, "");
    this._opts = {
      rejectUnauthorized: options.rejectUnauthorized ?? true,
      timeout: options.timeout ?? 60_000,
      apiToken: options.apiToken,
    };

    this.sessions = new SessionsClient(this._baseUrl, this._opts);
    this.models = new ModelsClient(this._baseUrl, this._opts);
    this.personas = new PersonasClient(this._baseUrl, this._opts);
  }

  /**
   * Check whether the pando HTTP server is healthy.
   *
   * @returns `true` if the server responds with a 200 status.
   */
  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this._baseUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
