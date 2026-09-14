/**
 * Bun-native tests for PandoAguiClient (PANDO-US-0010: the Bun suite
 * exercises agui too, not just subprocess mode).
 *
 * Run with: bun test tests/bun/agui.test.ts
 *
 * `PandoAguiClient` speaks plain `fetch`, so unlike `tests/bun/client.test.ts`
 * (which mocks `node:child_process`) this needs no module mocking at all —
 * `options.fetch` is injectable, exactly like in the Jest suite
 * (`tests/agui.test.ts`), so the same fake-fetch pattern ports directly.
 */
import { describe, it, expect } from "bun:test";

import { PandoAguiClient, PandoAguiError, PandoAguiRunError } from "../../src/agui/client.ts";
import type { AguiEvent } from "../../src/agui/types.ts";

function frame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    ...init,
  });
}

async function collect(events: AsyncIterable<AguiEvent>): Promise<AguiEvent[]> {
  const out: AguiEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("PandoAguiClient (Bun)", () => {
  it("posts a RunAgentInput and reassembles events split across chunk boundaries", async () => {
    const full =
      frame({ type: "RUN_STARTED", threadId: "t", runId: "r" }) +
      frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "hel" }) +
      frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "lo" }) +
      frame({ type: "RUN_FINISHED", threadId: "t", runId: "r", outcome: "success" });
    const cut = 70;

    const fetchImpl = (async () => sseResponse([full.slice(0, cut), full.slice(cut)])) as unknown as typeof fetch;

    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    const events = await collect(client.run({ prompt: "hi" }));

    expect(events.map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "RUN_FINISHED",
    ]);
  });

  it("concatenates assistant text in runText", async () => {
    const fetchImpl = (async () =>
      sseResponse([
        frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "ok " }),
        frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "done" }),
        frame({ type: "RUN_FINISHED", threadId: "t", runId: "r" }),
      ])) as unknown as typeof fetch;

    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    expect(await client.runText("hi")).toBe("ok done");
  });

  it("distinguishes a RUN_ERROR (PandoAguiRunError) from an HTTP failure (PandoAguiError)", async () => {
    const fetchImpl = (async () =>
      sseResponse([frame({ type: "RUN_ERROR", message: "model refused", code: "cancelled" })])) as unknown as typeof fetch;

    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    try {
      await client.runText("hi");
      throw new Error("expected runText to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(PandoAguiRunError);
      expect(error).not.toBeInstanceOf(PandoAguiError);
      expect((error as PandoAguiRunError).code).toBe("cancelled");
    }
  });

  it("maps a rejected request onto PandoAguiError with its status", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "invalid or missing token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    try {
      await collect(client.run({ prompt: "hi" }));
      throw new Error("expected run to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(PandoAguiError);
      expect((error as PandoAguiError).status).toBe(401);
    }
  });

  it("rejects a non-SSE (proxy/HTML) response instead of completing as an empty run", async () => {
    const fetchImpl = (async () =>
      new Response("<html>502</html>", { status: 200, headers: { "Content-Type": "text/html" } })) as unknown as typeof fetch;

    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    try {
      await collect(client.run({ prompt: "hi" }));
      throw new Error("expected run to reject");
    } catch (error) {
      expect(String((error as Error).message)).toMatch(/not an SSE stream/i);
    }
  });

  it("forwards parentRunId and forwardedProps in the posted body", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([frame({ type: "RUN_FINISHED", threadId: "t", runId: "r" })]);
    }) as unknown as typeof fetch;

    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    await collect(
      client.run({ prompt: "hi", parentRunId: "parent-1", forwardedProps: { locale: "en-US" } }),
    );

    expect(body["parentRunId"]).toBe("parent-1");
    expect(body["forwardedProps"]).toEqual({ locale: "en-US" });
  });
});
