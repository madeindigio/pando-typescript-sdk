import { describe, expect, it, jest } from "@jest/globals";

import { PandoAguiClient } from "../src/agui/client.js";
import { PandoThread, applyJsonPatch } from "../src/agui/thread.js";
import type { AguiEvent } from "../src/agui/types.js";
import {
  BASIC_RUN_SSE,
  FILE_AFTER_BASIC_RUN,
  FILE_AFTER_RESUME,
  INTERRUPT_RUN_SSE,
  PERMISSION_ARGS,
  PERMISSION_CALL_ID,
  RESUME_RUN_SSE,
  sseResponse,
  THREAD_ID,
  TODOS_AFTER_BASIC_RUN,
  TOKEN_USAGE_AFTER_BASIC_RUN,
} from "./fixtures/agui-recorded-stream.js";

/**
 * PANDO-US-0007: `PandoThread` reduces the AG-UI event stream (recorded as
 * real SSE bytes in `./fixtures/agui-recorded-stream.ts`, not hand-built
 * event objects) into a transcript, a shared-state document and the
 * interrupt/resume handoff.
 */

async function drain(gen: AsyncGenerator<AguiEvent, void, undefined>): Promise<AguiEvent[]> {
  const out: AguiEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

/** Queues one recorded SSE stream per call to `fetch`, in order. */
function queueFetch(...streams: string[]): { fetch: typeof fetch; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  let next = 0;
  const impl = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    const text = streams[next++];
    if (text === undefined) throw new Error("queueFetch: no more recorded responses queued");
    return sseResponse(text);
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

describe("PandoThread", () => {
  it("send() accumulates a transcript, keeping reasoning out of the visible content", async () => {
    const { fetch: fetchImpl } = queueFetch(BASIC_RUN_SSE);
    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl, token: "tok" });
    const customEvents: AguiEvent[] = [];
    const thread = new PandoThread({
      client,
      threadId: THREAD_ID,
      onCustom: (event) => customEvents.push(event),
    });

    await drain(thread.send("hi"));

    expect(thread.messages[0]).toEqual({ id: expect.any(String), role: "user", content: "hi" });

    const assistant = thread.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("Hello there");
    expect(assistant?.toolCalls).toHaveLength(1);
    expect(assistant?.toolCalls?.[0]).toMatchObject({
      id: "call-1",
      function: { name: "view", arguments: '{"file_path":"README.md"}' },
    });

    // Reasoning is retrievable, but never merged into the assistant's content.
    expect(assistant?.content).not.toContain("Let me check");
    expect(assistant && thread.reasoning.get(assistant.id)).toBe("Let me check the docs.");

    const toolResult = thread.messages.find((m) => m.role === "tool");
    expect(toolResult).toMatchObject({
      toolCallId: "call-1",
      content: "# README\n\nOriginal contents.",
    });

    expect(thread.state?.todos).toEqual(TODOS_AFTER_BASIC_RUN);
    expect(thread.state?.tokenUsage).toEqual(TOKEN_USAGE_AFTER_BASIC_RUN);
    expect(thread.state?.files).toEqual([FILE_AFTER_BASIC_RUN]);

    expect(thread.customEvents).toHaveLength(1);
    expect(thread.customEvents[0]).toMatchObject({ name: "pando.summarize" });
    expect(customEvents).toHaveLength(1);

    expect(thread.isInterrupted).toBe(false);
    expect(thread.pendingToolCalls).toEqual([]);
  });

  it("reuses the thread id across runs and applies STATE_DELTA on top of the prior snapshot", async () => {
    const { fetch: fetchImpl } = queueFetch(BASIC_RUN_SSE, INTERRUPT_RUN_SSE);
    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    const thread = new PandoThread({ client, threadId: THREAD_ID });

    await drain(thread.send("hi"));
    await drain(thread.send("please update the readme"));

    expect(thread.threadId).toBe(THREAD_ID);
    expect(thread.isInterrupted).toBe(true);
    expect(thread.pendingToolCalls).toHaveLength(1);

    const pending = thread.pendingToolCalls[0]!;
    expect(pending.id).toBe(PERMISSION_CALL_ID);
    expect(pending.name).toBe("pando_permission_request");
    expect(pending.args).toEqual(PERMISSION_ARGS);
  });

  it("resume() places the tool result after the last user message and clears the interrupt", async () => {
    const { fetch: fetchImpl, calls } = queueFetch(BASIC_RUN_SSE, INTERRUPT_RUN_SSE, RESUME_RUN_SSE);
    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    const thread = new PandoThread({ client, threadId: THREAD_ID });

    await drain(thread.send("hi"));
    await drain(thread.send("please update the readme"));
    expect(thread.isInterrupted).toBe(true);
    const callId = thread.pendingToolCalls[0]!.id;

    await drain(thread.resume(callId, '{"approved":true}'));

    expect(thread.isInterrupted).toBe(false);
    expect(thread.pendingToolCalls).toEqual([]);
    const lastAssistant = [...thread.messages].reverse().find((m) => m.role === "assistant");
    expect(lastAssistant?.content).toBe("Done, README.md updated.");
    expect(thread.state?.files).toEqual([FILE_AFTER_RESUME]);

    // Inspect exactly what resume() posted (internal/agui/input.go:216-231,
    // TrailingToolMessages): messages after the last user message must be the
    // assistant tool-call message, then the tool result.
    const resumeCall = calls[2]!;
    const body = JSON.parse(String(resumeCall.body)) as {
      threadId: string;
      messages: Array<Record<string, unknown>>;
    };
    expect(body.threadId).toBe(THREAD_ID);

    const lastUserIndex = body.messages.map((m) => m["role"]).lastIndexOf("user");
    expect(lastUserIndex).toBeGreaterThan(-1);
    const trailing = body.messages.slice(lastUserIndex + 1);

    const toolIndex = trailing.findIndex(
      (m) => m["role"] === "tool" && m["toolCallId"] === PERMISSION_CALL_ID,
    );
    expect(toolIndex).toBeGreaterThan(-1);
    expect(trailing[toolIndex]?.["content"]).toBe('{"approved":true}');

    const assistantIndex = trailing.findIndex(
      (m) =>
        m["role"] === "assistant" &&
        Array.isArray(m["toolCalls"]) &&
        (m["toolCalls"] as Array<{ id: string }>).some((c) => c.id === PERMISSION_CALL_ID),
    );
    expect(assistantIndex).toBeGreaterThan(-1);
    expect(assistantIndex).toBeLessThan(toolIndex);
  });
});

