/**
 * `PandoThread` — a stateful transcript, shared-state document and interrupt
 * helper over {@link PandoAguiClient}.
 *
 * `PandoAguiClient.run()` only streams protocol events; it accumulates
 * nothing. `PandoThread` is the client-side owner of one conversation: it
 * keeps `threadId` stable across turns (the Go side happily accepts a Pando
 * session id reused as the thread id, `internal/agui/runtime.go:138-144`),
 * reduces the event stream into a transcript and a shared-state document, and
 * detects the interrupt/resume handoff so a chat panel does not have to
 * re-derive any of it from the Go source.
 *
 * It is a pure client-side projection: there is no thread-list, history-fetch
 * or reattach endpoint on the server (`internal/agui/server.go:26-33` mounts
 * only `/info`, `OPTIONS` and the run POST), so a page that reloads loses the
 * transcript unless it persists `PandoThread` state itself.
 */

import { PandoError } from "../exceptions.js";
import { PandoAguiClient, randomId } from "./client.js";
import type { AguiRunOptions } from "./client.js";
import type {
  AguiContext,
  AguiEvent,
  AguiMessage,
  AguiRole,
  AguiTool,
  AguiToolCall,
  JsonPatchOperation,
  PandoState,
} from "./types.js";

/** A `CUSTOM` event, as surfaced by {@link PandoThreadOptions.onCustom}. */
export type PandoCustomEvent = Extract<AguiEvent, { type: "CUSTOM" }>;

/** A tool call the agent made that is still waiting for a result. */
export interface PendingToolCall {
  /** The AG-UI tool call id (`toolCallId`). */
  id: string;
  /** The tool name the model called. */
  name: string;
  /** Raw JSON string of the arguments, exactly as streamed by the adapter. */
  argsText: string;
  /** `argsText` parsed as JSON, or `undefined` when it is not valid JSON. */
  args: unknown;
}

export interface PandoThreadOptions {
  /** The transport. `PandoThread` composes it; its signature is untouched. */
  client: PandoAguiClient;
  /**
   * Reuse an existing thread id (e.g. a Pando session id the caller already
   * has). A fresh one is generated when omitted, and is then reused for
   * every subsequent `send`/`resume` call on this thread.
   */
  threadId?: string;
  /** Agent to run, overriding the client's default for every call. */
  agent?: string;
  /** Frontend tools declared on every run, unless a call overrides them. */
  tools?: AguiTool[];
  /**
   * Called for every `CUSTOM` event: `pando.summarize`,
   * `pando.frontendToolsDisabled`, `pando.<agentEventType>` system-message
   * signals, and anything a future adapter adds under the `pando.*`
   * namespace (`internal/agui/translate.go:214-242`). Events are also kept
   * on {@link PandoThread.customEvents} even when this is omitted, so
   * nothing is silently dropped.
   */
  onCustom?: (event: PandoCustomEvent) => void;
}

/** Options shared by {@link PandoThread.send} and {@link PandoThread.resume}. */
export interface PandoThreadRunOptions {
  /** Frontend tools for this run, overriding the thread's default. */
  tools?: AguiTool[];
  /** Ambient context attached to this run. */
  context?: AguiContext[];
  /** Client-owned state echoed back as `PandoState.client`. */
  state?: unknown;
  /** Agent for this run, overriding the thread's default. */
  agent?: string;
  signal?: AbortSignal;
}

/** Where one tool call lives in the transcript, for O(1) updates as it streams in. */
interface ToolCallLocation {
  message: AguiMessage;
  call: AguiToolCall;
}

export class PandoThread {
  readonly threadId: string;

  /**
   * The transcript. AG-UI clients own the visible history and resend it in
   * full on every turn (`internal/agui/input.go:35-47`); this array is
   * exactly what {@link send} and {@link resume} send back.
   */
  readonly messages: AguiMessage[] = [];

