import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PandoAguiClient } from "../src/agui/client.js";
import { PandoThread } from "../src/agui/thread.js";
import { approve, cancelQuestion, deny, isPermissionRequest, isQuestionRequest } from "../src/agui/hitl.js";

/**
 * PANDO-US-0010 — permission and question round trips against a REAL
 * `pando agui-serve` instance (not a fixture replay: the point of this suite
 * is that an LLM actually decides to call a tool that needs permission, or
 * `AskUserQuestion`, which cannot be scripted from recorded bytes).
 *
 * Integration-tagged and opt-in on purpose ("Do NOT make CI depend on a live
 * agui-serve", PANDO-US-0010): the whole suite is skipped unless
 * PANDO_AGUI_INTEGRATION_BIN points at a working `pando` binary. It further
 * needs a configured LLM provider for the temp `--cwd` this suite spawns the
 * server against — without one, the server starts fine but every run fails
 * before it ever reaches a tool call, so a human running this by hand should
 * also check PANDO_AGUI_INTEGRATION_BIN's environment has credentials.
 *
 * Not run by `npm test` in this task's sandbox (no Go toolchain guaranteed
 * stable — `internal/agui` was being edited concurrently — and no provider
 * credentials configured here); written to run correctly on a maintainer's
 * machine or a future opt-in CI job.
 *
 * Run with:
 *   PANDO_AGUI_INTEGRATION_BIN=/path/to/pando npm test -- agui-integration
 */

const BIN = process.env.PANDO_AGUI_INTEGRATION_BIN;
const HOST = "127.0.0.1";
const PORT = Number(process.env.PANDO_AGUI_INTEGRATION_PORT ?? 8198);
const TOKEN = "integration-fixed-token";
const AGENT = process.env.PANDO_AGUI_INTEGRATION_AGENT ?? "coder";
const BASE_URL = `http://${HOST}:${PORT}`;

const describeIntegration = BIN ? describe : describe.skip;

async function waitForServer(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/v1/agui/info`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`pando agui-serve did not become ready on ${BASE_URL} within ${timeoutMs}ms`);
}

describeIntegration("PandoThread + HITL round trip against a real agui-serve", () => {
  let server: ChildProcess;
  let projectDir: string;

  beforeAll(async () => {
    if (!BIN) return; // describe.skip already prevents this, but keeps TS happy.
    projectDir = mkdtempSync(join(tmpdir(), "pando-agui-integration-"));

    server = spawn(
      BIN,
      [
        "agui-serve",
        "--no-tls",
        "--host",
        HOST,
        "--port",
        String(PORT),
        "--cwd",
        projectDir,
        "--agent",
        AGENT,
        "--token",
        TOKEN,
        // Deliberately NOT --auto-approve: HumanInTheLoop defaults to true
        // (internal/config/config.go: viper.SetDefault("agui.humanInTheLoop",
        // true)) and AutoApprove defaults to false, so permission prompts
        // reach this client instead of being silently granted.
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    server.stdout?.on("data", (d) => process.stdout.write(`[agui-serve] ${d}`));
    server.stderr?.on("data", (d) => process.stderr.write(`[agui-serve] ${d}`));

    await waitForServer();
  }, 30_000);

  afterAll(() => {
    server?.kill("SIGTERM");
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  function newThread(): PandoThread {
    const client = new PandoAguiClient({ baseUrl: BASE_URL, token: TOKEN, agent: AGENT });
    return new PandoThread({ client, agent: AGENT });
  }

  it("approve() lets the pending tool run", async () => {
    const thread = newThread();
    for await (const _ of thread.send(
      "Use your write tool to create a file named agui-approve-test.txt in the " +
        "current directory with the exact contents 'approved'. Do it now.",
    )) {
      // Drain to update thread state.
    }

    expect(thread.isInterrupted).toBe(true);
    const pending = thread.pendingToolCalls[0]!;
    expect(isPermissionRequest(pending)).toBe(true);

    for await (const _ of thread.resume(pending.id, approve())) {
      // Drain.
    }

    expect(thread.isInterrupted).toBe(false);
    const written = join(projectDir, "agui-approve-test.txt");
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, "utf8")).toContain("approved");
  }, 60_000);

  it("deny() refuses the tool and the file is never written", async () => {
    const thread = newThread();
    for await (const _ of thread.send(
      "Use your write tool to create a file named agui-deny-test.txt in the " +
        "current directory with the exact contents 'denied'. Do it now.",
    )) {
      // Drain.
    }

    expect(thread.isInterrupted).toBe(true);
    const pending = thread.pendingToolCalls[0]!;
    expect(isPermissionRequest(pending)).toBe(true);

    for await (const _ of thread.resume(pending.id, deny("integration test denies by policy"))) {
      // Drain.
    }

    expect(existsSync(join(projectDir, "agui-deny-test.txt"))).toBe(false);
  }, 60_000);

  it("a malformed answer denies, matching the deny-by-default rule", async () => {
    const thread = newThread();
    for await (const _ of thread.send(
      "Use your write tool to create a file named agui-malformed-test.txt in the " +
        "current directory with the exact contents 'malformed'. Do it now.",
    )) {
      // Drain.
    }

    expect(thread.isInterrupted).toBe(true);
    const pending = thread.pendingToolCalls[0]!;

    // Not JSON, not one of the accepted literals ("approve"/"yes"/...) —
    // approvalFromMessage (internal/agui/hitl.go:145-172) reads this as a
    // denial, the same as deny().
    for await (const _ of thread.resume(pending.id, "banana")) {
      // Drain.
    }

    expect(existsSync(join(projectDir, "agui-malformed-test.txt"))).toBe(false);
  }, 60_000);

  it("cancelQuestion() cancels the question and the model proceeds on its own judgement", async () => {
    const thread = newThread();
    for await (const _ of thread.send(
      "Use the AskUserQuestion tool to ask me exactly one question: header " +
        "'Database', question 'Which database should we use?', options " +
        "'Postgres' and 'SQLite'.",
    )) {
      // Drain.
    }

    expect(thread.isInterrupted).toBe(true);
    const pending = thread.pendingToolCalls[0]!;
    expect(isQuestionRequest(pending)).toBe(true);

    const events = [];
    for await (const event of thread.resume(pending.id, cancelQuestion())) {
      events.push(event);
    }

    expect(thread.isInterrupted).toBe(false);
    // The run finishes (success), it does not raise another interrupt for
    // the same question, and it does not error out.
    expect(events.some((e) => e.type === "RUN_ERROR")).toBe(false);
  }, 60_000);
});
