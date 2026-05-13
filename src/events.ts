/**
 * Agent event types and parser utilities.
 *
 * This module converts raw JSON-RPC notification params received over the ACP
 * stdio transport into strongly-typed {@link AgentEvent} values.
 */

import type {
  AgentEvent,
  AgentEventParams,
  ToolCall,
  ToolResult,
  Message,
} from "./types.js";

/**
 * Parse raw ACP `agent/event` notification params into a typed {@link AgentEvent}.
 *
 * Returns `null` when the event type is unknown or the params are malformed,
 * allowing callers to silently skip unsupported event types.
 *
 * @param params - Raw params object from the `agent/event` JSON-RPC notification.
 */
export function parseAgentEvent(params: AgentEventParams): AgentEvent | null {
  const { type, sessionId } = params;

  if (!sessionId) {
    return null;
  }

  switch (type) {
    case "content_delta": {
      const delta = params.delta ?? "";
      return { type: "content_delta", sessionId, delta };
    }

    case "thinking_delta": {
      const delta = params.delta ?? "";
      return { type: "thinking_delta", sessionId, delta };
    }

    case "tool_call": {
      if (!params.toolCall) {
        return null;
      }
      const toolCall: ToolCall = {
        id: params.toolCall.id ?? "",
        name: params.toolCall.name,
        input: params.toolCall.input ?? {},
      };
      return { type: "tool_call", sessionId, toolCall };
    }

    case "tool_result": {
      if (!params.toolResult) {
        return null;
      }
      const toolResult: ToolResult = {
        toolCallId: params.toolResult.toolCallId ?? "",
        name: params.toolResult.name ?? "",
        content: params.toolResult.content,
        isError: params.toolResult.isError ?? false,
      };
      return { type: "tool_result", sessionId, toolResult };
    }

    case "response": {
      const rawMessage = params.message;
      const message: Message = {
        role: rawMessage?.role === "user" ? "user" : "assistant",
        content: rawMessage?.content ?? "",
      };
      return { type: "response", sessionId, message };
    }

    case "error": {
      return { type: "error", sessionId, error: params.error ?? "unknown error" };
    }

    case "summarize": {
      return { type: "summarize", sessionId };
    }

    default:
      return null;
  }
}

/**
 * Returns `true` when the event signals the end of an agent turn.
 *
 * Used by the transport to decide when to stop yielding events for a session.
 */
export function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === "response" || event.type === "error";
}

/**
 * Collect the full text response from a sequence of {@link AgentEvent} values.
 *
 * Concatenates all `content_delta` deltas. If a `response` event is present its
 * `message.content` is preferred over the accumulated deltas.
 */
export function collectResponse(events: AgentEvent[]): string {
  let accumulated = "";
  let finalContent: string | undefined;

  for (const event of events) {
    if (event.type === "content_delta") {
      accumulated += event.delta;
    } else if (event.type === "response") {
      finalContent = event.message.content;
    }
  }

  return finalContent ?? accumulated;
}
