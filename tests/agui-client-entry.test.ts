import { describe, expect, it, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PandoAguiClient, PandoAguiError, parseSSE, randomId } from "../src/agui/client-entry.js";
import type { AguiEvent, PandoState } from "../src/agui/client-entry.js";

/**
 * Coverage for the `@pando-ai/sdk/agui/client` deep export (PANDO-US-0006):
 * it must expose the plain AG-UI client + protocol types, and must never pull
 * in the CopilotKit surface — that is what makes it safe for a browser
 * bundler that only sees this subpath.
 */

/** Builds a Response streaming `chunks` as its body, byte for byte. */
function sseResponse(chunks: string[]): Response {
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
  });
}

function frame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

describe("@pando-ai/sdk/agui/client (browser-safe subpath)", () => {
  it("exports a working PandoAguiClient", async () => {
    const fetchImpl = jest.fn(async () =>
      sseResponse([frame({ type: "RUN_FINISHED", threadId: "t", runId: "r" })])
    ) as unknown as typeof fetch;

    const client = new PandoAguiClient({ baseUrl: "http://localhost:8090", fetch: fetchImpl });
    const events: AguiEvent[] = [];
    for await (const event of client.run({ prompt: "hi", threadId: "t", runId: "r" })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("RUN_FINISHED");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-exports the utility helpers and protocol types", () => {
    expect(typeof parseSSE).toBe("function");
    expect(randomId("thread")).toMatch(/^thread-/);

    // Compile-time only: proves types.ts is re-exported through this subpath.
    const state: PandoState = {
      thread: "t",
      session: "s",
      agent: "coder",
      model: { id: "m" },
      todos: [],
      tokenUsage: null,
      files: [],
      subAgents: [],
    };
    expect(state.agent).toBe("coder");
  });

  it("does not export the CopilotKit surface", async () => {
    const mod = (await import("../src/agui/client-entry.js")) as Record<string, unknown>;
    expect(mod["createPandoAgent"]).toBeUndefined();
    expect(mod["discoverPandoAgents"]).toBeUndefined();
    expect(mod["registerPandoCopilotKit"]).toBeUndefined();
  });

  it("PandoAguiError is exported and usable", () => {
    const err = new PandoAguiError(500, "boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(500);
  });

  it("source file has no import of copilotkit.ts", () => {
    const path = fileURLToPath(new URL("../src/agui/client-entry.ts", import.meta.url));
    const source = readFileSync(path, "utf8");
    // The doc comment may name copilotkit.ts for context; no import may reference it.
    expect(source).not.toMatch(/from\s+["']\.\/copilotkit\.js["']/);
  });
});

describe("src/http.ts (PANDO-US-0006)", () => {
  it("has no static node: import", () => {
    const path = fileURLToPath(new URL("../src/http.ts", import.meta.url));
    const source = readFileSync(path, "utf8");
    // A static `import ... from "node:..."` (not `import type`) would break a
    // bundler resolving the main entry for the browser.
    const staticNodeImport = /^import\s+(?!type\b)[^;]*from\s+["']node:/m;
    expect(staticNodeImport.test(source)).toBe(false);
  });
});
