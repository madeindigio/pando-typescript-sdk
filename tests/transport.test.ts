/**
 * Tests for JsonRpcTransport.
 *
 * Uses jest.unstable_mockModule for ESM-compatible module mocking.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Module-level spawn mock (must be set up before any imports of the module)
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

function createFakeChild(): {
  child: ChildProcess;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();

  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    killed: false,
    pid: 12345,
    kill: jest.fn(),
  }) as unknown as ChildProcess;

  return { child, stdin, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("JsonRpcTransport", () => {
  let fake: ReturnType<typeof createFakeChild>;

  beforeEach(() => {
    fake = createFakeChild();
    spawnMock.mockReturnValue(fake.child);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("spawns pando acp on connect()", async () => {
    const { JsonRpcTransport } = await import("../src/transport.js");
    const transport = new JsonRpcTransport({ pandoPath: "/usr/bin/pando", cwd: "/project" });
    await transport.connect();

    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/bin/pando",
      ["acp"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"], cwd: "/project" })
    );
    expect(transport.connected).toBe(true);
    fake.stdout.push(null);
    await transport.disconnect();
  });

  it("sends JSON-RPC requests to stdin", async () => {
    const { JsonRpcTransport } = await import("../src/transport.js");
    const transport = new JsonRpcTransport({ pandoPath: "/usr/bin/pando" });
    await transport.connect();

    const writtenLines: string[] = [];
    fake.stdin.on("data", (chunk: Buffer) => {
      writtenLines.push(...chunk.toString().split("\n").filter(Boolean));
    });

    const requestPromise = transport.request<{ sessionId: string }>("session/create", {
      title: "test",
    });

    await new Promise<void>((r) => setImmediate(r));

    expect(writtenLines.length).toBeGreaterThanOrEqual(1);
    const sentMsg = JSON.parse(writtenLines[0]!) as { jsonrpc: string; id: number; method: string };
    expect(sentMsg.jsonrpc).toBe("2.0");
    expect(sentMsg.method).toBe("session/create");
    expect(typeof sentMsg.id).toBe("number");

    // Simulate the server responding.
    fake.stdout.push(
      JSON.stringify({ jsonrpc: "2.0", id: sentMsg.id, result: { sessionId: "sess-abc" } }) + "\n"
    );

    const result = await requestPromise;
    expect(result.sessionId).toBe("sess-abc");

    fake.stdout.push(null);
    await transport.disconnect();
  });

  it("rejects pending requests on process close", async () => {
    const { JsonRpcTransport } = await import("../src/transport.js");
    const { PandoConnectionError } = await import("../src/exceptions.js");
    const transport = new JsonRpcTransport({ pandoPath: "/usr/bin/pando" });
    await transport.connect();

    // Attach an error listener to prevent unhandled error events.
    transport.on("error", () => {/* handled */});

    const requestPromise = transport.request("session/create", {});

    // Simulate unexpected process close.
    fake.child.emit("close", 1);

    await expect(requestPromise).rejects.toBeInstanceOf(PandoConnectionError);
  });

  it("rejects on JSON-RPC error response", async () => {
    const { JsonRpcTransport } = await import("../src/transport.js");
    const { PandoRPCError } = await import("../src/exceptions.js");
    const transport = new JsonRpcTransport({ pandoPath: "/usr/bin/pando" });
    await transport.connect();

    const requestPromise = transport.request("session/create", {});

    await new Promise<void>((r) => setImmediate(r));

    fake.stdout.push(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "invalid params" },
      }) + "\n"
    );

    await expect(requestPromise).rejects.toBeInstanceOf(PandoRPCError);

    fake.stdout.push(null);
    await transport.disconnect();
  });

  it("handles multiple concurrent requests and correlates by ID", async () => {
    const { JsonRpcTransport } = await import("../src/transport.js");
    const transport = new JsonRpcTransport({ pandoPath: "/usr/bin/pando" });
    await transport.connect();

    const writtenLines: string[] = [];
    fake.stdin.on("data", (chunk: Buffer) => {
      writtenLines.push(...chunk.toString().split("\n").filter(Boolean));
    });

    const p1 = transport.request<{ value: string }>("method/one", {});
    const p2 = transport.request<{ value: string }>("method/two", {});

    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    expect(writtenLines.length).toBeGreaterThanOrEqual(2);
    const req1 = JSON.parse(writtenLines[0]!) as { id: number };
    const req2 = JSON.parse(writtenLines[1]!) as { id: number };

    // Respond in reverse order.
    fake.stdout.push(JSON.stringify({ jsonrpc: "2.0", id: req2.id, result: { value: "two" } }) + "\n");
    fake.stdout.push(JSON.stringify({ jsonrpc: "2.0", id: req1.id, result: { value: "one" } }) + "\n");

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.value).toBe("one");
    expect(r2.value).toBe("two");

    fake.stdout.push(null);
    await transport.disconnect();
  });

  it("routes agent/event notifications to session queues", async () => {
    const { JsonRpcTransport } = await import("../src/transport.js");
    const transport = new JsonRpcTransport({ pandoPath: "/usr/bin/pando" });
    await transport.connect();

    // Attach error listener to catch process exit errors.
    transport.on("error", () => {/* ignore cleanup errors */});

    transport.createSessionQueue("session-123");
    const events = transport.getSessionEvents("session-123");

    const contentDelta = JSON.stringify({
      jsonrpc: "2.0",
      method: "agent/event",
      params: { type: "content_delta", sessionId: "session-123", delta: "Hello!" },
    });
    const responseEvent = JSON.stringify({
      jsonrpc: "2.0",
      method: "agent/event",
      params: { type: "response", sessionId: "session-123", message: { role: "assistant", content: "Hello!" } },
    });

    fake.stdout.push(contentDelta + "\n");
    fake.stdout.push(responseEvent + "\n");

    const collected: string[] = [];
    for await (const event of events) {
      collected.push(event.type);
    }

    expect(collected).toEqual(["content_delta", "response"]);

    // Disconnect cleanly (stdout already consumed).
    transport.on("error", () => {/* ignore */});
    await transport.disconnect();
  });

  it("events for other sessions are ignored by the subscribed session", async () => {
    const { JsonRpcTransport } = await import("../src/transport.js");
    const transport = new JsonRpcTransport({ pandoPath: "/usr/bin/pando" });
    await transport.connect();
    transport.on("error", () => {/* ignore */});

    transport.createSessionQueue("session-A");
    const eventsA = transport.getSessionEvents("session-A");

    // Push an event for session-B (should be ignored for session-A's queue).
    fake.stdout.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "agent/event",
      params: { type: "content_delta", sessionId: "session-B", delta: "ignored" },
    }) + "\n");

    // Push a terminal event for session-A.
    fake.stdout.push(JSON.stringify({
      jsonrpc: "2.0",
      method: "agent/event",
      params: { type: "response", sessionId: "session-A", message: { role: "assistant", content: "done" } },
    }) + "\n");

    const collected: string[] = [];
    for await (const event of eventsA) {
      collected.push(event.sessionId);
    }

    // Only session-A events should have been received.
    expect(collected).toEqual(["session-A"]);

    await transport.disconnect();
  });

  it("throws PandoRPCError for error responses", async () => {
    const { JsonRpcTransport } = await import("../src/transport.js");
    const { PandoRPCError } = await import("../src/exceptions.js");
    const transport = new JsonRpcTransport({ pandoPath: "/usr/bin/pando" });
    await transport.connect();

    const requestPromise = transport.request("session/create", {});

    await new Promise<void>((r) => setImmediate(r));

    fake.stdout.push(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "invalid params" },
      }) + "\n"
    );

    await expect(requestPromise).rejects.toBeInstanceOf(PandoRPCError);

    fake.stdout.push(null);
    await transport.disconnect();
  });

  it("ignores non-JSON lines without crashing", async () => {
    const { JsonRpcTransport } = await import("../src/transport.js");
    const transport = new JsonRpcTransport({ pandoPath: "/usr/bin/pando" });
    await transport.connect();

    fake.stdout.push("not json at all\n");
    fake.stdout.push("also garbage\n");

    await new Promise<void>((r) => setTimeout(r, 20));

    expect(transport.connected).toBe(true);

    fake.stdout.push(null);
    await transport.disconnect();
  });

  it("marks as disconnected after disconnect()", async () => {
    const { JsonRpcTransport } = await import("../src/transport.js");
    const transport = new JsonRpcTransport({ pandoPath: "/usr/bin/pando" });
    await transport.connect();

    fake.stdout.push(null);
    await transport.disconnect();

    expect(transport.connected).toBe(false);
  });

  it("all pending requests reject when process exits unexpectedly", async () => {
    const { JsonRpcTransport } = await import("../src/transport.js");
    const { PandoConnectionError } = await import("../src/exceptions.js");
    const transport = new JsonRpcTransport({ pandoPath: "/usr/bin/pando" });
    await transport.connect();

    // Attach error listener.
    transport.on("error", () => {/* handled */});

    const p1 = transport.request("method/one", {});
    const p2 = transport.request("method/two", {});

    // Simulate process exit.
    fake.child.emit("close", 1);

    await expect(p1).rejects.toBeInstanceOf(PandoConnectionError);
    await expect(p2).rejects.toBeInstanceOf(PandoConnectionError);
  });
});

