/**
 * Bun-native tests for events.ts
 *
 * Run with: bun test tests/bun/events.test.ts
 */
import { describe, it, expect } from "bun:test";
import { parseAgentEvent, isTerminalEvent, collectResponse } from "../../src/events.ts";
import type { AgentEvent, AgentEventParams } from "../../src/types.ts";

describe("parseAgentEvent", () => {
  it("parses content_delta events", () => {
    const params: AgentEventParams = {
      type: "content_delta",
      sessionId: "sess-1",
      delta: "Hello, world!",
    };
    const event = parseAgentEvent(params);
    expect(event).toEqual({
      type: "content_delta",
      sessionId: "sess-1",
      delta: "Hello, world!",
    });
  });

  it("parses thinking_delta events", () => {
    const params: AgentEventParams = {
      type: "thinking_delta",
      sessionId: "sess-1",
      delta: "I am thinking...",
    };
    const event = parseAgentEvent(params);
    expect(event).toEqual({
      type: "thinking_delta",
      sessionId: "sess-1",
      delta: "I am thinking...",
    });
  });

  it("parses tool_call events", () => {
    const params: AgentEventParams = {
      type: "tool_call",
      sessionId: "sess-2",
      toolCall: {
        id: "tc-001",
        name: "bash",
        input: { command: "ls -la" },
      },
    };
    const event = parseAgentEvent(params);
    expect(event).toEqual({
      type: "tool_call",
      sessionId: "sess-2",
      toolCall: {
        id: "tc-001",
        name: "bash",
        input: { command: "ls -la" },
      },
    });
  });

  it("returns null for tool_call without toolCall field", () => {
    const params: AgentEventParams = {
      type: "tool_call",
      sessionId: "sess-2",
    };
    const event = parseAgentEvent(params);
    expect(event).toBeNull();
  });

  it("parses tool_result events", () => {
    const params: AgentEventParams = {
      type: "tool_result",
      sessionId: "sess-3",
      toolResult: {
        toolCallId: "tc-001",
        name: "bash",
        content: "file1.txt\nfile2.txt",
        isError: false,
      },
    };
    const event = parseAgentEvent(params);
    expect(event).toEqual({
      type: "tool_result",
      sessionId: "sess-3",
      toolResult: {
        toolCallId: "tc-001",
        name: "bash",
        content: "file1.txt\nfile2.txt",
        isError: false,
      },
    });
  });

  it("returns null for tool_result without toolResult field", () => {
    const params: AgentEventParams = {
      type: "tool_result",
      sessionId: "sess-3",
    };
    const event = parseAgentEvent(params);
    expect(event).toBeNull();
  });

  it("parses response events", () => {
    const params: AgentEventParams = {
      type: "response",
      sessionId: "sess-4",
      message: { role: "assistant", content: "Done." },
    };
    const event = parseAgentEvent(params);
    expect(event).toEqual({
      type: "response",
      sessionId: "sess-4",
      message: { role: "assistant", content: "Done." },
    });
  });

  it("parses error events", () => {
    const params: AgentEventParams = {
      type: "error",
      sessionId: "sess-5",
      error: "context window exceeded",
    };
    const event = parseAgentEvent(params);
    expect(event).toEqual({
      type: "error",
      sessionId: "sess-5",
      error: "context window exceeded",
    });
  });

  it("parses error events with default message", () => {
    const params: AgentEventParams = {
      type: "error",
      sessionId: "sess-5",
    };
    const event = parseAgentEvent(params);
    expect(event).not.toBeNull();
    if (event?.type === "error") {
      expect(event.error).toBe("unknown error");
    }
  });

  it("parses summarize events", () => {
    const params: AgentEventParams = {
      type: "summarize",
      sessionId: "sess-6",
    };
    const event = parseAgentEvent(params);
    expect(event).toEqual({ type: "summarize", sessionId: "sess-6" });
  });

  it("returns null for unknown event types", () => {
    const params = {
      type: "unknown_type",
      sessionId: "sess-7",
    } as AgentEventParams;
    const event = parseAgentEvent(params);
    expect(event).toBeNull();
  });

  it("returns null when sessionId is missing", () => {
    const params = {
      type: "content_delta",
      sessionId: "",
      delta: "text",
    } as AgentEventParams;
    const event = parseAgentEvent(params);
    expect(event).toBeNull();
  });
});

describe("isTerminalEvent", () => {
  it("returns true for response events", () => {
    const event: AgentEvent = {
      type: "response",
      sessionId: "s",
      message: { role: "assistant", content: "done" },
    };
    expect(isTerminalEvent(event)).toBe(true);
  });

  it("returns true for error events", () => {
    const event: AgentEvent = {
      type: "error",
      sessionId: "s",
      error: "oops",
    };
    expect(isTerminalEvent(event)).toBe(true);
  });

  it("returns false for non-terminal events", () => {
    const nonTerminal: AgentEvent[] = [
      { type: "content_delta", sessionId: "s", delta: "hi" },
      { type: "thinking_delta", sessionId: "s", delta: "hmm" },
      { type: "tool_call", sessionId: "s", toolCall: { id: "1", name: "bash", input: {} } },
      { type: "tool_result", sessionId: "s", toolResult: { toolCallId: "1", name: "bash", content: "", isError: false } },
      { type: "summarize", sessionId: "s" },
    ];
    for (const event of nonTerminal) {
      expect(isTerminalEvent(event)).toBe(false);
    }
  });
});

describe("collectResponse", () => {
  it("collects content_delta events", () => {
    const events: AgentEvent[] = [
      { type: "content_delta", sessionId: "s", delta: "Hello, " },
      { type: "content_delta", sessionId: "s", delta: "world!" },
    ];
    expect(collectResponse(events)).toBe("Hello, world!");
  });

  it("prefers response event content over accumulated deltas", () => {
    const events: AgentEvent[] = [
      { type: "content_delta", sessionId: "s", delta: "partial" },
      {
        type: "response",
        sessionId: "s",
        message: { role: "assistant", content: "Full response text" },
      },
    ];
    expect(collectResponse(events)).toBe("Full response text");
  });

  it("returns empty string for no events", () => {
    expect(collectResponse([])).toBe("");
  });

  it("returns accumulated deltas when no response event", () => {
    const events: AgentEvent[] = [
      { type: "content_delta", sessionId: "s", delta: "chunk1" },
      { type: "thinking_delta", sessionId: "s", delta: "thinking" },
      { type: "content_delta", sessionId: "s", delta: "chunk2" },
    ];
    expect(collectResponse(events)).toBe("chunk1chunk2");
  });
});