describe("applyJsonPatch", () => {
  it("supports add, replace, remove and the /files/- append form", () => {
    const doc: {
      todos: string[];
      files: Array<{ path: string; action: string }>;
      tokenUsage: unknown;
    } = { todos: [], files: [], tokenUsage: null };

    let next = applyJsonPatch(doc, [{ op: "replace", path: "/todos", value: ["a", "b"] }]);
    expect(next.todos).toEqual(["a", "b"]);

    next = applyJsonPatch(next, [{ op: "add", path: "/files/-", value: { path: "a.md", action: "read" } }]);
    expect(next.files).toEqual([{ path: "a.md", action: "read" }]);

    next = applyJsonPatch(next, [{ op: "add", path: "/files/-", value: { path: "b.md", action: "read" } }]);
    next = applyJsonPatch(next, [
      { op: "replace", path: "/files/1", value: { path: "b.md", action: "write" } },
    ]);
    expect(next.files).toEqual([
      { path: "a.md", action: "read" },
      { path: "b.md", action: "write" },
    ]);

    next = applyJsonPatch(next, [{ op: "remove", path: "/files/0" }]);
    expect(next.files).toEqual([{ path: "b.md", action: "write" }]);

    next = applyJsonPatch(next, [{ op: "remove", path: "/tokenUsage" }]);
    expect("tokenUsage" in next).toBe(false);
  });

  it("supports RFC-6901 pointer escaping (~0, ~1)", () => {
    const doc: Record<string, number> = { "a/b": 1, "c~d": 2 };
    const next = applyJsonPatch(doc, [{ op: "replace", path: "/a~1b", value: 9 }]);
    expect(next["a/b"]).toBe(9);
  });

  it("rejects unsupported ops instead of silently ignoring them", () => {
    expect(() => applyJsonPatch({ a: 1 }, [{ op: "move", path: "/a", from: "/b" }])).toThrow(/unsupported/);
  });

  it("rejects an out-of-range array index", () => {
    expect(() =>
      applyJsonPatch({ files: [] as unknown[] }, [{ op: "replace", path: "/files/0", value: 1 }]),
    ).toThrow(/out of bounds/);
  });
});

describe("PandoThread state ordering", () => {
  it("throws when STATE_DELTA arrives before any STATE_SNAPSHOT", async () => {
    const encoder = new TextEncoder();
    const bad =
      "data: " +
      JSON.stringify({ type: "STATE_DELTA", delta: [{ op: "replace", path: "/todos", value: [] }] }) +
      "\n\n";
    const fetchImpl = jest.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(bad));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    const thread = new PandoThread({ client, threadId: THREAD_ID });

    await expect(drain(thread.send("hi"))).rejects.toThrow(/STATE_DELTA received before STATE_SNAPSHOT/);
  });
});
