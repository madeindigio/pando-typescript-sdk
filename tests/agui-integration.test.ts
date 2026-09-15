import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PandoAguiClient } from "../src/agui/client.js";
import { PandoThread } from "../src/agui/thread.js";
import { answerQuestion, approve, cancelQuestion, deny, isPermissionRequest, isQuestionRequest } from "../src/agui/hitl.js";

/**
 * PANDO-T-0002 — permission and question round trips against a REAL
 * `pando agui-serve` instance, driven by a deterministic Go-side fixture
 * agent instead of a real LLM.
 *
 * This suite used to require `PANDO_AGUI_INTEGRATION_BIN` pointing at a
 * `pando` binary plus a configured LLM provider, and was skipped without
 * both (see PANDO-US-0010's provenance note). That is no longer needed:
 * `internal/llm/agent/fixture_hitl_agent.go` fakes only the model side of a
 * run — every other part of the path (agent.Service, the real tool set,
 * permission.Service, the userinput/hitlQuestionTool substitution, the run
 * lifecycle, the SSE writer) is exactly what a real model-driven run uses —
 * so the round trip can run hermetically, with no network access and no
 * credentials, on any machine with a Go toolchain.
 *
 * The fixture agent only exists in a binary built with
 * `-tags agui_fixture_agent` (never true for a normal `go build` or a
 * release binary) and only activates with `PANDO_AGUI_FIXTURE_AGENT=1` in
 * its environment — see that file's doc comment for the full gating story.
 * This suite builds such a binary itself, into a temp directory, so the
 * test is hermetic and reproducible rather than depending on whatever
 * happens to be on PATH (that binary is very unlikely to carry the fixture
 * tag at all).
 *
 * The suite is skipped, not failed, when no `go` toolchain is available
 * (`go version` fails) and `PANDO_AGUI_FIXTURE_BIN` was not given as an
 * override — e.g. a machine that only ever runs the SDK's own test suite.
 *
 * Override knobs:
 *   PANDO_AGUI_FIXTURE_BIN   - skip the build, use this pre-built binary
 *                              (must have been built with
 *                              `-tags agui_fixture_agent`).
 *   PANDO_REPO_ROOT          - the Go module root to build from (default:
 *                              three directories up from this file, i.e.
 *                              the pando monorepo this package normally
 *                              lives inside).
 *   PANDO_AGUI_INTEGRATION_PORT - port for the spawned server.
 */

const HOST = "127.0.0.1";
const PORT = Number(process.env.PANDO_AGUI_INTEGRATION_PORT ?? 8198);
const TOKEN = "integration-fixed-token";
const AGENT = "fixture-hitl";
const BASE_URL = `http://${HOST}:${PORT}`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.PANDO_REPO_ROOT ?? resolve(__dirname, "../../..");
const FIXTURE_BIN_OVERRIDE = process.env.PANDO_AGUI_FIXTURE_BIN;

