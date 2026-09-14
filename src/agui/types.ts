/**
 * AG-UI protocol types as implemented by Pando's `internal/agui` adapter.
 *
 * These mirror the Go structs one-to-one (camelCase JSON, SCREAMING_SNAKE event
 * types). They are declared here rather than imported from `@ag-ui/client` so
 * this subpath stays dependency-free: a consumer that only wants to stream
 * events should not have to install CopilotKit's client stack.
 */

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Every event type the adapter can emit, mirroring the `EventType` constants
 * declared in `internal/agui/events.go`. Each of these has a dedicated
 * interface below (see {@link KnownAguiEvent}).
 *
 * This union is intentionally closed rather than widened with a
 * `(string & {})` catch-all: adding one here breaks TypeScript's
 * discriminated-union narrowing across the *entire* {@link AguiEvent}
 * switch (every `case` loses its narrowing, not just the fallback branch —
 * verified against the TypeScript compiler, not merely suspected). Forward
 * compatibility with a newer server's event names is instead a runtime
 * property: {@link parseSSE} casts the decoded JSON to `AguiEvent` without a
 * structural check, and every reducer that switches on `event.type` (e.g.
 * `PandoThread`'s) ends in a `default` branch. {@link OtherAguiEvent} stays
 * exported as the documented escape hatch for that case; today its `type` is
 * `never` because every constant in `events.go` already has an interface —
 * the moment a newer Go adapter adds one this SDK does not know yet, the
 * drift check (`scripts/check-agui-drift.mjs`) catches it before a release.
 */
export type AguiEventType =
  | "RUN_STARTED"
  | "RUN_FINISHED"
  | "RUN_ERROR"
  | "STEP_STARTED"
  | "STEP_FINISHED"
  | "TEXT_MESSAGE_START"
  | "TEXT_MESSAGE_CONTENT"
  | "TEXT_MESSAGE_END"
  | "TEXT_MESSAGE_CHUNK"
  | "TOOL_CALL_START"
  | "TOOL_CALL_ARGS"
  | "TOOL_CALL_END"
  | "TOOL_CALL_RESULT"
  | "STATE_SNAPSHOT"
  | "STATE_DELTA"
  | "MESSAGES_SNAPSHOT"
  | "REASONING_START"
  | "REASONING_MESSAGE_START"
  | "REASONING_MESSAGE_CONTENT"
  | "REASONING_MESSAGE_END"
  | "REASONING_END"
  | "ACTIVITY_SNAPSHOT"
  | "ACTIVITY_DELTA"
  | "CUSTOM"
  | "RAW";

/** Fields shared by every event. */
export interface AguiBaseEvent {
  type: AguiEventType;
  timestamp?: number;
  rawEvent?: unknown;
}

/**
 * How a run ended.
 *
 * `interrupt` means the agent called a frontend tool: the run is suspended, and
 * the next request on the thread must carry the tool result to resume it.
 */
export type RunOutcome = "success" | "interrupt";

export interface RunStartedEvent extends AguiBaseEvent {
  type: "RUN_STARTED";
  threadId: string;
  runId: string;
  parentRunId?: string;
}

export interface RunFinishedEvent extends AguiBaseEvent {
  type: "RUN_FINISHED";
  threadId: string;
  runId: string;
  outcome?: RunOutcome;
  result?: unknown;
}

export interface RunErrorEvent extends AguiBaseEvent {
  type: "RUN_ERROR";
  message: string;
  code?: string;
}

/** Marks the start of a named step within a run (`NewStepStarted`, `events.go`). */
export interface StepStartedEvent extends AguiBaseEvent {
  type: "STEP_STARTED";
  stepName: string;
}

/** Marks the end of a named step within a run (`NewStepFinished`, `events.go`). */
export interface StepFinishedEvent extends AguiBaseEvent {
  type: "STEP_FINISHED";
  stepName: string;
}

export interface TextMessageStartEvent extends AguiBaseEvent {
  type: "TEXT_MESSAGE_START";
  messageId: string;
  role: string;
}

export interface TextMessageContentEvent extends AguiBaseEvent {
  type: "TEXT_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
}

export interface TextMessageEndEvent extends AguiBaseEvent {
  type: "TEXT_MESSAGE_END";
  messageId: string;
}

/**
 * A single-frame text message: a complete message delivered in one event
 * instead of the START / CONTENT / END sequence. Declared as `EventTextMessageChunk`
 * in `internal/agui/events.go` but not yet emitted by any constructor there —
 * no Pando call site produces it today. Fields mirror the wider AG-UI
 * protocol's chunk shape (all optional, since a chunk may carry only a
 * partial update); typed here so a client does not fall back to
 * {@link OtherAguiEvent} the day the adapter starts sending it.
 */
export interface TextMessageChunkEvent extends AguiBaseEvent {
  type: "TEXT_MESSAGE_CHUNK";
  messageId?: string;
  role?: string;
  delta?: string;
}

export interface ToolCallStartEvent extends AguiBaseEvent {
  type: "TOOL_CALL_START";
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
}

export interface ToolCallArgsEvent extends AguiBaseEvent {
  type: "TOOL_CALL_ARGS";
  toolCallId: string;
  delta: string;
}

export interface ToolCallEndEvent extends AguiBaseEvent {
  type: "TOOL_CALL_END";
  toolCallId: string;
}

export interface ToolCallResultEvent extends AguiBaseEvent {
  type: "TOOL_CALL_RESULT";
  messageId: string;
  toolCallId: string;
  content: string;
  role?: string;
}

/** A single RFC-6902 operation, as carried by `STATE_DELTA`. */
export interface JsonPatchOperation {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  value?: unknown;
  from?: string;
}

export interface StateSnapshotEvent extends AguiBaseEvent {
  type: "STATE_SNAPSHOT";
  snapshot: PandoState;
}

export interface StateDeltaEvent extends AguiBaseEvent {
  type: "STATE_DELTA";
  delta: JsonPatchOperation[];
}

/** A full replacement of the visible transcript (`NewMessagesSnapshot`, `events.go`). */
export interface MessagesSnapshotEvent extends AguiBaseEvent {
  type: "MESSAGES_SNAPSHOT";
  messages: AguiMessage[];
}

export interface ReasoningStartEvent extends AguiBaseEvent {
  type: "REASONING_START";
  messageId: string;
}

export interface ReasoningMessageStartEvent extends AguiBaseEvent {
  type: "REASONING_MESSAGE_START";
  messageId: string;
  role: string;
}

export interface ReasoningMessageContentEvent extends AguiBaseEvent {
  type: "REASONING_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
}

export interface ReasoningMessageEndEvent extends AguiBaseEvent {
  type: "REASONING_MESSAGE_END";
  messageId: string;
}

export interface ReasoningEndEvent extends AguiBaseEvent {
  type: "REASONING_END";
  messageId: string;
}

/**
 * A full replacement of one activity block's content (`NewActivitySnapshot`,
 * `events.go`). `content` is arbitrary JSON — the adapter never interprets
 * it, only forwards it.
 */
export interface ActivitySnapshotEvent extends AguiBaseEvent {
  type: "ACTIVITY_SNAPSHOT";
  messageId: string;
  activityType: string;
  content: unknown;
  replace?: boolean;
}

/**
 * An incremental patch to an activity block's content. Declared as
 * `EventActivityDelta` in `internal/agui/events.go` but, like
 * {@link TextMessageChunkEvent}, has no constructor or call site there yet.
 * `delta` is typed as RFC-6902 operations for consistency with
 * {@link StateDeltaEvent} — the adapter's only other delta-shaped event —
 * since no emitted payload exists to confirm the exact shape.
 */
export interface ActivityDeltaEvent extends AguiBaseEvent {
  type: "ACTIVITY_DELTA";
  messageId: string;
  activityType: string;
  delta: JsonPatchOperation[];
}

/**
 * An escape hatch carrying a foreign event verbatim (`NewRaw`, `events.go`),
 * e.g. a provider-native event Pando does not translate.
 */
export interface RawEvent extends AguiBaseEvent {
  type: "RAW";
  event: unknown;
  source?: string;
}

// ---------------------------------------------------------------------------
// CUSTOM — Pando's `pando.*` namespaced signals
// ---------------------------------------------------------------------------

/** Payload of `pando.frontendToolsDisabled` (`internal/agui/server.go:322`). */
export interface PandoFrontendToolsDisabledPayload {
  count: number;
  reason: string;
}

/** Payload of `pando.summarize` (`internal/agui/translate.go:228`). */
export interface PandoSummarizePayload {
  progress: string;
  done: boolean;
}

/**
 * The `pando.*` `CUSTOM` event names the adapter currently emits, plus an
 * open fallback for anything a future adapter version adds under the same
 * namespace (`internal/agui/translate.go:214-242`, `server.go:322`) or a
 * third-party `CUSTOM` name a generic AG-UI client is expected to tolerate.
 */
export type PandoCustomEventName =
  | "pando.frontendToolsDisabled"
  | "pando.todos"
  | "pando.tokenUsage"
  | "pando.summarize"
  | "pando.system_message"
  | "pando.steering_queued"
  | "pando.steering_injected"
  | "pando.conclusion_queued"
  | "pando.conclusion_injected"
  | "pando.resurrected"
  | (string & {});

/** Sent when the client declared tools but frontend-tool proxying is off. */
export interface CustomEventFrontendToolsDisabled extends AguiBaseEvent {
  type: "CUSTOM";
  name: "pando.frontendToolsDisabled";
  value: PandoFrontendToolsDisabledPayload;
}

/**
 * Todo-list update, sent instead of a `STATE_DELTA` when the translator has
 * no shared-state tracker attached (`translate.go:214-219`).
 */
export interface CustomEventTodos extends AguiBaseEvent {
  type: "CUSTOM";
  name: "pando.todos";
  value: PandoTodo[];
}

/**
 * Token-usage update, sent instead of a `STATE_DELTA` when the translator has
 * no shared-state tracker attached (`translate.go:221-225`).
 */
export interface CustomEventTokenUsage extends AguiBaseEvent {
  type: "CUSTOM";
  name: "pando.tokenUsage";
  value: PandoTokenUsageState;
}

/** Context-compaction progress (`translate.go:228`). */
export interface CustomEventSummarize extends AguiBaseEvent {
  type: "CUSTOM";
  name: "pando.summarize";
  value: PandoSummarizePayload;
}

/**
 * `pando.<agentEventType>` human-readable status notices — context
 * compaction, steering, delegated-conclusion and resurrection signals
 * (`agent.AgentEventType` spellings emitted at `translate.go:233-242`). All
 * carry the same string payload shape (`ev.SystemMessage`).
 */
export interface CustomEventSystemNotice extends AguiBaseEvent {
  type: "CUSTOM";
  name:
    | "pando.system_message"
    | "pando.steering_queued"
    | "pando.steering_injected"
    | "pando.conclusion_queued"
    | "pando.conclusion_injected"
    | "pando.resurrected";
  value: string;
}

/**
 * Any other `CUSTOM` event: a future `pando.*` signal, or a third-party name
 * a generic AG-UI client is expected to tolerate. This is the open fallback
 * the union above keeps room for.
 */
export interface CustomEventOther extends AguiBaseEvent {
  type: "CUSTOM";
  name: string;
  value?: unknown;
}

/**
 * A `CUSTOM` event. Narrow on `name` (in addition to `type`) to get a typed
 * `value` for the signals Pando currently emits.
 */
export type CustomEvent =
  | CustomEventFrontendToolsDisabled
  | CustomEventTodos
  | CustomEventTokenUsage
  | CustomEventSummarize
  | CustomEventSystemNotice
  | CustomEventOther;

/** The events with a dedicated interface here. Narrow on `type` (and, for `CUSTOM`, `name`). */
export type KnownAguiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | StepStartedEvent
  | StepFinishedEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | TextMessageChunkEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | StateSnapshotEvent
  | StateDeltaEvent
  | MessagesSnapshotEvent
  | ReasoningStartEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | ReasoningEndEvent
  | ActivitySnapshotEvent
  | ActivityDeltaEvent
  | RawEvent
  | CustomEvent;

/**
 * Everything else the protocol may carry: only a name a newer adapter added
 * after this SDK version shipped should ever end up here, since every event
 * constant declared in `internal/agui/events.go` has a dedicated interface
 * above. The fields survive through the index signature instead of being
 * dropped, so an older client degrades gracefully instead of breaking.
 */
export interface OtherAguiEvent extends AguiBaseEvent {
  type: Exclude<AguiEventType, KnownAguiEvent["type"]>;
  [key: string]: unknown;
}

/** Any AG-UI event. */
export type AguiEvent = KnownAguiEvent | OtherAguiEvent;

// ---------------------------------------------------------------------------
// Request payload
// ---------------------------------------------------------------------------

export type AguiRole =
  | "developer"
  | "system"
  | "assistant"
  | "user"
  | "tool"
  | "activity"
  | "reasoning";

export interface AguiToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

/** Multimodal input content kinds accepted by the adapter (`internal/agui/input.go:22-28`). */
export type AguiContentKind = "text" | "image" | "audio" | "video" | "document" | (string & {});

/**
 * One part of a multimodal message, mirroring `InputContent`
 * (`internal/agui/input.go:63-71`). Only `text` parts are consumed by the
 * adapter today; the others are preserved so a future version can map them
 * onto an attachment.
 */
export interface AguiMessageContentPart {
  type: AguiContentKind;
  text?: string;
  /** URL of a non-text part. */
  url?: string;
  /** Inline (e.g. base64) data of a non-text part. */
  data?: string;
  mimeType?: string;
}

/**
 * One transcript message. AG-UI clients own the visible transcript and resend
 * it in full on every turn.
 *
 * `content` accepts either shape `MessageContent` decodes
 * (`internal/agui/input.go:76-102`): a plain string, or an array of
 * multimodal parts.
 */
export interface AguiMessage {
  id: string;
  role: AguiRole;
  content?: string | AguiMessageContentPart[];
  name?: string;
  toolCalls?: AguiToolCall[];
  toolCallId?: string;
  error?: string;
  /** Set on `role: "activity"` messages (`internal/agui/input.go:164`). */
  activityType?: string;
}

/** A tool the browser implements and the agent may call. */
export interface AguiTool {
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments. */
  parameters?: unknown;
}

/** Ambient context the page attaches to the run. */
export interface AguiContext {
  description: string;
  value: string;
}

/** The request body of a run. */
export interface RunAgentInput {
  threadId: string;
  runId: string;
  parentRunId?: string;
  state?: unknown;
  messages?: AguiMessage[];
  tools?: AguiTool[];
  context?: AguiContext[];
  forwardedProps?: unknown;
}

// ---------------------------------------------------------------------------
// Shared state document
// ---------------------------------------------------------------------------

export interface PandoModelState {
  id: string;
  name?: string;
  provider?: string;
  contextWindow?: number;
}

export interface PandoTokenUsageState {
  promptTokens: number;
  completionTokens: number;
  contextWindow: number;
  estimated: boolean;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  cost?: number;
}

export interface PandoFileState {
  path: string;
  name: string;
  action: "read" | "write" | "edit" | "patch" | (string & {});
}

/**
 * One todo item, mirroring `tools.TodoItem`
 * (`internal/llm/tools/todo_write.go:13-17`) exactly: no `id` field, no
 * index signature — the adapter forwards `ev.Todos` untouched
 * (`internal/agui/state.go:243-254`), so this is the wire shape, not a
 * superset of it.
 */
export interface PandoTodo {
  content: string;
  /** `pending` | `in_progress` | `completed`. */
  status: "pending" | "in_progress" | "completed" | (string & {});
  /** `high` | `medium` | `low`. */
  priority: "high" | "medium" | "low" | (string & {});
}

/** One delegated mesnada task, as tracked by the adapter. */
export interface PandoSubAgentState {
  id: string;
  status: string;
  role?: "worker" | "verifier" | "synthesizer" | (string & {});
  prompt?: string;
  engine?: string;
  model?: string;
  persona?: string;
  error?: string;
  exitCode?: number;
  /** The task's self-reported outcome: success | partial | failed | blocked. */
  conclusion?: string;
  summary?: string;
}

/**
 * The document published by `STATE_SNAPSHOT` and patched by `STATE_DELTA`.
 * This is what `useCoAgent<PandoState>()` renders.
 */
export interface PandoState {
  thread: string;
  session: string;
  agent: string;
  model: PandoModelState;
  todos: PandoTodo[];
  tokenUsage: PandoTokenUsageState | null;
  files: PandoFileState[];
  subAgents: PandoSubAgentState[];
  /** Echo of the state the page pushed into the run. */
  client?: unknown;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface AguiCapabilities {
  frontendTools: boolean;
  humanInTheLoop: boolean;
  sharedState: boolean;
  interrupts: boolean;
}

export interface AguiAgentDescriptor {
  name: string;
  description?: string;
  /** Absolute run endpoint for this agent. */
  url: string;
  model?: PandoModelState;
}

/** The `GET {path}/info` payload. */
export interface AguiInfo {
  protocol: string;
  version?: string;
  path: string;
  agents: AguiAgentDescriptor[];
  capabilities: AguiCapabilities;
}
