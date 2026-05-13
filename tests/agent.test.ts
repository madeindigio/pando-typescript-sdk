/**
 * Tests for PandoAgent and PandoSession.
 *
 * Uses jest.unstable_mockModule for ESM-compatible module mocking.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Module-level spawn mock (must be set up before any imports of src modules)
// ---------------------------------------------------------------------------

const spawnMock = jest.fn<typeof import("node:child_process").spawn>();

jest.unstable_mockModule("node:child_process", () => ({
  spawn: spawnMock,
}));

// Mock fs so every path looks valid and executable.
jest.unstable_mockModule("node:fs", () => ({
  existsSync: jest.fn(() => true),
  accessSync: jest.fn(),
  constants: { X_OK: 1 },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockChild extends ChildProcess {
  _stdin: PassThrough;
  _stdout: PassThrough;
  _stderr: PassThrough;
}

function createMockChild(): MockChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();

  return Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    _stdin: stdin,
    _stdout: stdout,
    _stderr: stderr,
    exitCode: null,
    killed: false,
    pid: 99999,
    kill: jest.fn(),
  }) as unknown as MockChild;
}

function sendToStdout(child: MockChild, obj: unknown): void {
  child._stdout.push(JSON.stringify(obj) + "\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PandoAgent", () => {
  let mockChild: MockChild;

  beforeEach(() => {
    mockChild = createMockChild();
    spawnMock.mockReturnValue(mockChild as unknown as ChildProcess);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("connect() spawns pando acp subprocess", async () => {
    const { PandoAgent } = await import("../src/agent.js");

    const agent = new PandoAgent({ pandoPath: "/usr/bin/pando", cwd: "/project" });
    await agent.connect();

    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/bin/pando",
      ["acp"],
      expect.objectContaining({ cwd: "/project" })
    );
    expect(agent.connected).toBe(true);
    await agent.disconnect();
  });

  it("connect() is idempotent", async () => {
    const { PandoAgent } = await import("../src/agent.js");

    const agent = new PandoAgent({ pandoPath: "/usr/bin/pando" });
    await agent.connect();
    await agent.connect(); // Second call should be a no-op.

    expect(spawnMock).toHaveBeenCalledTimes(1);
    await agent.disconnect();
  });

  it("disconnect() marks agent as disconnected", async () => {
    const { PandoAgent } = await import("../src/agent.js");

    const agent = new PandoAgent({ pandoPath: "/usr/bin/pando" });
    await agent.connect();
    mockChild._stdout.push(null);
    await agent.disconnect();

    expect(agent.connected).toBe(false);
  });

  it("createSession() sends session/create RPC and returns PandoSession", async () => {
    const { PandoAgent } = await import("../src/agent.js");
    const { PandoSession } = await import("../src/session.js");

    const agent = new PandoAgent({ pandoPath: "/usr/bin/pando" });
    await agent.connect();

    // Intercept stdin to capture the RPC request.
    const sentLines: string[] = [];
    mockChild._stdin.on("data", (chunk: Buffer) => {
      sentLines.push(...chunk.toString().split("\n").filter(Boolean));
    });

    const sessionPromise = agent.createSession("Test session");

    // Wait for the request to be written.
    await new Promise((r) => setImmediate(r));

    // Parse the request and respond.
    expect(sentLines.length).toBeGreaterThanOrEqual(1);
    const req = JSON.parse(sentLines[0]!) as { id: number; method: string };
    expect(req.method).toBe("session/create");

    sendToStdout(mockChild, {
      jsonrpc: "2.0",
      id: req.id,
      result: { sessionId: "new-session-id" },
    });

    const session = await sessionPromise;
    expect(session).toBeInstanceOf(PandoSession);
    expect(session.id).toBe("new-session-id");

    await agent.disconnect();
  });

  it("listSessions() returns parsed session array", async () => {
    const { PandoAgent } = await import("../src/agent.js");

    const agent = new PandoAgent({ pandoPath: "/usr/bin/pando" });
    await agent.connect();

    const sentLines: string[] = [];
    mockChild._stdin.on("data", (chunk: Buffer) => {
      sentLines.push(...chunk.toString().split("\n").filter(Boolean));
    });

    const listPromise = agent.listSessions();
    await new Promise((r) => setImmediate(r));

    const req = JSON.parse(sentLines[0]!) as { id: number; method: string };
    expect(req.method).toBe("session/list");

    sendToStdout(mockChild, {
      jsonrpc: "2.0",
      id: req.id,
      result: {
        sessions: [
          { sessionId: "s-1", title: "Session 1" },
          { sessionId: "s-2", title: "Session 2" },
        ],
      },
    });

    const sessions = await listPromise;
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.sessionId).toBe("s-1");
    expect(sessions[1]?.title).toBe("Session 2");

    await agent.disconnect();
  });

  it("listPersonas() returns array of persona names", async () => {
    const { PandoAgent } = await import("../src/agent.js");

    const agent = new PandoAgent({ pandoPath: "/usr/bin/pando" });
    await agent.connect();

    const sentLines: string[] = [];
    mockChild._stdin.on("data", (chunk: Buffer) => {
      sentLines.push(...chunk.toString().split("\n").filter(Boolean));
    });

    const listPromise = agent.listPersonas();
    await new Promise((r) => setImmediate(r));

    const req = JSON.parse(sentLines[0]!) as { id: number; method: string };
    expect(req.method).toBe("persona/list");

    sendToStdout(mockChild, {
      jsonrpc: "2.0",
      id: req.id,
      result: { personas: ["assistant", "software-engineer", "qa"] },
    });

    const personas = await listPromise;
    expect(personas).toEqual(["assistant", "software-engineer", "qa"]);

    await agent.disconnect();
  });

  it("getPersona() returns active persona name", async () => {
    const { PandoAgent } = await import("../src/agent.js");

    const agent = new PandoAgent({ pandoPath: "/usr/bin/pando" });
    await agent.connect();

    const sentLines: string[] = [];
    mockChild._stdin.on("data", (chunk: Buffer) => {
      sentLines.push(...chunk.toString().split("\n").filter(Boolean));
    });

    const getPromise = agent.getPersona();
    await new Promise((r) => setImmediate(r));

    const req = JSON.parse(sentLines[0]!) as { id: number; method: string };
    expect(req.method).toBe("persona/get");

    sendToStdout(mockChild, {
      jsonrpc: "2.0",
      id: req.id,
      result: { active: "software-engineer" },
    });

    const persona = await getPromise;
    expect(persona).toBe("software-engineer");

    await agent.disconnect();
  });

  it("setPersona() sends persona/set RPC", async () => {
    const { PandoAgent } = await import("../src/agent.js");

    const agent = new PandoAgent({ pandoPath: "/usr/bin/pando" });
    await agent.connect();

    const sentLines: string[] = [];
    mockChild._stdin.on("data", (chunk: Buffer) => {
      sentLines.push(...chunk.toString().split("\n").filter(Boolean));
    });

    const setPromise = agent.setPersona("qa");
    await new Promise((r) => setImmediate(r));

    const req = JSON.parse(sentLines[0]!) as { id: number; method: string; params: Record<string, unknown> };
    expect(req.method).toBe("persona/set");
    expect(req.params["name"]).toBe("qa");

    sendToStdout(mockChild, {
      jsonrpc: "2.0",
      id: req.id,
      result: {},
    });

    await expect(setPromise).resolves.toBeUndefined();
    await agent.disconnect();
  });

  it("listModels() returns model array", async () => {
    const { PandoAgent } = await import("../src/agent.js");

    const agent = new PandoAgent({ pandoPath: "/usr/bin/pando" });
    await agent.connect();

    const sentLines: string[] = [];
    mockChild._stdin.on("data", (chunk: Buffer) => {
      sentLines.push(...chunk.toString().split("\n").filter(Boolean));
    });

    const listPromise = agent.listModels();
    await new Promise((r) => setImmediate(r));

    const req = JSON.parse(sentLines[0]!) as { id: number; method: string };
    expect(req.method).toBe("model/list");

    sendToStdout(mockChild, {
      jsonrpc: "2.0",
      id: req.id,
      result: {
        models: [
          { id: "claude-sonnet-4-6", name: "Claude Sonnet", provider: "anthropic" },
        ],
      },
    });

    const models = await listPromise;
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("claude-sonnet-4-6");

    await agent.disconnect();
  });

  it("setModel() sends model/set RPC", async () => {
    const { PandoAgent } = await import("../src/agent.js");

    const agent = new PandoAgent({ pandoPath: "/usr/bin/pando" });
    await agent.connect();

    const sentLines: string[] = [];
    mockChild._stdin.on("data", (chunk: Buffer) => {
      sentLines.push(...chunk.toString().split("\n").filter(Boolean));
    });

    const setPromise = agent.setModel("claude-sonnet-4-6");
    await new Promise((r) => setImmediate(r));

    const req = JSON.parse(sentLines[0]!) as { id: number; method: string; params: Record<string, unknown> };
    expect(req.method).toBe("model/set");
    expect(req.params["modelId"]).toBe("claude-sonnet-4-6");

    sendToStdout(mockChild, { jsonrpc: "2.0", id: req.id, result: {} });
    await expect(setPromise).resolves.toBeUndefined();
    await agent.disconnect();
  });

  it("throws PandoConnectionError when not connected", async () => {
    const { PandoAgent } = await import("../src/agent.js");
    const { PandoConnectionError } = await import("../src/exceptions.js");

    const agent = new PandoAgent({ pandoPath: "/usr/bin/pando" });
    // NOT calling connect().

    await expect(agent.createSession()).rejects.toBeInstanceOf(PandoConnectionError);
    await expect(agent.listPersonas()).rejects.toBeInstanceOf(PandoConnectionError);
    await expect(agent.listModels()).rejects.toBeInstanceOf(PandoConnectionError);
  });

  it("supports Symbol.asyncDispose", async () => {
    const { PandoAgent } = await import("../src/agent.js");

    const agent = new PandoAgent({ pandoPath: "/usr/bin/pando" });
    await agent.connect();
    expect(agent.connected).toBe(true);

    mockChild._stdout.push(null);
    await agent[Symbol.asyncDispose]();
    expect(agent.connected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PandoSession tests
// ---------------------------------------------------------------------------

describe("PandoSession", () => {
  let mockChild: MockChild;

  beforeEach(() => {
    mockChild = createMockChild();
    spawnMock.mockReturnValue(mockChild as unknown as ChildProcess);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  async function createConnectedAgent() {
    const { PandoAgent } = await import("../src/agent.js");
    const agent = new PandoAgent({ pandoPath: "/usr/bin/pando" });
    await agent.connect();
    return agent;
  }

  /**
   * Helper: intercept stdin lines, call callback with pending line when one arrives.
   */
  function interceptStdin(onLine: (line: string) => void) {
    mockChild._stdin.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        onLine(line);
      }
    });
  }

  it("send() sends prompt/send RPC and yields events", async () => {
    const agent = await createConnectedAgent();

    // Create session first via manual RPC exchange.
    const sentLines: string[] = [];
    interceptStdin((line) => sentLines.push(line));

    const sessionPromise = agent.createSession("test");
    await new Promise((r) => setImmediate(r));

    const createReq = JSON.parse(sentLines[0]!) as { id: number };
    sendToStdout(mockChild, { jsonrpc: "2.0", id: createReq.id, result: { sessionId: "sess-send" } });
    const session = await sessionPromise;

    // Now send a prompt.
    const sendReqLine: { id: number; method: string } = await new Promise((resolve) => {
      const originalLen = sentLines.length;
      const gen = session.send("Hello agent");
      setImmediate(async () => {
        await new Promise((r) => setImmediate(r));
        // Find the prompt/send request.
        for (let i = originalLen; i < sentLines.length; i++) {
          const msg = JSON.parse(sentLines[i]!) as { method?: string; id: number };
          if (msg.method === "prompt/send") {
            resolve(msg as { id: number; method: string });
            break;
          }
        }
      });
      // Start consuming events.
      (async () => {
        for await (const _event of gen) {
          // consume
        }
      })().catch(() => {/* ignore */});
    });

    // Respond to prompt/send RPC.
    sendToStdout(mockChild, { jsonrpc: "2.0", id: sendReqLine.id, result: {} });

    // Send a content_delta event.
    sendToStdout(mockChild, {
      jsonrpc: "2.0",
      method: "agent/event",
      params: { type: "content_delta", sessionId: "sess-send", delta: "Hi!" },
    });

    // Send terminal response event.
    sendToStdout(mockChild, {
      jsonrpc: "2.0",
      method: "agent/event",
      params: {
        type: "response",
        sessionId: "sess-send",
        message: { role: "assistant", content: "Hi!" },
      },
    });

    await agent.disconnect();
  });

  it("ask() collects content_delta events into a string", async () => {
    const agent = await createConnectedAgent();

    const sentLines: string[] = [];
    interceptStdin((line) => sentLines.push(line));

    // Create session.
    const sessionPromise = agent.createSession("ask-test");
    await new Promise((r) => setImmediate(r));
    const createReq = JSON.parse(sentLines[0]!) as { id: number };
    sendToStdout(mockChild, { jsonrpc: "2.0", id: createReq.id, result: { sessionId: "sess-ask" } });
    const session = await sessionPromise;

    // Start ask().
    const askPromise = session.ask("What is 2+2?");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Find the prompt/send request.
    let sendReq: { id: number } | undefined;
    for (let i = 1; i < sentLines.length; i++) {
      const msg = JSON.parse(sentLines[i]!) as { method?: string; id: number };
      if (msg.method === "prompt/send") {
        sendReq = msg;
        break;
      }
    }
    expect(sendReq).toBeDefined();

    // Respond to prompt/send.
    sendToStdout(mockChild, { jsonrpc: "2.0", id: sendReq!.id, result: {} });

    // Stream content_delta events.
    await new Promise((r) => setImmediate(r));
    sendToStdout(mockChild, {
      jsonrpc: "2.0",
      method: "agent/event",
      params: { type: "content_delta", sessionId: "sess-ask", delta: "The answer is " },
    });
    sendToStdout(mockChild, {
      jsonrpc: "2.0",
      method: "agent/event",
      params: { type: "content_delta", sessionId: "sess-ask", delta: "4." },
    });
    sendToStdout(mockChild, {
      jsonrpc: "2.0",
      method: "agent/event",
      params: {
        type: "response",
        sessionId: "sess-ask",
        message: { role: "assistant", content: "The answer is 4." },
      },
    });

    const result = await askPromise;
    expect(result).toBe("The answer is 4.");

    await agent.disconnect();
  });

  it("ask() rejects on error event", async () => {
    const { PandoSessionError } = await import("../src/exceptions.js");
    const agent = await createConnectedAgent();

    const sentLines: string[] = [];
    interceptStdin((line) => sentLines.push(line));

    // Create session.
    const sessionPromise = agent.createSession("error-test");
    await new Promise((r) => setImmediate(r));
    const createReq = JSON.parse(sentLines[0]!) as { id: number };
    sendToStdout(mockChild, { jsonrpc: "2.0", id: createReq.id, result: { sessionId: "sess-err" } });
    const session = await sessionPromise;

    const askPromise = session.ask("cause error");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    let sendReq: { id: number } | undefined;
    for (let i = 1; i < sentLines.length; i++) {
      const msg = JSON.parse(sentLines[i]!) as { method?: string; id: number };
      if (msg.method === "prompt/send") {
        sendReq = msg;
        break;
      }
    }
    sendToStdout(mockChild, { jsonrpc: "2.0", id: sendReq!.id, result: {} });

    await new Promise((r) => setImmediate(r));
    sendToStdout(mockChild, {
      jsonrpc: "2.0",
      method: "agent/event",
      params: { type: "error", sessionId: "sess-err", error: "context window exceeded" },
    });

    await expect(askPromise).rejects.toBeInstanceOf(PandoSessionError);

    await agent.disconnect();
  });

  it("setPersona() sends persona/set_session RPC", async () => {
    const agent = await createConnectedAgent();

    const sentLines: string[] = [];
    interceptStdin((line) => sentLines.push(line));

    const sessionPromise = agent.createSession("persona-test");
    await new Promise((r) => setImmediate(r));
    const createReq = JSON.parse(sentLines[0]!) as { id: number };
    sendToStdout(mockChild, { jsonrpc: "2.0", id: createReq.id, result: { sessionId: "sess-persona" } });
    const session = await sessionPromise;

    const setPromise = session.setPersona("qa");
    await new Promise((r) => setImmediate(r));

    const req = JSON.parse(sentLines[sentLines.length - 1]!) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    expect(req.method).toBe("persona/set_session");
    expect(req.params["name"]).toBe("qa");
    expect(req.params["sessionId"]).toBe("sess-persona");

    sendToStdout(mockChild, { jsonrpc: "2.0", id: req.id, result: {} });
    await expect(setPromise).resolves.toBeUndefined();

    await agent.disconnect();
  });

  it("close() sends session/close RPC", async () => {
    const agent = await createConnectedAgent();

    const sentLines: string[] = [];
    interceptStdin((line) => sentLines.push(line));

    const sessionPromise = agent.createSession("close-test");
    await new Promise((r) => setImmediate(r));
    const createReq = JSON.parse(sentLines[0]!) as { id: number };
    sendToStdout(mockChild, { jsonrpc: "2.0", id: createReq.id, result: { sessionId: "sess-close" } });
    const session = await sessionPromise;

    const closePromise = session.close();
    await new Promise((r) => setImmediate(r));

    const req = JSON.parse(sentLines[sentLines.length - 1]!) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    expect(req.method).toBe("session/close");
    expect(req.params["sessionId"]).toBe("sess-close");

    sendToStdout(mockChild, { jsonrpc: "2.0", id: req.id, result: {} });
    await expect(closePromise).resolves.toBeUndefined();

    await agent.disconnect();
  });
});