function goAvailable(): boolean {
  try {
    const res = spawnSync("go", ["version"], { stdio: "ignore" });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Reports whether REPO_ROOT really is the pando Go module.
 *
 * A `go` toolchain on its own is not enough, and assuming it was is what broke
 * CI on the first push of this suite: a GitHub runner has Go preinstalled, but
 * this repository is checked out on its own, so REPO_ROOT's default (three
 * directories up, where the monorepo sits during local development) does not
 * exist there. The suite then tried to build and failed instead of skipping.
 */
function pandoModuleAvailable(): boolean {
  try {
    const goMod = join(REPO_ROOT, "go.mod");
    if (!existsSync(goMod)) return false;
    return readFileSync(goMod, "utf8").includes("module github.com/digiogithub/pando");
  } catch {
    return false;
  }
}

const CAN_RUN = Boolean(FIXTURE_BIN_OVERRIDE) || (goAvailable() && pandoModuleAvailable());
const describeIntegration = CAN_RUN ? describe : describe.skip;

if (!CAN_RUN) {
  // eslint-disable-next-line no-console
  console.warn(
    `agui-integration.test.ts: skipped -- PANDO_AGUI_FIXTURE_BIN was not set and ` +
      `no pando Go module was found to build from (looked for a go.mod declaring ` +
      `github.com/digiogithub/pando at ${REPO_ROOT}, go toolchain ` +
      `${goAvailable() ? "present" : "missing"}). Set PANDO_REPO_ROOT to a pando ` +
      `checkout, or PANDO_AGUI_FIXTURE_BIN to a binary built with ` +
      `-tags agui_fixture_agent, to run this suite.`,
  );
}

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

/** Runs `command args...` to completion, rejecting on a non-zero exit. */
function runToCompletion(command: string, args: string[], options: { cwd?: string } = {}): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout?.on("data", () => {
      // Discarded: `go build` output is uninteresting on success.
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}\n${stderr}`));
    });
  });
}

/** Stops a spawned server, waiting briefly for a clean exit before killing it. */
async function stopServer(server: ChildProcess | undefined): Promise<void> {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise<void>((r) => server.once("exit", () => r()));
  server.kill("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000))]);
  if (server.exitCode === null) server.kill("SIGKILL");
}

describeIntegration("PandoThread + HITL round trip against a real agui-serve (fixture agent)", () => {
  let server: ChildProcess | undefined;
  let projectDir: string;
  let homeDir: string;
  let buildDir: string | undefined;
  let bin: string;

  beforeAll(async () => {
    if (FIXTURE_BIN_OVERRIDE) {
      bin = FIXTURE_BIN_OVERRIDE;
    } else {
      buildDir = mkdtempSync(join(tmpdir(), "pando-agui-fixture-build-"));
      bin = join(buildDir, "pando-fixture");
      await runToCompletion("go", ["build", "-tags", "agui_fixture_agent", "-o", bin, "."], {
        cwd: REPO_ROOT,
      });
    }

    projectDir = mkdtempSync(join(tmpdir(), "pando-agui-integration-"));
    // agui-serve loads the developer's real global config
    // (~/.config/pando, or $HOME/.pando.json for the legacy path) unless
    // HOME is isolated -- there is no subprocess equivalent of Go's
    // config.IsolateForTests(t) (internal/config/testing.go), which only
    // exists for in-process Go tests. Without this, a developer machine
    // whose own config happens to set AutoApprove or disable
    // HumanInTheLoop (plausible for a personal convenience setup) would
    // silently short-circuit the very permission prompt this suite exists
    // to exercise -- exactly what PANDO-T-0002 found happening here.
    homeDir = mkdtempSync(join(tmpdir(), "pando-agui-integration-home-"));

    server = spawn(
      bin,
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
        // reach this client instead of being silently granted -- as long as
        // the isolated HOME above also carries no conflicting override.
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PANDO_AGUI_FIXTURE_AGENT: "1",
          HOME: homeDir,
          XDG_CONFIG_HOME: "",
        },
      },
    );
    server.stdout?.on("data", (d) => process.stdout.write(`[agui-serve] ${d}`));
    server.stderr?.on("data", (d) => process.stderr.write(`[agui-serve] ${d}`));

    await waitForServer();
  }, 180_000);

  afterAll(async () => {
    await stopServer(server);
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    if (buildDir) rmSync(buildDir, { recursive: true, force: true });
  });

  function newThread(): PandoThread {
    const client = new PandoAguiClient({ baseUrl: BASE_URL, token: TOKEN, agent: AGENT });
    return new PandoThread({ client, agent: AGENT });
  }

  it("approve() lets the pending permission request's tool run and the run resumes", async () => {
    const thread = newThread();
    for await (const _ of thread.send(
      "Use your write tool to create a file named agui-approve-test.txt in the " +
        "current directory with the exact contents 'approved'. Do it now.",
    )) {
      // Drain to update thread state.
    }

    expect(thread.isInterrupted).toBe(true);
    // pendingToolCalls holds BOTH the model's own still-open "write" call
    // (it has a TOOL_CALL_END but, being blocked mid-execution, no
    // TOOL_CALL_RESULT yet) and the synthetic "pando_permission_request"
    // call hitl.go raises alongside it -- [0] is whichever streamed first
    // (the model's own call), not necessarily the permission prompt. Filter
    // with the type guard instead of assuming an index, exactly what it is
    // for.
    const pending = thread.pendingToolCalls.find(isPermissionRequest)!;
    expect(pending).toBeDefined();

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
    // See the approve() test above: pendingToolCalls also holds the
    // model's own still-open "write" call, not only the synthetic
    // permission prompt.
    const pending = thread.pendingToolCalls.find(isPermissionRequest)!;
    expect(pending).toBeDefined();

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
    // See the approve() test above: pendingToolCalls also holds the
    // model's own still-open "write" call, not only the synthetic
    // permission prompt.
    const pending = thread.pendingToolCalls.find(isPermissionRequest)!;
    expect(pending).toBeDefined();

    // Not JSON, not one of the accepted literals ("approve"/"yes"/...) --
    // approvalFromMessage (internal/agui/hitl.go:145-172) reads this as a
    // denial, the same as deny().
    for await (const _ of thread.resume(pending.id, "banana")) {
      // Drain.
    }

    expect(existsSync(join(projectDir, "agui-malformed-test.txt"))).toBe(false);
  }, 60_000);

  it("cancelQuestion() cancels the question and the run resumes on its own judgement", async () => {
    const thread = newThread();
    for await (const _ of thread.send("Use the AskUserQuestion tool now.")) {
      // Drain.
    }

    expect(thread.isInterrupted).toBe(true);
    const pending = thread.pendingToolCalls.find(isQuestionRequest)!;
    expect(pending).toBeDefined();

    const events = [];
    for await (const event of thread.resume(pending.id, cancelQuestion())) {
      events.push(event);
    }

    expect(thread.isInterrupted).toBe(false);
    // The run finishes (success), it does not raise another interrupt for
    // the same question, and it does not error out.
    expect(events.some((e) => e.type === "RUN_ERROR")).toBe(false);
  }, 60_000);

  it("answerQuestion() answers multi-select and free-text ('Other') questions and the run resumes", async () => {
    const thread = newThread();
    for await (const _ of thread.send("Use the AskUserQuestion tool now.")) {
      // Drain.
    }

    expect(thread.isInterrupted).toBe(true);
    const pending = thread.pendingToolCalls.find(isQuestionRequest)!;
    expect(pending).toBeDefined();

    // internal/llm/agent/fixture_hitl_agent.go's fixtureQuestionCall always
    // asks exactly two questions: q1 single-select ("Environment", options
    // Staging/Production), q2 multiSelect:true ("Frameworks", options
    // React/Vue/Svelte). "Other" is a client-side affordance available on
    // every question regardless of multiSelect (ask_user_question.go's
    // formatQuestionsAsText), so q1 exercises it here alongside q2's
    // multi-select answer -- both paths the acceptance criterion asks for,
    // in one round trip.
    const questionArgs = pending.args;
    expect(questionArgs.questions).toHaveLength(2);
    expect(questionArgs.questions[1]!.multiSelect).toBe(true);

    const events = [];
    for await (const event of thread.resume(
      pending.id,
      answerQuestion({
        answers: [
          {
            questionId: "q1",
            header: questionArgs.questions[0]!.header,
            selected: [questionArgs.questions[0]!.options[0]!.label],
            otherText: "Also curious about a canary environment",
          },
          {
            questionId: "q2",
            header: questionArgs.questions[1]!.header,
            selected: [
              questionArgs.questions[1]!.options[0]!.label,
              questionArgs.questions[1]!.options[1]!.label,
            ],
          },
        ],
      }),
    )) {
      events.push(event);
    }

    expect(thread.isInterrupted).toBe(false);
    expect(events.some((e) => e.type === "RUN_ERROR")).toBe(false);
  }, 60_000);
});
