/**
 * Tests for PandoClient.
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
    kill: jest.fn((signal?: NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        child.emit("close", 1);
      }
    }),
  }) as unknown as ChildProcess;

  // Simulate async output and process close.
  // Emit close slightly after stdout is closed so readline can finish first.
  setTimeout(() => {
    if (stdout) {
      stdoutStream.push(stdout);
    }
    stdoutStream.push(null);
    stderrStream.push(null);
    // Defer close emission so readline has time to process the end.
    setImmediate(() => {
      child.emit("close", exitCode);
    });
  }, delay);

  return child;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PandoClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("run() returns parsed JSON response", async () => {
    spawnMock.mockReturnValue(
      createFakeChild(0, JSON.stringify({ response: "All done!", sessionId: "s-1" }) + "\n")
    );

    const { PandoClient } = await import("../src/client.js");
    const client = new PandoClient({ pandoPath: "/usr/bin/pando" });

    const result = await client.run("Fix lint errors");
    expect(result.response).toBe("All done!");
    expect(result.sessionId).toBe("s-1");
    expect(result.raw).toMatchObject({ response: "All done!" });
  });

  it("run() passes -f json and -p flags", async () => {
    spawnMock.mockReturnValue(
      createFakeChild(0, JSON.stringify({ response: "ok" }) + "\n")
    );

    const { PandoClient } = await import("../src/client.js");
    const client = new PandoClient({ pandoPath: "/usr/bin/pando" });
    await client.run("Hello");

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toContain("-p");
    expect(args).toContain("Hello");
    expect(args).toContain("-f");
    expect(args).toContain("json");
  });

  it("run() passes --yolo when allowAllTools is true", async () => {
    spawnMock.mockReturnValue(
      createFakeChild(0, JSON.stringify({ response: "ok" }) + "\n")
    );

    const { PandoClient } = await import("../src/client.js");
    const client = new PandoClient({ pandoPath: "/usr/bin/pando" });
    await client.run("Fix lint", { allowAllTools: true });

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--yolo");
  });

  it("run() passes -m flag when model is configured", async () => {
    spawnMock.mockReturnValue(
      createFakeChild(0, JSON.stringify({ response: "ok" }) + "\n")
    );

    const { PandoClient } = await import("../src/client.js");
    const client = new PandoClient({
      pandoPath: "/usr/bin/pando",
      model: "copilot.gpt-5.4",
    });
    await client.run("Hello");

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toContain("-m");
    expect(args).toContain("copilot.gpt-5.4");
  });

  it("run() throws PandoConnectionError on non-zero exit", async () => {
    spawnMock.mockReturnValue(createFakeChild(1, ""));

    const { PandoClient } = await import("../src/client.js");
    const { PandoConnectionError } = await import("../src/exceptions.js");
    const client = new PandoClient({ pandoPath: "/usr/bin/pando" });

    await expect(client.run("Hello")).rejects.toBeInstanceOf(PandoConnectionError);
  });

  it("run() throws PandoConnectionError when no JSON output", async () => {
    spawnMock.mockReturnValue(createFakeChild(0, "not json output\n"));

    const { PandoClient } = await import("../src/client.js");
    const { PandoConnectionError } = await import("../src/exceptions.js");
    const client = new PandoClient({ pandoPath: "/usr/bin/pando" });

    await expect(client.run("Hello")).rejects.toBeInstanceOf(PandoConnectionError);
  });

  it("stream() yields text chunks", async () => {
    spawnMock.mockReturnValue(createFakeChild(0, "line1\nline2\n"));

    const { PandoClient } = await import("../src/client.js");
    const client = new PandoClient({ pandoPath: "/usr/bin/pando" });

    const chunks: string[] = [];
    for await (const chunk of client.stream("Explain this")) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toContain("line1");
    expect(chunks.join("")).toContain("line2");
  });

  it("stream() passes -f text flag", async () => {
    spawnMock.mockReturnValue(createFakeChild(0, "text output\n"));

    const { PandoClient } = await import("../src/client.js");
    const client = new PandoClient({ pandoPath: "/usr/bin/pando" });

    // Consume the generator.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of client.stream("Hello")) {
      // consume
    }

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toContain("-f");
    expect(args).toContain("text");
  });

  it("findPandoBinary() returns explicit path when provided", async () => {
    const { findPandoBinary } = await import("../src/transport.js");
    const result = findPandoBinary("/explicit/path/pando");
    expect(result).toBe("/explicit/path/pando");
  });

  it("findPandoBinary() uses PANDO_PATH env var when set", async () => {
    const { findPandoBinary } = await import("../src/transport.js");
    const originalEnv = process.env["PANDO_PATH"];
    process.env["PANDO_PATH"] = "/env/pando";

    const result = findPandoBinary();
    expect(result).toBe("/env/pando");

    if (originalEnv !== undefined) {
      process.env["PANDO_PATH"] = originalEnv;
    } else {
      delete process.env["PANDO_PATH"];
    }
  });
});