describe("findPandoBinary", () => {
  it("returns pandoPath argument when provided and accessible", async () => {
    const { findPandoBinary } = await import("../src/transport.js");
    const result = findPandoBinary("/usr/local/bin/pando");
    expect(result).toBe("/usr/local/bin/pando");
  });

  it("finds binary via PATH", async () => {
    // Since we mock existsSync to always return true, it should find the binary in the first PATH dir.
    const { findPandoBinary } = await import("../src/transport.js");
    const originalPath = process.env["PATH"];
    process.env["PATH"] = "/fake/bin:/another/fake";
    delete process.env["PANDO_PATH"];

    const result = findPandoBinary();
    // Should find "pando" in one of the PATH directories.
    expect(result).toContain("pando");

    process.env["PATH"] = originalPath;
  });

  it("uses PANDO_PATH env var when set", async () => {
    const { findPandoBinary } = await import("../src/transport.js");
    const originalEnv = process.env["PANDO_PATH"];
    process.env["PANDO_PATH"] = "/custom/pando";

    const result = findPandoBinary();
    expect(result).toBe("/custom/pando");

    if (originalEnv !== undefined) {
      process.env["PANDO_PATH"] = originalEnv;
    } else {
      delete process.env["PANDO_PATH"];
    }
  });
});
