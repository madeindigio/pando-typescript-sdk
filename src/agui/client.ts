/**
 * PandoAguiClient — dependency-free client for Pando's AG-UI endpoint.
 *
 * It speaks the wire protocol directly (POST a `RunAgentInput`, read back an SSE
 * stream of events), so it works in a plain Node script, an edge function or a
 * browser, without CopilotKit. For a CopilotKit runtime, see `copilotkit.ts`.
 *
 * @example
 * ```typescript
 * import { PandoAguiClient } from '@pando-ai/sdk/agui';
 *
 * const client = new PandoAguiClient({
 *   baseUrl: 'http://localhost:8090',
 *   token: process.env.PANDO_TOKEN,
 * });
 *
 * for await (const event of client.run({ prompt: 'List the Go packages' })) {
 *   if (event.type === 'TEXT_MESSAGE_CONTENT') process.stdout.write(event.delta);
 * }
 * ```
 */

import { PandoConnectionError, PandoError } from "../exceptions.js";
import type {
  AguiEvent,
  AguiInfo,
  AguiMessage,
  AguiTool,
  AguiContext,
  RunAgentInput,
} from "./types.js";

/** The route prefix `pando agui-serve` uses out of the box. */
export const DEFAULT_AGUI_PATH = "/api/v1/agui";

/** The synthetic tool a permission prompt arrives as. */
export const PERMISSION_TOOL_NAME = "pando_permission_request";

/** Arguments of a {@link PERMISSION_TOOL_NAME} call. */
export interface PandoPermissionRequest {
  toolName: string;
  action: string;
  description?: string;
  path?: string;
  params?: unknown;
}

/**
 * Answer shape the adapter accepts for a permission prompt. Anything else —
 * including no answer at all — is read as a denial.
 */
export interface PandoPermissionAnswer {
  approved: boolean;
}

export interface PandoAguiClientOptions {
  /** Origin of the adapter, e.g. `http://localhost:8090`. */
  baseUrl: string;
  /** Route prefix. Defaults to {@link DEFAULT_AGUI_PATH}. */
  path?: string;
  /** Agent to run. Defaults to `coder`. */
  agent?: string;
  /**
   * Bearer token. Required unless the server was started with `--no-token`:
   * the adapter rejects unauthenticated requests with 401.
   */
  token?: string | undefined;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /** Milliseconds to wait for the response headers. Default `60_000`. */
  timeout?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Options of a single {@link PandoAguiClient.run} call. */
export interface RunOptions {
  /** The user's message. Ignored when `messages` is given. */
  prompt?: string;
  /**
   * The full transcript. AG-UI clients own the visible history and resend it on
   * every turn; use this to resume a thread or to answer a frontend tool call.
   */
  messages?: AguiMessage[];
  /** Thread to continue. A new one is generated when omitted. */
  threadId?: string;
  runId?: string;
  /** Tools the caller implements. The agent calling one interrupts the run. */
  tools?: AguiTool[];
  context?: AguiContext[];
  state?: unknown;
  /** Agent for this run, overriding the client's default. */
  agent?: string;
  signal?: AbortSignal;
}

/** Raised when the adapter answers with a non-2xx status. */
export class PandoAguiError extends PandoError {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PandoAguiError";
    this.status = status;
  }
}

