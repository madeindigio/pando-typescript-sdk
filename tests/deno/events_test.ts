/**
 * Deno-native tests for events.ts
 *
 * Run with: deno test --allow-read --allow-env tests/deno/events_test.ts
 */
import {
  assertEquals,
  assertExists,
  assertStrictEquals,
  assertIsError,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// Import directly from TypeScript source (Deno supports .ts natively)
import { parseAgentEvent, isTerminalEvent, collectResponse } from "../../src/events.ts";
import type { AgentEventParams } from "../../src/types.ts";

// ---------------------------------------------------------------------------
// parseAgentEvent
// ---------------------------------------------------------------------------

Deno.test("parseAgentEvent - content_delta", () => {
  const params: AgentEventParams = {
    type: "content_delta",
    sessionId: "sess-1",
    delta: "Hello, world!",
  };
  const event = parseAgentEvent(params);
  assertExists(event);
  assertEquals(event.type, "content_delta");
  assertEquals(event.sessionId, "sess-1");
  if (event.type === "content_delta") {
    assertEquals(event.delta, "Hello, world!");
  }
});

Deno.test("parseAgentEvent - thinking_delta", () => {
  const params: AgentEventParams = {
    type: "thinking_delta",
    sessionId: "sess-2",
    delta: "Thinking...",
  };
  const event = parseAgentEvent(params);
  assertExists(event);
  assertEquals(event.type, "thinking_delta");
  if (event.type === "thinking_delta") {
    assertEquals(event.delta, "Thinking...");
  }
});

Deno.test("parseAgentEvent - tool_call", () => {
  const params: AgentEventParams = {
    type: "tool_call",
    sessionId: "sess-3",
    toolCall: { id: "tc-1", name: "bash", input: { command: "ls" } },
  };
  const event = parseAgentEvent(params);
  assertExists(event);
  assertEquals(event.type, "tool_call");
  if (event.type === "tool_call") {
    assertEquals(event.toolCall.name, "bash");
    assertEquals(event.toolCall.id, "tc-1");
  }
});

Deno.test("parseAgentEvent - tool_result", () => {
  const params: AgentEventParams = {
    type: "tool_result",
    sessionId: "sess-4",
    toolResult: { toolCallId: "tc-1", name: "bash", content: "file.go\n" },
  };
  const event = parseAgentEvent(params);
  assertExists(event);
  assertEquals(event.type, "tool_result");
  if (event.type === "tool_result") {
    assertEquals(event.toolResult.content, "file.go\n");
  }
});

Deno.test("parseAgentEvent - response", () => {
  const params: AgentEventParams = {
    type: "response",
    sessionId: "sess-5",
    message: { role: "assistant", content: "Done!" },
  };
  const event = parseAgentEvent(params);
  assertExists(event);
  assertEquals(event.type, "response");
  if (event.type === "response") {
    assertEquals(event.message.content, "Done!");
  }
});

Deno.test("parseAgentEvent - error", () => {
  const params: AgentEventParams = {
    type: "error",
    sessionId: "sess-6",
    error: "Something went wrong",
  };
  const event = parseAgentEvent(params);
  assertExists(event);
  assertEquals(event.type, "error");
  if (event.type === "error") {
    assertEquals(event.error, "Something went wrong");
  }
});

Deno.test("parseAgentEvent - summarize", () => {
  const params: AgentEventParams = {
    type: "summarize",
    sessionId: "sess-7",
  };
  const event = parseAgentEvent(params);
  assertExists(event);
  assertEquals(event.type, "summarize");
});

Deno.test("parseAgentEvent - unknown type returns null", () => {
  const params = { type: "unknown_event", sessionId: "sess-8" } as AgentEventParams;
  const event = parseAgentEvent(params);
  assertEquals(event, null);
});

Deno.test("parseAgentEvent - missing sessionId returns null", () => {
  const params = { type: "content_delta", delta: "hi" } as AgentEventParams;
  const event = parseAgentEvent(params);
  assertEquals(event, null);
});

// ---------------------------------------------------------------------------
// isTerminalEvent
// ---------------------------------------------------------------------------

Deno.test("isTerminalEvent - response is terminal", () => {
  const event = parseAgentEvent({ type: "response", sessionId: "s", message: { role: "assistant", content: "" } });
  assertExists(event);
  assertEquals(isTerminalEvent(event), true);
});

Deno.test("isTerminalEvent - error is terminal", () => {
  const event = parseAgentEvent({ type: "error", sessionId: "s", error: "err" });
  assertExists(event);
  assertEquals(isTerminalEvent(event), true);
});

Deno.test("isTerminalEvent - content_delta is not terminal", () => {
  const event = parseAgentEvent({ type: "content_delta", sessionId: "s", delta: "hi" });
  assertExists(event);
  assertEquals(isTerminalEvent(event), false);
});

Deno.test("isTerminalEvent - tool_call is not terminal", () => {
  const event = parseAgentEvent({ type: "tool_call", sessionId: "s", toolCall: { id: "", name: "bash", input: {} } });
  assertExists(event);
  assertEquals(isTerminalEvent(event), false);
});

// ---------------------------------------------------------------------------
// collectResponse
// ---------------------------------------------------------------------------

Deno.test("collectResponse - accumulates content_delta events", async () => {
  async function* gen() {
    yield parseAgentEvent({ type: "content_delta", sessionId: "s", delta: "Hello" })!;
    yield parseAgentEvent({ type: "content_delta", sessionId: "s", delta: ", " })!;
    yield parseAgentEvent({ type: "content_delta", sessionId: "s", delta: "world!" })!;
    yield parseAgentEvent({ type: "response", sessionId: "s", message: { role: "assistant", content: "" } })!;
  }
  const result = await collectResponse(gen());
  assertEquals(result, "Hello, world!");
});

Deno.test("collectResponse - stops at response event", async () => {
  async function* gen() {
    yield parseAgentEvent({ type: "content_delta", sessionId: "s", delta: "part1" })!;
    yield parseAgentEvent({ type: "response", sessionId: "s", message: { role: "assistant", content: "" } })!;
    yield parseAgentEvent({ type: "content_delta", sessionId: "s", delta: "ignored" })!;
  }
  const result = await collectResponse(gen());
  assertEquals(result, "part1");
});
