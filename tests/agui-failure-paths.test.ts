import { describe, expect, it, jest } from "@jest/globals";

import { PandoAguiClient, PandoAguiError } from "../src/agui/client.js";
import { PandoConnectionError } from "../src/exceptions.js";
import type { AguiEvent } from "../src/agui/types.js";

/**
 * PANDO-US-0010 — failure paths the happy-path suite (`tests/agui.test.ts`)
 * does not exercise: an aborted stream mid-run, a non-SSE response (a proxy
 * returning HTML/JSON instead of the adapter's own stream), and the 401 vs
 * 403 distinction (`internal/agui/server.go:47-71` — a missing/invalid token
 * and a disallowed `Origin` are different server conditions, and the client
 * must not conflate them).
 */

function frame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function collect(events: AsyncIterable<AguiEvent>): Promise<AguiEvent[]> {
  const out: AguiEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("abort mid-stream", () => {
  it("rejects cleanly and releases the SSE reader instead of hanging (client.ts's AbortSignal path)", async () => {
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        // One event arrives, then the stream goes quiet — the next
        // `reader.read()` blocks until the abort below errors it, exactly
        // like a real `fetch()` body reader does when its AbortSignal fires
        // mid-read.
        controller.enqueue(encoder.encode(frame({ type: "RUN_STARTED", threadId: "t", runId: "r" })));
      },
    });

    const controller = new AbortController();
    const fetchImpl = jest.fn(async (_url: unknown, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => {
        streamController?.error(new DOMException("The operation was aborted.", "AbortError"));
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });

    const seen: AguiEvent[] = [];
    const run = (async () => {
      for await (const event of client.run({ prompt: "hi", signal: controller.signal })) {
        seen.push(event);
        controller.abort();
      }
    })();

    await expect(run).rejects.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe("RUN_STARTED");

    // The SSE reader must have released its lock in `parseSSE`'s `finally`
    // block despite the abort — otherwise this throws
    // "ReadableStreamDefaultReader constructor can only accept readable
    // streams that are not yet locked to a reader".
    expect(() => stream.getReader()).not.toThrow();
  });

  it("rejects with a connection error when aborted before the response even arrives", async () => {
    const controller = new AbortController();
    const fetchImpl = jest.fn((_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    const run = collect(client.run({ prompt: "hi", signal: controller.signal }));
    controller.abort();

    await expect(run).rejects.toBeInstanceOf(PandoConnectionError);
  });
});

describe("non-SSE Content-Type", () => {
  it("rejects instead of completing as an empty successful run when a proxy returns HTML", async () => {
    const fetchImpl = jest.fn(
      async () =>
        new Response("<html><body>502 Bad Gateway</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    ) as unknown as typeof fetch;

    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    const run = collect(client.run({ prompt: "hi" }));

    await expect(run).rejects.toBeInstanceOf(PandoConnectionError);
    await expect(run).rejects.toThrow(/not an SSE stream/i);
  });

  it("rejects a JSON 200 response the same way (e.g. a misrouted request hitting a REST endpoint)", async () => {
    const fetchImpl = jest.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    await expect(collect(client.run({ prompt: "hi" }))).rejects.toThrow(/not an SSE stream/i);
  });

  it("still accepts text/event-stream with a charset suffix", async () => {
    const fetchImpl = jest.fn(async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(frame({ type: "RUN_FINISHED", threadId: "t", runId: "r" })));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      });
    }) as unknown as typeof fetch;

    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    const events = await collect(client.run({ prompt: "hi" }));
    expect(events.map((e) => e.type)).toEqual(["RUN_FINISHED"]);
  });
});

describe("401 vs 403 (internal/agui/server.go:47-71)", () => {
  it("maps a missing/invalid bearer token to a 401 PandoAguiError", async () => {
    const fetchImpl = jest.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid or missing token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    const run = collect(client.run({ prompt: "hi" }));
    await expect(run).rejects.toBeInstanceOf(PandoAguiError);
    await expect(run).rejects.toThrow("invalid or missing token");

    try {
      await collect(client.run({ prompt: "hi" }));
      throw new Error("expected the run to reject");
    } catch (error) {
      expect((error as PandoAguiError).status).toBe(401);
    }
  });

  it("maps a disallowed Origin to a 403 PandoAguiError — a distinct condition from a missing token", async () => {
    const fetchImpl = jest.fn(
      async () =>
        new Response(JSON.stringify({ error: "origin not allowed" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const client = new PandoAguiClient({
      baseUrl: "http://x",
      token: "a-valid-token",
      headers: { Origin: "http://evil.example" },
      fetch: fetchImpl,
    });
    const run = collect(client.run({ prompt: "hi" }));
    await expect(run).rejects.toBeInstanceOf(PandoAguiError);
    await expect(run).rejects.toThrow("origin not allowed");

    try {
      await collect(client.run({ prompt: "hi" }));
      throw new Error("expected the run to reject");
    } catch (error) {
      expect((error as PandoAguiError).status).toBe(403);
    }

    // The two conditions must be distinguishable by status alone, without
    // string-matching the message.
  });

  it("401 and 403 are distinguishable from each other via .status, not just by message", async () => {
    const responseFor = (status: number) =>
      new Response(JSON.stringify({ error: "denied" }), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    const unauthorized = new PandoAguiClient({
      baseUrl: "http://x",
      fetch: jest.fn(async () => responseFor(401)) as unknown as typeof fetch,
    });
    const forbidden = new PandoAguiClient({
      baseUrl: "http://x",
      fetch: jest.fn(async () => responseFor(403)) as unknown as typeof fetch,
    });

    const [unauthorizedError, forbiddenError] = await Promise.all([
      collect(unauthorized.run({ prompt: "hi" })).catch((e: unknown) => e as PandoAguiError),
      collect(forbidden.run({ prompt: "hi" })).catch((e: unknown) => e as PandoAguiError),
    ]);

    expect((unauthorizedError as PandoAguiError).status).toBe(401);
    expect((forbiddenError as PandoAguiError).status).toBe(403);
    expect((unauthorizedError as PandoAguiError).status).not.toBe((forbiddenError as PandoAguiError).status);
  });
});
