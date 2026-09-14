#!/usr/bin/env node
/**
 * PANDO-US-0006 CI smoke test.
 *
 * Builds `@pando-ai/sdk`, links it into this fixture's own Vite + React 18
 * app via a `file:` dependency, runs `vite build`, and fails (non-zero exit)
 * unless ALL of the following hold:
 *
 *   1. The SDK package builds cleanly.
 *   2. The fixture's `vite build` exits 0.
 *   3. The build output carries zero bundler warnings.
 *   4. The build output mentions no `node:` / polyfill resolution.
 *   5. The built bundle contains no "copilotkit" string anywhere.
 *
 * Run it directly with `node tests/browser-build/run.mjs`, or via
 * `npm run test:browser-build` from `sdk/typescript`. This is intended to be
 * wired into CI as a dedicated job/step (outside this package's own
 * fast unit-test run).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const sdkDir = path.resolve(fixtureDir, "..", "..");

const failures = [];

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  failures.push(message);
  process.stderr.write(`✗ ${message}\n`);
}

function run(command, args, cwd) {
  log(`\n$ (${path.relative(sdkDir, cwd) || "."}) ${command} ${args.join(" ")}`);
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
  });
}

// ---------------------------------------------------------------------------
// 1. Build the SDK package itself so `dist/` (and its exports map targets)
//    exist for the fixture to link against.
// ---------------------------------------------------------------------------

log("== Building @pando-ai/sdk ==");
run("npm", ["run", "build"], sdkDir);

if (!existsSync(path.join(sdkDir, "dist", "agui", "client-entry.js"))) {
  fail("sdk build did not produce dist/agui/client-entry.js");
}

// ---------------------------------------------------------------------------
// 2. Install the fixture's own dependencies (vite, react, and the SDK via a
//    `file:` link), then run its `vite build`.
// ---------------------------------------------------------------------------

const fixtureDist = path.join(fixtureDir, "dist");
if (existsSync(fixtureDist)) rmSync(fixtureDist, { recursive: true, force: true });

log("\n== Installing browser-build fixture dependencies ==");
run("npm", ["install", "--no-audit", "--no-fund"], fixtureDir);

log("\n== Running vite build ==");
const buildResult = spawnSync("npm", ["run", "build", "--silent"], {
  cwd: fixtureDir,
  encoding: "utf8",
  env: { ...process.env, CI: "true" },
});
const buildOutput = `${buildResult.stdout ?? ""}${buildResult.stderr ?? ""}`;
log(buildOutput);

if (buildResult.status !== 0) {
  fail(`vite build exited with status ${buildResult.status}`);
}

// ---------------------------------------------------------------------------
// 3. The build output itself must carry zero warnings and zero node:/polyfill
//    resolution chatter.
// ---------------------------------------------------------------------------

const warningPatterns = [
  /\bwarn(ing)?\b/i,
  /^\(!\)/m,
  /externalized for browser compatibility/i,
  /could not resolve/i,
  /module level directives/i,
];
for (const pattern of warningPatterns) {
  if (pattern.test(buildOutput)) {
    fail(`build output matched a warning pattern (${pattern}); see log above`);
  }
}

if (/\bnode:/i.test(buildOutput)) {
  fail("build output mentions a node: specifier");
}

// ---------------------------------------------------------------------------
// 4. The built bundle must contain no reference to CopilotKit and no
//    unresolved `node:` specifier.
// ---------------------------------------------------------------------------

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

if (!existsSync(fixtureDist)) {
  fail("vite build produced no dist/ directory");
} else {
  const builtFiles = listFilesRecursive(fixtureDist).filter((f) =>
    /\.(js|mjs|cjs|html)$/.test(f)
  );
  if (builtFiles.length === 0) {
    fail("vite build produced no .js/.html output files");
  }
  for (const file of builtFiles) {
    const content = readFileSync(file, "utf8");
    const rel = path.relative(fixtureDist, file);
    if (/copilotkit/i.test(content)) {
      fail(`${rel} contains the string "copilotkit"`);
    }
    if (/\bnode:[a-z_]+/i.test(content)) {
      fail(`${rel} contains an unresolved node: specifier`);
    }
  }
  if (failures.length === 0) {
    log(`\nChecked ${builtFiles.length} built file(s): no "copilotkit", no "node:".`);
  }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

if (failures.length > 0) {
  process.stderr.write(`\nFAIL: ${failures.length} check(s) failed:\n`);
  for (const f of failures) process.stderr.write(`  - ${f}\n`);
  process.exit(1);
}

log("\nPASS: @pando-ai/sdk/agui/client builds clean in Vite + React 18, zero warnings.");
