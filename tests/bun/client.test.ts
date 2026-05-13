/**
 * Bun-native tests for PandoClient.
 *
 * Run with: bun test tests/bun/client.test.ts
 *
 * Bun supports node:child_process natively. We use mock.module() to intercept spawn.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Fake child process factory
// ---------------------------------------------------------------------------

function createFakeChild(exitCode = 0, stdout = "", delay = 10): ChildProcess {
  const stdinStream = new PassThrough();
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();
  const emitter = new EventEmitter();

  const child = Object.assign(emitter, {
    stdin: stdinStream,
    stdout: stdoutStream,
    stderr: stderrStream,
    exitCode: null,
    killed: false,
    pid: 55555,
    kill: mock((signal?: NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        child.emit("close", 1);
      }
    }),
  }) as unknown as ChildProcess;

  setTimeout(() => {
    if (stdout) {
      stdoutStream.push(stdout);
    }
    stdoutStream.push(null);
    stderrStream.push(null);
    setImmediate(() => {
      child.emit("close", exitCode);
    });
  }, delay);

  return child;
}

// ---------------------------------------------------------------------------
// Mock setup using Bun's mock.module
// ---------------------------------------------------------------------------

const spawnFn = mock(() => createFakeChild(0, JSON.stringify({ response: "default", sessionId: "" }) + "\n"));

mock.module("node:child_process", () => ({
  spawn: spawnFn,
}));

mock.module("node:fs", () => ({
  existsSync: mock(() => true),
  accessSync: mock(() => {}),
  constants: { X_OK: 1 },
}));

// ---------------------------------------------------------------------------
// Tests — import AFTER mocks are set up
// ---------------------------------------------------------------------------

const { PandoClient } = await import("../../src/client.ts");
const { findPandoBinary } = await import("../../src/transport.ts");

describe("PandoClient", () => {
  beforeEach(() => {
    spawnFn.mockClear();
  });

  it("run() returns parsed JSON response", async () => {
    spawnFn.mockImplementation(() =>
      createFakeChild(0, JSON.stringify({ response: "All done!", sessionId: "s-1" }) + "\n")
    );

    const client = new PandoClient({ pandoPath: "/usr/bin/pando" });
    const result = await client.run("Fix lint errors");

    expect(result.response).toBe("All done!");
    expect(result.sessionId).toBe("s-1");
    expect(result.raw).toMatchObject({ response: "All done!" });
  });

  it("run() passes -p and -f json flags", async () => {
    spawnFn.mockImplementation(() =>
      createFakeChild(0, JSON.stringify({ response: "ok" }) + "\n")
    );

    const client = new PandoClient({ pandoPath: "/usr/bin/pando" });
    await client.run("Hello");

    const args = spawnFn.mock.calls[0]?.[1] as string[];
    expect(args).toContain("-p");
    expect(args).toContain("Hello");
    expect(args).toContain("-f");
    expect(args).toContain("json");
  });

  it("run() passes --yolo when allowAllTools is true", async () => {
    spawnFn.mockImplementation(() =>
      createFakeChild(0, JSON.stringify({ response: "ok" }) + "\n")
    );

    const client = new PandoClient({ pandoPath: "/usr/bin/pando" });
    await client.run("Fix lint", { allowAllTools: true });

    const args = spawnFn.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--yolo");
  });

  it("run() passes -m flag when model is configured", async () => {
    spawnFn.mockImplementation(() =>
      createFakeChild(0, JSON.stringify({ response: "ok" }) + "\n")
    );

    const client = new PandoClient({ pandoPath: "/usr/bin/pando", model: "copilot.gpt-5.4" });
    await client.run("Hello");

    const args = spawnFn.mock.calls[0]?.[1] as string[];
    expect(args).toContain("-m");
    expect(args).toContain("copilot.gpt-5.4");
  });

  it("run() throws PandoConnectionError on non-zero exit", async () => {
    const { PandoConnectionError } = await import("../../src/exceptions.ts");
    spawnFn.mockImplementation(() => createFakeChild(1, ""));

    const client = new PandoClient({ pandoPath: "/usr/bin/pando" });
    await expect(client.run("Hello")).rejects.toBeInstanceOf(PandoConnectionError);
  });

  it("run() throws PandoConnectionError when no JSON output", async () => {
    const { PandoConnectionError } = await import("../../src/exceptions.ts");
    spawnFn.mockImplementation(() => createFakeChild(0, "not json output\n"));

    const client = new PandoClient({ pandoPath: "/usr/bin/pando" });
    await expect(client.run("Hello")).rejects.toBeInstanceOf(PandoConnectionError);
  });

  it("stream() yields text chunks", async () => {
    spawnFn.mockImplementation(() => createFakeChild(0, "line1\nline2\n"));

    const client = new PandoClient({ pandoPath: "/usr/bin/pando" });
    const chunks: string[] = [];
    for await (const chunk of client.stream("Explain this")) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toContain("line1");
    expect(chunks.join("")).toContain("line2");
  });

  it("stream() passes -f text flag", async () => {
    spawnFn.mockImplementation(() => createFakeChild(0, "text output\n"));

    const client = new PandoClient({ pandoPath: "/usr/bin/pando" });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of client.stream("Hello")) {
      // consume
    }

    const args = spawnFn.mock.calls[0]?.[1] as string[];
    expect(args).toContain("-f");
    expect(args).toContain("text");
  });
});

describe("findPandoBinary", () => {
  it("returns explicit path when provided and accessible", () => {
    const result = findPandoBinary("/explicit/pando");
    expect(result).toBe("/explicit/pando");
  });

  it("uses PANDO_PATH env var when set", () => {
    const original = process.env["PANDO_PATH"];
    process.env["PANDO_PATH"] = "/env/pando";

    const result = findPandoBinary();
    expect(result).toBe("/env/pando");

    if (original !== undefined) {
      process.env["PANDO_PATH"] = original;
    } else {
      delete process.env["PANDO_PATH"];
    }
  });
});