export class PandoAguiClient {
  private readonly baseUrl: string;
  private readonly path: string;
  private readonly agent: string;
  private readonly token: string | undefined;
  private readonly headers: Record<string, string>;
  private readonly timeout: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PandoAguiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.path = (options.path ?? DEFAULT_AGUI_PATH).replace(/\/+$/, "");
    this.agent = options.agent ?? "coder";
    this.token = options.token;
    this.headers = options.headers ?? {};
    this.timeout = options.timeout ?? 60_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new PandoError(
        "no fetch implementation available; pass options.fetch on Node < 18",
      );
    }
  }

  /** Absolute run endpoint of an agent. */
  agentUrl(agent: string = this.agent): string {
    return `${this.baseUrl}${this.path}/${agent}`;
  }

  private requestHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...this.headers, ...extra };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    return headers;
  }

  /**
   * Fetches the discovery document: which agents exist, their absolute URLs,
   * the model behind each and which optional halves of the protocol this
   * deployment implements.
   */
  async info(signal?: AbortSignal): Promise<AguiInfo> {
    const response = await this.request(`${this.baseUrl}${this.path}/info`, {
      method: "GET",
      headers: this.requestHeaders(),
      ...(signal ? { signal } : {}),
    });
    return (await response.json()) as AguiInfo;
  }

  /**
   * Runs the agent and yields protocol events as they arrive.
   *
   * The stream ends with `RUN_FINISHED`. An outcome of `interrupt` means the
   * agent called one of the caller's `tools`: execute it and call `run` again
   * on the same thread with the transcript plus a `tool` message carrying the
   * result, which resumes the suspended run.
   */
  async *run(options: RunOptions): AsyncGenerator<AguiEvent, void, undefined> {
    const input = this.buildInput(options);
    const url = this.agentUrl(options.agent ?? this.agent);

    const response = await this.request(url, {
      method: "POST",
      headers: this.requestHeaders({
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      }),
      body: JSON.stringify(input),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (!response.body) {
      throw new PandoConnectionError("AG-UI response carried no body");
    }
    yield* parseSSE(response.body);
  }

  /**
   * Convenience wrapper that runs a prompt and returns the assistant's text.
   * Tool calls, state and reasoning are dropped: use {@link run} when they
   * matter.
   */
  async runText(prompt: string, options: Omit<RunOptions, "prompt"> = {}): Promise<string> {
    let text = "";
    for await (const event of this.run({ ...options, prompt })) {
      if (event.type === "TEXT_MESSAGE_CONTENT") {
        text += event.delta;
      } else if (event.type === "RUN_ERROR") {
        throw new PandoAguiError(0, event.message);
      }
    }
    return text;
  }

  /** Builds the request body from the friendlier {@link RunOptions}. */
  private buildInput(options: RunOptions): RunAgentInput {
    const messages =
      options.messages ??
      (options.prompt === undefined
        ? []
        : [{ id: randomId("msg"), role: "user" as const, content: options.prompt }]);

    const input: RunAgentInput = {
      threadId: options.threadId ?? randomId("thread"),
      runId: options.runId ?? randomId("run"),
      messages,
    };
    if (options.tools?.length) input.tools = options.tools;
    if (options.context?.length) input.context = options.context;
    if (options.state !== undefined) input.state = options.state;
    return input;
  }

  /** Issues a request, applying the timeout and mapping failures. */
  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    // The caller's signal must still abort a stream that is already flowing,
    // long after the header timeout has been cleared.
    const external = init.signal;
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      throw new PandoConnectionError(
        `AG-UI request to ${url} failed: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new PandoAguiError(response.status, await errorMessage(response));
    }
    return response;
  }
}

/**
 * Parses an SSE body into events.
 *
 * The adapter sends one JSON object per `data:` line and never splits an event
 * across frames, but a chunk boundary can fall anywhere, so frames are
 * reassembled from the raw byte stream.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<AguiEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseFrame(frame);
        if (event) yield event;
        boundary = buffer.indexOf("\n\n");
      }
    }
    // A stream cut without its final blank line still carries a whole event.
    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/** Extracts the JSON payload of one SSE frame, or null when it carries none. */
function parseFrame(frame: string): AguiEvent | null {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data) as AguiEvent;
  } catch {
    // A malformed frame must not kill a run that is otherwise fine.
    return null;
  }
}

/** Reads the adapter's JSON error body, falling back to the status text. */
async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    const detail = body.error ?? body.message;
    if (detail) return detail;
  } catch {
    // Not JSON; fall through.
  }
  return `${response.status} ${response.statusText}`;
}

/** Builds an id that is unique enough for a thread, run or message. */
export function randomId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
