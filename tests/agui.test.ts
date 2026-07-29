import { describe, expect, it, jest } from "@jest/globals";

import {
  PandoAguiClient,
  PandoAguiError,
  parseSSE,
} from "../src/agui/index.js";
import {
  createPandoAgent,
  discoverPandoAgents,
  registerPandoCopilotKit,
} from "../src/agui/copilotkit.js";
import type { AguiEvent, AguiInfo } from "../src/agui/types.js";

/** Builds a Response streaming `chunks` as its body, byte for byte. */
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

function frame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function collect(events: AsyncIterable<AguiEvent>): Promise<AguiEvent[]> {
  const out: AguiEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("PandoAguiClient", () => {
  it("posts a RunAgentInput to the agent's endpoint with the bearer token", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchImpl = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenInit = init;
      return sseResponse([frame({ type: "RUN_FINISHED", threadId: "t", runId: "r" })]);
    }) as unknown as typeof fetch;

    const client = new PandoAguiClient({
      baseUrl: "http://localhost:8090/",
      token: "secret",
      fetch: fetchImpl,
    });
    await collect(client.run({ prompt: "hello", threadId: "t", runId: "r" }));

    expect(seenUrl).toBe("http://localhost:8090/api/v1/agui/coder");
    expect(seenInit?.method).toBe("POST");
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret");
    expect(headers["Accept"]).toBe("text/event-stream");

    const body = JSON.parse(String(seenInit?.body)) as Record<string, unknown>;
    expect(body["threadId"]).toBe("t");
    expect(body["messages"]).toEqual([
      { id: expect.any(String), role: "user", content: "hello" },
    ]);
  });

  it("reassembles events split across chunk boundaries", async () => {
    const full =
      frame({ type: "RUN_STARTED", threadId: "t", runId: "r" }) +
      frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "hel" }) +
      frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "lo" }) +
      frame({ type: "RUN_FINISHED", threadId: "t", runId: "r", outcome: "success" });

    // Split at an arbitrary offset inside the second event.
    const cut = 70;
    const fetchImpl = jest.fn(async () =>
      sseResponse([full.slice(0, cut), full.slice(cut)]),
    ) as unknown as typeof fetch;

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
    const fetchImpl = jest.fn(async () =>
      sseResponse([
        frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "ok " }),
        frame({ type: "TOOL_CALL_START", toolCallId: "c", toolCallName: "view" }),
        frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "done" }),
        frame({ type: "RUN_FINISHED", threadId: "t", runId: "r" }),
      ]),
    ) as unknown as typeof fetch;

    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    await expect(client.runText("hi")).resolves.toBe("ok done");
  });

  it("surfaces RUN_ERROR from runText", async () => {
    const fetchImpl = jest.fn(async () =>
      sseResponse([frame({ type: "RUN_ERROR", message: "model refused" })]),
    ) as unknown as typeof fetch;

    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    await expect(client.runText("hi")).rejects.toThrow("model refused");
  });

  it("maps a rejected request onto PandoAguiError with its status", async () => {
    const fetchImpl = jest.fn(async () =>
      new Response(JSON.stringify({ error: "invalid or missing token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    const run = collect(client.run({ prompt: "hi" }));
    await expect(run).rejects.toBeInstanceOf(PandoAguiError);
    await expect(run).rejects.toThrow("invalid or missing token");
  });

  it("omits the Authorization header when no token is configured", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = jest.fn(async (_url: unknown, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return sseResponse([frame({ type: "RUN_FINISHED", threadId: "t", runId: "r" })]);
    }) as unknown as typeof fetch;

    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    await collect(client.run({ prompt: "hi" }));
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("fetches the discovery document", async () => {
    const info: AguiInfo = {
      protocol: "ag-ui",
      path: "/api/v1/agui",
      agents: [
        { name: "coder", url: "http://127.0.0.1:8090/api/v1/agui/coder" },
      ],
      capabilities: {
        frontendTools: true,
        humanInTheLoop: true,
        sharedState: true,
        interrupts: true,
      },
    };
    const fetchImpl = jest.fn(async (url: unknown) => {
      expect(String(url)).toBe("http://x/api/v1/agui/info");
      return new Response(JSON.stringify(info), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    await expect(client.info()).resolves.toEqual(info);
  });
});

describe("parseSSE", () => {
  it("ignores frames that are not JSON instead of ending the stream", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": keep-alive\n\n"));
        controller.enqueue(encoder.encode("data: not json\n\n"));
        controller.enqueue(encoder.encode(frame({ type: "RUN_FINISHED" })));
        controller.close();
      },
    });

    const events = await collect(parseSSE(body));
    expect(events.map((e) => e.type)).toEqual(["RUN_FINISHED"]);
  });

  it("yields a final frame that arrived without its trailing blank line", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "RUN_ERROR" })}`));
        controller.close();
      },
    });

    const events = await collect(parseSSE(body));
    expect(events.map((e) => e.type)).toEqual(["RUN_ERROR"]);
  });
});

/** Stand-in for `@ag-ui/client`'s HttpAgent. */
class FakeHttpAgent {
  url: string;
  headers: Record<string, string> | undefined;
  agentId: string | undefined;

  constructor(config: { url: string; headers?: Record<string, string>; agentId?: string }) {
    this.url = config.url;
    this.headers = config.headers;
    this.agentId = config.agentId;
  }
}

describe("CopilotKit helpers", () => {
  it("builds an authenticated agent without importing the peer", async () => {
    const agent = (await createPandoAgent({
      baseUrl: "http://localhost:8090",
      agent: "task",
      token: "secret",
      HttpAgent: FakeHttpAgent,
    })) as FakeHttpAgent;

    expect(agent.url).toBe("http://localhost:8090/api/v1/agui/task");
    expect(agent.headers?.["Authorization"]).toBe("Bearer secret");
    expect(agent.agentId).toBe("task");
  });

  it("registers every agent discovery advertises, keeping the configured origin", async () => {
    const fetchImpl = jest.fn(async () =>
      new Response(
        JSON.stringify({
          protocol: "ag-ui",
          path: "/api/v1/agui",
          agents: [
            // A proxy rewrote Host: the reported origin is unreachable here.
            { name: "coder", url: "http://internal:9999/api/v1/agui/coder" },
            { name: "task", url: "http://internal:9999/api/v1/agui/task" },
          ],
          capabilities: {
            frontendTools: true,
            humanInTheLoop: true,
            sharedState: true,
            interrupts: true,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const agents = (await discoverPandoAgents({
      baseUrl: "http://localhost:8090",
      token: "secret",
      HttpAgent: FakeHttpAgent,
      client: new PandoAguiClient({
        baseUrl: "http://localhost:8090",
        token: "secret",
        fetch: fetchImpl,
      }),
    })) as Record<string, FakeHttpAgent>;

    expect(Object.keys(agents).sort()).toEqual(["coder", "task"]);
    expect(agents["coder"]?.url).toBe("http://localhost:8090/api/v1/agui/coder");
  });

  it("fails loudly when the server advertises no agents", async () => {
    const fetchImpl = jest.fn(async () =>
      new Response(
        JSON.stringify({ protocol: "ag-ui", path: "/api/v1/agui", agents: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    await expect(
      discoverPandoAgents({
        baseUrl: "http://localhost:8090",
        HttpAgent: FakeHttpAgent,
        client: new PandoAguiClient({ baseUrl: "http://localhost:8090", fetch: fetchImpl }),
      }),
    ).rejects.toThrow("advertises no AG-UI agents");
  });

  it("wires the CopilotKit runtime with the discovered agents", async () => {
    const handleRequest = jest.fn(async () => new Response("ok"));
    let runtimeAgents: Record<string, unknown> = {};
    let endpoint = "";

    const route = await registerPandoCopilotKit({
      baseUrl: "http://localhost:8090",
      token: "secret",
      endpoint: "/api/copilotkit",
      HttpAgent: FakeHttpAgent,
      agents: { coder: new FakeHttpAgent({ url: "http://localhost:8090/api/v1/agui/coder" }) },
      runtimeModule: {
        CopilotRuntime: class {
          constructor(config: { agents: Record<string, unknown> }) {
            runtimeAgents = config.agents;
          }
        },
        ExperimentalEmptyAdapter: class {},
        copilotRuntimeNextJSAppRouterEndpoint: (config) => {
          endpoint = config.endpoint;
          return { handleRequest: handleRequest as (req: Request) => Promise<Response> };
        },
      },
    });

    expect(Object.keys(runtimeAgents)).toEqual(["coder"]);
    expect(endpoint).toBe("/api/copilotkit");
    expect(route.POST).toBe(handleRequest);
    expect(route.GET).toBe(handleRequest);
  });

  it("explains which optional peer is missing", async () => {
    await expect(
      createPandoAgent({ baseUrl: "http://localhost:8090" }),
    ).rejects.toThrow('optional peer "@ag-ui/client"');
  });
});
