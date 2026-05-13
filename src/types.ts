/**
 * Shared types and interfaces for the Pando SDK.
 */

// ---------------------------------------------------------------------------
// Agent event types
// ---------------------------------------------------------------------------

/** A tool call emitted by the agent. */
export interface ToolCall {
  /** Unique identifier for this tool call. */
  id: string;
  /** Name of the tool being invoked. */
  name: string;
  /** Raw JSON input provided to the tool. */
  input: Record<string, unknown>;
}

/** A tool execution result. */
export interface ToolResult {
  /** ID of the tool call this result belongs to. */
  toolCallId: string;
  /** Name of the tool. */
  name: string;
  /** Output content from the tool. */
  content: string;
  /** Whether the tool returned an error. */
  isError: boolean;
}

/** A chat message produced by the assistant. */
export interface Message {
  /** Role of the message author. Always "assistant" for agent responses. */
  role: "assistant" | "user";
  /** Text content of the message. */
  content: string;
}

/**
 * Union of all event types emitted by a Pando agent session.
 *
 * Use the `type` discriminant to narrow to a specific variant.
 */
export type AgentEvent =
  | ContentDeltaEvent
  | ThinkingDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | ResponseEvent
  | ErrorEvent
  | SummarizeEvent;

/** Streamed text content chunk from the model. */
export interface ContentDeltaEvent {
  type: "content_delta";
  sessionId: string;
  delta: string;
}

/** Streamed reasoning/thinking content from the model (extended thinking mode). */
export interface ThinkingDeltaEvent {
  type: "thinking_delta";
  sessionId: string;
  delta: string;
}

/** A tool the agent is about to invoke. */
export interface ToolCallEvent {
  type: "tool_call";
  sessionId: string;
  toolCall: ToolCall;
}

/** The result of a completed tool call. */
export interface ToolResultEvent {
  type: "tool_result";
  sessionId: string;
  toolResult: ToolResult;
}

/** Final response from the agent when the turn is complete. */
export interface ResponseEvent {
  type: "response";
  sessionId: string;
  message: Message;
}

/** An error occurred during the agent turn. */
export interface ErrorEvent {
  type: "error";
  sessionId: string;
  error: string;
}

/** The session context was summarised (context window management). */
export interface SummarizeEvent {
  type: "summarize";
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Permission / approval types
// ---------------------------------------------------------------------------

/**
 * A permission request raised when the agent wants to use a tool that requires
 * explicit user approval.
 */
export interface PermissionRequest {
  /** ACP session ID this request belongs to. */
  sessionId: string;
  /** Name of the tool requesting permission. */
  toolName: string;
  /** Human-readable description of what the tool will do. */
  description: string;
  /** Action description (e.g. "write file"). */
  action: string;
  /** File path or resource affected. */
  path: string;
  /** Raw parameters the tool will receive. */
  params: Record<string, unknown>;
}

/**
 * Callback invoked when the agent requests tool permission.
 * Return `true` to approve, `false` to deny.
 */
export type PermissionCallback = (request: PermissionRequest) => boolean | Promise<boolean>;

// ---------------------------------------------------------------------------
// Session / connection types
// ---------------------------------------------------------------------------

/** A historical session entry returned by `session/list`. */
export interface SessionInfo {
  sessionId: string;
  title?: string | undefined;
  updatedAt?: string | undefined;
  cwd?: string | undefined;
}

/** A model available for selection. */
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  description?: string | undefined;
  badges?: string[] | undefined;
  canReason?: boolean | undefined;
}

/** A persona available for selection. */
export interface PersonaInfo {
  name: string;
}

// ---------------------------------------------------------------------------
// Run result types (subprocess / PandoClient)
// ---------------------------------------------------------------------------

/** Result of a single non-interactive pando run. */
export interface RunResult {
  /** The text response from the agent. */
  response: string;
  /** The session ID used for this run (may be empty for one-shot runs). */
  sessionId: string;
  /** The raw object parsed from JSON output (when using `-f json`). */
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// HTTP session types
// ---------------------------------------------------------------------------

/** A session as returned by the HTTP REST API. */
export interface HttpSession {
  id: string;
  title: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  isRunning?: boolean | undefined;
}

/** An SSE chunk from the HTTP streaming endpoint. */
export interface HttpStreamChunk {
  /** SSE event type (e.g. "content_delta", "tool_call", "done"). */
  event: string;
  /** Raw payload data. */
  data: Record<string, unknown>;
  /** Convenience accessor: text delta for `content_delta` events. */
  delta?: string | undefined;
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 wire types
// ---------------------------------------------------------------------------

/** A JSON-RPC 2.0 request object. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

/** A JSON-RPC 2.0 response object (success). */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
}

/** A JSON-RPC 2.0 error response. */
export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** A JSON-RPC 2.0 notification (no id). */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** Any incoming JSON-RPC message. */
export type JsonRpcMessage =
  | JsonRpcResponse
  | JsonRpcErrorResponse
  | JsonRpcNotification;

// ---------------------------------------------------------------------------
// ACP protocol types
// ---------------------------------------------------------------------------

/** Params for an `agent/event` ACP notification. */
export interface AgentEventParams {
  type: string;
  sessionId: string;
  delta?: string | undefined;
  toolCall?: {
    id?: string | undefined;
    name: string;
    input?: Record<string, unknown> | undefined;
  } | undefined;
  toolResult?: {
    toolCallId?: string | undefined;
    name?: string | undefined;
    content: string;
    isError?: boolean | undefined;
  } | undefined;
  message?: {
    role: string;
    content: string;
  } | undefined;
  error?: string | undefined;
}
