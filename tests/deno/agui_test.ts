/**
 * Deno-native tests for PandoAguiClient (PANDO-US-0010: the Deno suite
 * exercises agui too, not just subprocess mode).
 *
 * Run with: deno test --allow-read --allow-env --allow-net tests/deno/agui_test.ts
 *
 * `PandoAguiClient` speaks plain `fetch` with an injectable `options.fetch`,
 * so — like the Bun port — no subprocess/module mocking is needed; the same
 * fake-fetch pattern from the Jest suite (`tests/agui.test.ts`) ports as-is.
 * `--allow-net` is listed for parity with the other Deno tasks even though
 * these tests never make a real network call (the injected `fetch` never
 * touches the network); Deno's permission model still requires the flag to
 * be present if a future test in this file does.
 */
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Import directly from TypeScript source (Deno supports .ts natively, and
// resolves this package's internal `.js`-suffixed relative imports to their
// sibling `.ts` files, same as `deno check src/index.ts` already relies on).
import { PandoAguiClient, PandoAguiError, PandoAguiRunError } from "../../src/agui/client.ts";
import type { AguiEvent } from "../../src/agui/types.ts";

function frame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function collect(events: AsyncIterable<AguiEvent>): Promise<AguiEvent[]> {
  const out: AguiEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

Deno.test("PandoAguiClient - reassembles events split across chunk boundaries", async () => {
  const full =
    frame({ type: "RUN_STARTED", threadId: "t", runId: "r" }) +
    frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "hel" }) +
    frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "lo" }) +
    frame({ type: "RUN_FINISHED", threadId: "t", runId: "r", outcome: "success" });
  const cut = 70;

  const fetchImpl = (async () => sseResponse([full.slice(0, cut), full.slice(cut)])) as unknown as typeof fetch;
  const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
  const events = await collect(client.run({ prompt: "hi" }));

  assertEquals(
    events.map((e) => e.type),
    ["RUN_STARTED", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CONTENT", "RUN_FINISHED"],
  );
});

Deno.test("PandoAguiClient - concatenates assistant text in runText", async () => {
  const fetchImpl = (async () =>
    sseResponse([
      frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "ok " }),
      frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "done" }),
      frame({ type: "RUN_FINISHED", threadId: "t", runId: "r" }),
    ])) as unknown as typeof fetch;

  const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
  assertEquals(await client.runText("hi"), "ok done");
});

Deno.test("PandoAguiClient - RUN_ERROR raises PandoAguiRunError, not PandoAguiError", async () => {
  const fetchImpl = (async () =>
    sseResponse([frame({ type: "RUN_ERROR", message: "model refused", code: "cancelled" })])) as unknown as typeof fetch;

  const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
  const error = await assertRejects(() => client.runText("hi"), PandoAguiRunError);
  assertEquals((error as PandoAguiRunError).code, "cancelled");
});

Deno.test("PandoAguiClient - maps a rejected request onto PandoAguiError with its status", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: "invalid or missing token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;

  const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
  const error = await assertRejects(() => collect(client.run({ prompt: "hi" })), PandoAguiError);
  assertEquals((error as PandoAguiError).status, 401);
});

Deno.test("PandoAguiClient - rejects a non-SSE response instead of completing as an empty run", async () => {
  const fetchImpl = (async () =>
    new Response("<html>502</html>", { status: 200, headers: { "Content-Type": "text/html" } })) as unknown as typeof fetch;

  const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
  await assertRejects(() => collect(client.run({ prompt: "hi" })), Error, "not an SSE stream");
});

Deno.test("PandoAguiClient - forwards parentRunId and forwardedProps in the posted body", async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse([frame({ type: "RUN_FINISHED", threadId: "t", runId: "r" })]);
  }) as unknown as typeof fetch;

  const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
  await collect(client.run({ prompt: "hi", parentRunId: "parent-1", forwardedProps: { locale: "en-US" } }));

  assertEquals(body["parentRunId"], "parent-1");
  assertEquals(body["forwardedProps"], { locale: "en-US" });
});