  /**
   * Reasoning text, keyed by the assistant message id it belongs to. Never
   * merged into `AguiMessage.content` — a reasoning trace and the visible
   * reply are different channels on the wire
   * (`internal/agui/translate.go:164-176,282-291`) and stay different here.
   */
  readonly reasoning = new Map<string, string>();

  /** Every `CUSTOM` event seen so far, in arrival order. */
  readonly customEvents: PandoCustomEvent[] = [];

  /**
   * The shared-state document, seeded by `STATE_SNAPSHOT` and kept in sync by
   * `STATE_DELTA` (`internal/agui/state.go`). `undefined` until the first
   * run's snapshot arrives.
   */
  state: PandoState | undefined;

  /** `true` after a run ends with `RUN_FINISHED{outcome:"interrupt"}`. */
  isInterrupted = false;

  /**
   * The tool calls the agent is currently blocked on. Non-empty only while
   * {@link isInterrupted} is `true`. Answer one with the SDK's HITL helpers
   * (`./hitl.js`) and deliver it with {@link resume}.
   */
  pendingToolCalls: PendingToolCall[] = [];

  private readonly client: PandoAguiClient;
  private readonly defaultAgent: string | undefined;
  private readonly defaultTools: AguiTool[] | undefined;
  private readonly onCustom: ((event: PandoCustomEvent) => void) | undefined;

  private readonly toolCallIndex = new Map<string, ToolCallLocation>();
  private readonly pendingToolCallIds = new Set<string>();

  constructor(options: PandoThreadOptions) {
    this.client = options.client;
    this.threadId = options.threadId ?? randomId("thread");
    this.defaultAgent = options.agent;
    this.defaultTools = options.tools;
    this.onCustom = options.onCustom;
  }

  /**
   * Sends a new user message and streams the run, resending the accumulated
   * transcript. Reducing the event stream is a side effect of iterating (or
   * fully draining) the returned generator: {@link messages}, {@link state},
   * {@link isInterrupted} and {@link pendingToolCalls} are updated as events
   * arrive.
   */
  send(prompt: string, options: PandoThreadRunOptions = {}): AsyncGenerator<AguiEvent, void, undefined> {
    const message: AguiMessage = { id: randomId("msg"), role: "user", content: prompt };
    this.messages.push(message);
    return this.runAndReduce(options);
  }

  /**
   * Answers an interrupted run's tool call and resumes it.
   *
   * `result` is the tool-result payload as a string — typically the output
   * of one of the HITL helpers in `./hitl.js`, or arbitrary text for a
   * frontend tool. It is appended as a `tool` message after the last user
   * message, which is exactly the shape
   * `internal/agui/input.go:216-231` (`TrailingToolMessages`) requires for
   * `deliverToolResults`/`resumeRun` (`internal/agui/server.go:356-399`) to
   * re-attach the suspended run instead of starting a new one.
   */
  resume(
    toolCallId: string,
    result: string,
    options: PandoThreadRunOptions = {},
  ): AsyncGenerator<AguiEvent, void, undefined> {
    const message: AguiMessage = {
      id: randomId("msg"),
      role: "tool",
      toolCallId,
      content: result,
    };
    this.messages.push(message);
    // The adapter never echoes a suppressed call's result back to the client
    // that just supplied it (`translator.suppressToolCall`), so the pending
    // set is updated here rather than waiting for a TOOL_CALL_RESULT event.
    this.pendingToolCallIds.delete(toolCallId);
    this.recomputePendingToolCalls();
    return this.runAndReduce(options);
  }

  private async *runAndReduce(
    options: PandoThreadRunOptions,
  ): AsyncGenerator<AguiEvent, void, undefined> {
    const runOptions: AguiRunOptions = {
      threadId: this.threadId,
      runId: randomId("run"),
      messages: this.messages,
    };
    const agent = options.agent ?? this.defaultAgent;
    if (agent) runOptions.agent = agent;
    const tools = options.tools ?? this.defaultTools;
    if (tools?.length) runOptions.tools = tools;
    if (options.context?.length) runOptions.context = options.context;
    if (options.state !== undefined) runOptions.state = options.state;
    if (options.signal) runOptions.signal = options.signal;

    for await (const event of this.client.run(runOptions)) {
      this.reduce(event);
      yield event;
    }
  }

