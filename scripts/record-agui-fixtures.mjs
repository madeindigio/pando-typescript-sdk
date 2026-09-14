#!/usr/bin/env node
/**
 * PANDO-US-0010 — AG-UI fixture recorder.
 *
 * Spawns `pando agui-serve --no-tls` on loopback, drives one or more real
 * runs against it, and writes each run's raw SSE response body — byte for
 * byte, exactly as the wire sent it — to `tests/fixtures/agui/<name>.sse`.
 *
 * This script is NOT part of CI (per PANDO-US-0010: "the recorder is not
 * part of CI") and is not invoked by `npm test`. It is a maintainer tool: run
 * it by hand, inspect the diff, commit the fixtures. See the SDK README's
 * "Recording AG-UI fixtures" section.
 *
 * Requirements to actually run it (none of these are needed to read or
 * replay the already-committed fixtures — only to regenerate them):
 *   - A `pando` binary on PATH, or PANDO_BIN pointing at one (built from the
 *     `pando` monorepo this package normally lives inside: `go build -o
 *     <path> .` from the repo root).
 *   - A configured LLM provider (API key/credentials) for the project
 *     directory PANDO_AGUI_RECORD_CWD points at (or the current directory) —
 *     driving a real agent run needs one. `--agent coder` is the default.
 *
 * Usage:
 *   node scripts/record-agui-fixtures.mjs
 *   PANDO_BIN=/path/to/pando node scripts/record-agui-fixtures.mjs
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "../tests/fixtures/agui");

const PANDO_BIN = process.env.PANDO_BIN ?? "pando";
const HOST = "127.0.0.1";
const PORT = Number(process.env.PANDO_AGUI_RECORD_PORT ?? 8199);
const TOKEN = "recorder-fixed-token";
const AGENT = process.env.PANDO_AGUI_RECORD_AGENT ?? "coder";
const CWD = process.env.PANDO_AGUI_RECORD_CWD ?? process.cwd();
const BASE_URL = `http://${HOST}:${PORT}`;
const RUN_URL = `${BASE_URL}/api/v1/agui/${AGENT}`;

/**
 * One scenario to record. `prompt` is sent as the sole user message on a
 * fresh thread; the raw response body is written verbatim to `file`.
 *
 * These prompts are *suggestions*, not scripted determinism: a real model's
 * wording, tool choice and turn count will vary run to run (that is the
 * whole point of recording against a live server instead of hand-writing
 * more fixtures). Re-run and inspect the diff before committing.
 */
const SCENARIOS = [
  {
    file: "interrupt-frontend-tool.sse",
    prompt: "Call the get_weather tool for Madrid, then tell me what it returned.",
    tools: [
      {
        name: "get_weather",
        description: "Look up the current weather for a city.",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
  },
  {
    file: "state-delta-todos-tokenusage-files.sse",
    prompt:
      "Read the README in this project, then write a two-item todo list summarizing what it covers.",
  },
];

async function waitForServer(timeoutMs = 20_000) {
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

async function recordScenario(scenario) {
  const threadId = `record-${scenario.file.replace(/\.sse$/, "")}-${Date.now()}`;
  const body = {
    threadId,
    runId: `${threadId}-run-1`,
    messages: [{ id: `${threadId}-msg-1`, role: "user", content: scenario.prompt }],
    ...(scenario.tools ? { tools: scenario.tools } : {}),
  };

  const res = await fetch(RUN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    throw new Error(`recording "${scenario.file}" failed: HTTP ${res.status}`);
  }

  // Byte-for-byte capture: no parsing, no reformatting. The point of a
  // recorder is to write what the wire actually sent.
  const chunks = [];
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = Buffer.concat(chunks.map((c) => Buffer.from(c)));

  mkdirSync(FIXTURES_DIR, { recursive: true });
  const outPath = resolve(FIXTURES_DIR, scenario.file);
  writeFileSync(outPath, raw);
  console.log(`recorded ${scenario.file} (${raw.length} bytes) from thread ${threadId}`);
}

function spawnServer() {
  const args = [
    "agui-serve",
    "--no-tls",
    "--host",
    HOST,
    "--port",
    String(PORT),
    "--cwd",
    CWD,
    "--agent",
    AGENT,
    "--token",
    TOKEN,
    // Fixtures must not pause on a permission prompt mid-recording; the
    // permission/question round trip is covered separately by the live
    // integration test (tests/agui-integration.test.ts), not by these
    // replay fixtures.
    "--auto-approve",
  ];
  console.log(`spawning: ${PANDO_BIN} ${args.join(" ")}`);
  const child = spawn(PANDO_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => process.stdout.write(`[agui-serve] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[agui-serve] ${d}`));
  return child;
}

async function main() {
  const server = spawnServer();
  const serverExit = new Promise((_resolve, reject) => {
    server.once("error", reject);
    server.once("exit", (code) => {
      if (code !== null && code !== 0) reject(new Error(`pando agui-serve exited with code ${code}`));
    });
  });

  try {
    await Promise.race([waitForServer(), serverExit]);
    for (const scenario of SCENARIOS) {
      await recordScenario(scenario);
    }
  } finally {
    server.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error("record-agui-fixtures failed:", error instanceof Error ? error.message : error);
  console.error(
    "This script needs a `pando` binary (PANDO_BIN) and a configured LLM provider " +
      "for the target --cwd; see the SDK README's \"Recording AG-UI fixtures\" section.",
  );
  process.exitCode = 1;
});
