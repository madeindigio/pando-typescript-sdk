import { describe, expect, it, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PandoAguiClient } from "../src/agui/client.js";
import { PandoThread } from "../src/agui/thread.js";
import type { AguiEvent } from "../src/agui/types.js";

/**
 * PANDO-US-0010 — replay tests against the committed SSE fixtures in
 * `tests/fixtures/agui/*.sse` (see that directory's README for what each
 * file covers and how it was produced). Pure fixture replay: no network, no
 * live server — these must pass offline and in CI.
 */

function loadFixture(name: string): string {
  const path = fileURLToPath(new URL(`./fixtures/agui/${name}`, import.meta.url));
  return readFileSync(path, "utf8");
}

/** Builds a `Response` streaming `text` as its body, byte for byte. */
function sseResponse(text: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
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

async function drain(gen: AsyncGenerator<AguiEvent, void, undefined>): Promise<AguiEvent[]> {
  const out: AguiEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

describe("interrupt then resume (recorded fixtures)", () => {
  const INTERRUPT_SSE = loadFixture("interrupt-frontend-tool.sse");
  const RESUME_SSE = loadFixture("resume-frontend-tool.sse");

  it("replaying a stream ending in RUN_FINISHED{outcome:\"interrupt\"} surfaces the pending tool call", async () => {
    const { fetch: fetchImpl } = queueFetch(INTERRUPT_SSE);
    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    const thread = new PandoThread({ client, threadId: "rec-thread-1" });

    const events = await drain(thread.send("Call the get_weather tool for Madrid."));

    expect(events.some((e) => e.type === "RUN_FINISHED")).toBe(true);
    expect(thread.isInterrupted).toBe(true);
    expect(thread.pendingToolCalls).toHaveLength(1);

    const pending = thread.pendingToolCalls[0]!;
    expect(pending.name).toBe("get_weather");
    expect(pending.args).toEqual({ city: "Madrid" });
  });

  it("resume() places the tool result after the last user message, keyed by the matching toolCallId (input.go:216-231)", async () => {
    const { fetch: fetchImpl, calls } = queueFetch(INTERRUPT_SSE, RESUME_SSE);
    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    const thread = new PandoThread({ client, threadId: "rec-thread-1" });

    await drain(thread.send("Call the get_weather tool for Madrid."));
    expect(thread.isInterrupted).toBe(true);
    const callId = thread.pendingToolCalls[0]!.id;
    expect(callId).toBe("rec-call-weather-1");

    await drain(thread.resume(callId, JSON.stringify({ tempC: 22, condition: "sunny" })));

    expect(thread.isInterrupted).toBe(false);
    expect(thread.pendingToolCalls).toEqual([]);

    // Inspect exactly what resume() posted as the second request body.
    const resumeBody = JSON.parse(String(calls[1]!.body)) as {
      threadId: string;
      messages: Array<Record<string, unknown>>;
    };
    expect(resumeBody.threadId).toBe("rec-thread-1");

    const lastUserIndex = resumeBody.messages.map((m) => m["role"]).lastIndexOf("user");
    expect(lastUserIndex).toBeGreaterThan(-1);
    const trailing = resumeBody.messages.slice(lastUserIndex + 1);

    const toolIndex = trailing.findIndex((m) => m["role"] === "tool" && m["toolCallId"] === callId);
    expect(toolIndex).toBeGreaterThan(-1);
    expect(trailing[toolIndex]?.["content"]).toBe(JSON.stringify({ tempC: 22, condition: "sunny" }));

    // The assistant message carrying the tool call must precede its result,
    // both still after the last user message.
    const assistantIndex = trailing.findIndex(
      (m) =>
        m["role"] === "assistant" &&
        Array.isArray(m["toolCalls"]) &&
        (m["toolCalls"] as Array<{ id: string }>).some((c) => c.id === callId),
    );
    expect(assistantIndex).toBeGreaterThan(-1);
    expect(assistantIndex).toBeLessThan(toolIndex);

    const lastAssistant = [...thread.messages].reverse().find((m) => m.role === "assistant");
    expect(lastAssistant?.content).toContain("22");
  });
});

describe("STATE_DELTA application (recorded fixture)", () => {
  it("a /todos + /tokenUsage + /files/- sequence reduces to the expected PandoState", async () => {
    const sse = loadFixture("state-delta-todos-tokenusage-files.sse");
    const { fetch: fetchImpl } = queueFetch(sse);
    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    const thread = new PandoThread({ client, threadId: "rec-thread-2" });

    await drain(thread.send("Read the README, then write a two-item todo list."));

    expect(thread.state).toMatchObject({
      thread: "rec-thread-2",
      session: "rec-session-2",
      todos: [
        { content: "Read the deployment guide", status: "in_progress", priority: "high" },
        { content: "Summarize open questions", status: "pending", priority: "medium" },
      ],
      tokenUsage: {
        promptTokens: 842,
        completionTokens: 156,
        contextWindow: 200000,
        estimated: false,
        cacheReadTokens: 512,
        reasoningTokens: 40,
        cost: 0.0123,
      },
      files: [{ path: "docs/DEPLOY.md", name: "DEPLOY.md", action: "read" }],
    });
  });
});