  /** Folds one AG-UI event into the transcript and state document. */
  private reduce(event: AguiEvent): void {
    switch (event.type) {
      case "TEXT_MESSAGE_START":
        this.assistantMessage(event.messageId);
        break;

      case "TEXT_MESSAGE_CONTENT": {
        const message = this.assistantMessage(event.messageId);
        // Streamed assistant text is always a plain string; `content` is a
        // union only because a *user* message may carry multimodal parts
        // (`AguiMessageContentPart[]`), which never reaches this branch.
        const prior = typeof message.content === "string" ? message.content : "";
        message.content = prior + event.delta;
        break;
      }

      case "REASONING_MESSAGE_CONTENT": {
        const prior = this.reasoning.get(event.messageId) ?? "";
        this.reasoning.set(event.messageId, prior + event.delta);
        break;
      }

      case "TOOL_CALL_START":
        this.startToolCall(event.toolCallId, event.toolCallName, event.parentMessageId);
        break;

      case "TOOL_CALL_ARGS": {
        const location = this.toolCallIndex.get(event.toolCallId);
        if (location) location.call.function.arguments += event.delta;
        break;
      }

      case "TOOL_CALL_END":
        if (this.toolCallIndex.has(event.toolCallId)) {
          this.pendingToolCallIds.add(event.toolCallId);
          this.recomputePendingToolCalls();
        }
        break;

      case "TOOL_CALL_RESULT": {
        const role = (event.role as AguiRole | undefined) ?? "tool";
        const message: AguiMessage = {
          id: event.messageId,
          role,
          toolCallId: event.toolCallId,
          content: event.content,
        };
        this.messages.push(message);
        this.pendingToolCallIds.delete(event.toolCallId);
        this.recomputePendingToolCalls();
        break;
      }

      case "STATE_SNAPSHOT":
        this.state = clone(event.snapshot);
        break;

      case "STATE_DELTA":
        this.applyStateDelta(event.delta);
        break;

      case "CUSTOM":
        this.customEvents.push(event);
        this.onCustom?.(event);
        break;

      case "RUN_FINISHED":
        this.isInterrupted = event.outcome === "interrupt";
        this.recomputePendingToolCalls();
        break;

      default:
        break;
    }
  }

  /** Finds (or opens) the transcript message a run's text/tool-call events belong to. */
  private assistantMessage(messageId: string): AguiMessage {
    const existing = this.messages.find((m) => m.id === messageId);
    if (existing) return existing;
    const message: AguiMessage = { id: messageId, role: "assistant" };
    this.messages.push(message);
    return message;
  }

  private startToolCall(toolCallId: string, name: string, parentMessageId: string | undefined): void {
    if (this.toolCallIndex.has(toolCallId)) return; // Duplicate START; ignore.
    // A permission prompt's synthetic events carry no parent message
    // (`NewToolCallStart(callID, permissionToolName, "")` in
    // `internal/agui/hitl.go:78`): it is not attached to any assistant text.
    // Give it a dedicated transcript message keyed by the call itself.
    const ownerId = parentMessageId ? parentMessageId : `toolcall-${toolCallId}`;
    const message = this.assistantMessage(ownerId);
    const call: AguiToolCall = { id: toolCallId, type: "function", function: { name, arguments: "" } };
    if (!message.toolCalls) message.toolCalls = [];
    message.toolCalls.push(call);
    this.toolCallIndex.set(toolCallId, { message, call });
  }

