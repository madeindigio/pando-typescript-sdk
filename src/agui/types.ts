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

/** Every event type the adapter can emit. */
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

export interface ReasoningMessageContentEvent extends AguiBaseEvent {
  type: "REASONING_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
}

export interface CustomEvent extends AguiBaseEvent {
  type: "CUSTOM";
  name: string;
  value?: unknown;
}

/** The events with a dedicated interface here. Narrow on `type`. */
export type KnownAguiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | StateSnapshotEvent
  | StateDeltaEvent
  | ReasoningMessageContentEvent
  | CustomEvent;

/**
 * Everything else the protocol may carry (activity, raw, chunked variants, and
 * anything a newer adapter adds). The fields survive through the index
 * signature instead of being dropped.
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

/**
 * One transcript message. AG-UI clients own the visible transcript and resend
 * it in full on every turn.
 */
export interface AguiMessage {
  id: string;
  role: AguiRole;
  content?: string;
  name?: string;
  toolCalls?: AguiToolCall[];
  toolCallId?: string;
  error?: string;
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

export interface PandoTodo {
  id?: string;
  content?: string;
  status?: string;
  priority?: string;
  [key: string]: unknown;
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
