/**
 * Bun-native tests for PandoAgent.
 *
 * Run with: bun test tests/bun/agent.test.ts
 *
 * Uses Bun's mock.module() for child_process mocking.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Mock child process factory
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
    kill: mock(() => {}),
  }) as unknown as MockChild;
}

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

let currentMockChild: MockChild = createMockChild();

const spawnFn = mock(() => currentMockChild as unknown as ChildProcess);

mock.module("node:child_process", () => ({
  spawn: spawnFn,
}));

mock.module("node:fs", () => ({
  existsSync: mock(() => true),
  accessSync: mock(() => {}),
  constants: { X_OK: 1 },
}));

// ---------------------------------------------------------------------------
// Import modules after mocks
// ---------------------------------------------------------------------------

const { PandoAgent } = await import("../../src/agent.ts");
const { PandoSession } = await import("../../src/session.ts");
const { PandoConnectionError } = await import("../../src/exceptions.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendToStdout(child: MockChild, obj: unknown): void {
  child._stdout.push(JSON.stringify(obj) + "\n");
}

function interceptStdin(child: MockChild, onLine: (line: string) => void): void {
  child._stdin.on("data", (chunk: Buffer) => {
    const lines = chunk.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      onLine(line);
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PandoAgent", () => {
  beforeEach(() => {
    currentMockChild = createMockChild();
    spawnFn.mockClear();
  });

  it("connect() spawns pando acp subprocess", async () => {
    const agent = new PandoAgent({ pandoPath: "/usr/bin/pando", cwd: "/project" });
    await agent.connect();

    expect(spawnFn).toHaveBeenCalledWith(
      "/usr/bin/pando",
      ["acp"],
      expect.objectContaining({ cwd: "/project" })
    );
    expect(agent.connected).toBe(true);
    await agent.disconnect();
  });

  it("connect() is idempotent", async () => {
    const agent = new PandoAgent({ pandoPath: "/usr/bin/pando" });
    await agent.connect();
    await agent.connect();

    expect(spawnFn).toHaveBeenCalledTimes(1);
    await agent.disconnect();
  });

  it("disconnect() marks agent as disconnected", async () => {
    const agent = new PandoAgent({ pandoPath: "/usr/bin/pando" });
    await agent.connect();
    currentMockChild._stdout.push(null);
    await agent.disconnect();

    expect(agent.connected).toBe(false);
  });

  it("createSession() sends session/create RPC and returns PandoSession", async () => {
    const agent = new PandoAgent({ pandoPath: "/usr/bin/pando" });
    await agent.connect();

    const sentLines: string[] = [];
    interceptStdin(currentMockChild, (line) => sentLines.push(line));

    const sessionPromise = agent.createSession("Test session");
    await new Promise((r) => setImmediate(r));

    expect(sentLines.length).toBeGreaterThanOrEqual(1);
    const req = JSON.parse(sentLines[0]!) as { id: number; method: string };
    expect(req.method).toBe("session/create");

    sendToStdout(currentMockChild, {
      jsonrpc: "2.0",
      id: req.id,
      result: { sessionId: "new-sess-id" },
    });

    const session = await sessionPromise;
    expect(session).toBeInstanceOf(PandoSession);
    expect(session.id).toBe("new-sess-id");

    await agent.disconnect();
  });

  it("listPersonas() returns array of persona names", async () => {
    const agent = new PandoAgent({ pandoPath: "/usr/bin/pando" });
    await agent.connect();

    const sentLines: string[] = [];
    interceptStdin(currentMockChild, (line) => sentLines.push(line));

    const listPromise = agent.listPersonas();
    await new Promise((r) => setImmediate(r));

    const req = JSON.parse(sentLines[0]!) as { id: number; method: string };
    expect(req.method).toBe("persona/list");

    sendToStdout(currentMockChild, {
      jsonrpc: "2.0",
      id: req.id,
      result: { personas: ["assistant", "software-engineer", "qa"] },
    });

    const personas = await listPromise;
    expect(personas).toEqual(["assistant", "software-engineer", "qa"]);

    await agent.disconnect();
  });

  it("listModels() returns model array", async () => {
    const agent = new PandoAgent({ pandoPath: "/usr/bin/pando" });
    await agent.connect();

    const sentLines: string[] = [];
    interceptStdin(currentMockChild, (line) => sentLines.push(line));

    const listPromise = agent.listModels();
    await new Promise((r) => setImmediate(r));

    const req = JSON.parse(sentLines[0]!) as { id: number; method: string };
    expect(req.method).toBe("model/list");

    sendToStdout(currentMockChild, {
      jsonrpc: "2.0",
      id: req.id,
      result: {
        models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet", provider: "anthropic" }],
      },
    });

    const models = await listPromise;
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("claude-sonnet-4-6");

    await agent.disconnect();
  });

  it("throws PandoConnectionError when not connected", async () => {
    const agent = new PandoAgent({ pandoPath: "/usr/bin/pando" });
    // NOT calling connect().

    await expect(agent.createSession()).rejects.toBeInstanceOf(PandoConnectionError);
    await expect(agent.listPersonas()).rejects.toBeInstanceOf(PandoConnectionError);
    await expect(agent.listModels()).rejects.toBeInstanceOf(PandoConnectionError);
  });

  it("supports Symbol.asyncDispose", async () => {
    const agent = new PandoAgent({ pandoPath: "/usr/bin/pando" });
    await agent.connect();
    expect(agent.connected).toBe(true);

    currentMockChild._stdout.push(null);
    await agent[Symbol.asyncDispose]();
    expect(agent.connected).toBe(false);
  });
});