  private recomputePendingToolCalls(): void {
    const pending: PendingToolCall[] = [];
    for (const id of this.pendingToolCallIds) {
      const location = this.toolCallIndex.get(id);
      if (!location) continue;
      pending.push({
        id,
        name: location.call.function.name,
        argsText: location.call.function.arguments,
        args: safeJsonParse(location.call.function.arguments),
      });
    }
    this.pendingToolCalls = pending;
  }

  private applyStateDelta(ops: JsonPatchOperation[]): void {
    if (this.state === undefined) {
      throw new PandoError("agui: STATE_DELTA received before STATE_SNAPSHOT");
    }
    this.state = applyJsonPatch(this.state, ops);
  }
}

// ---------------------------------------------------------------------------
// RFC 6902 (hand-rolled)
// ---------------------------------------------------------------------------

/**
 * Applies a sequence of RFC-6902 operations to `document`, hand-rolled to
 * cover exactly the shapes `internal/agui/state.go` emits: `add`, `replace`
 * and `remove`, including the `/files/-` append form used for new file
 * entries (`state.go:328-336`). `move`, `copy` and `test` are not
 * implemented — Pando never emits them — and are rejected loudly rather than
 * silently ignored. No runtime dependency (e.g. `fast-json-patch`) is used.
 */
export function applyJsonPatch<T>(document: T, ops: readonly JsonPatchOperation[]): T {
  let root: unknown = document;
  for (const op of ops) {
    root = applyOne(root, op);
  }
  return root as T;
}

function applyOne(root: unknown, op: JsonPatchOperation): unknown {
  const tokens = parsePointer(op.path);

  if (tokens.length === 0) {
    switch (op.op) {
      case "add":
      case "replace":
        return op.value;
      case "remove":
        return undefined;
      default:
        throw unsupportedOp(op);
    }
  }

  const parent = navigate(root, tokens.slice(0, -1), op);
  const key = tokens[tokens.length - 1] as string;

  if (Array.isArray(parent)) {
    const index = key === "-" ? parent.length : requireArrayIndex(key, op);
    switch (op.op) {
      case "add":
        parent.splice(index, 0, op.value);
        return root;
      case "replace":
        if (index < 0 || index >= parent.length) {
          throw new PandoError(`agui: STATE_DELTA replace out of bounds at "${op.path}"`);
        }
        parent[index] = op.value;
        return root;
      case "remove":
        if (index < 0 || index >= parent.length) {
          throw new PandoError(`agui: STATE_DELTA remove out of bounds at "${op.path}"`);
        }
        parent.splice(index, 1);
        return root;
      default:
        throw unsupportedOp(op);
    }
  }

  if (isRecord(parent)) {
    switch (op.op) {
      case "add":
      case "replace":
        parent[key] = op.value;
        return root;
      case "remove":
        delete parent[key];
        return root;
      default:
        throw unsupportedOp(op);
    }
  }

  throw new PandoError(`agui: STATE_DELTA path "${op.path}" does not resolve to a container`);
}

function navigate(root: unknown, tokens: string[], op: JsonPatchOperation): unknown {
  let current: unknown = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      current = current[requireArrayIndex(token, op)];
    } else if (isRecord(current)) {
      current = current[token];
    } else {
      throw new PandoError(`agui: STATE_DELTA path "${op.path}" does not resolve to a container`);
    }
  }
  return current;
}

function requireArrayIndex(token: string, op: JsonPatchOperation): number {
  if (!/^(0|[1-9]\d*)$/.test(token)) {
    throw new PandoError(`agui: STATE_DELTA invalid array index in "${op.path}"`);
  }
  return Number(token);
}

/** Splits and unescapes an RFC-6901 JSON pointer (`~1` -> `/`, `~0` -> `~`). */
function parsePointer(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) {
    throw new PandoError(`agui: STATE_DELTA path must start with "/": "${path}"`);
  }
  return path
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsupportedOp(op: JsonPatchOperation): PandoError {
  return new PandoError(
    `agui: unsupported STATE_DELTA op "${op.op}" — only add/replace/remove are implemented`,
  );
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function safeJsonParse(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
