#!/usr/bin/env node
/**
 * PANDO-US-0009 — AG-UI protocol drift check.
 *
 * Parses `internal/agui/events.go` and `internal/agui/input.go` (the Go
 * adapter, which is the source of truth for the wire protocol) for event-type
 * constants and struct fields, and diffs them against
 * `sdk/typescript/src/agui/types.ts`. It fails (non-zero exit) when:
 *
 *   - an `EventType` constant declared in `events.go` has no dedicated
 *     TypeScript interface (`type: "THE_CONSTANT";` somewhere in types.ts);
 *   - a `RunAgentInput` JSON field in `input.go` is missing from the TS
 *     `RunAgentInput` interface;
 *   - a `Message` JSON field in `input.go` is missing from the TS
 *     `AguiMessage` interface.
 *
 * This is a text-based diff, not a full Go/TypeScript parser — deliberately:
 * "Generation from Go is acceptable; a diff-only check is the minimum"
 * (PANDO-US-0009). It reads the Go source directly at check time instead of
 * comparing against a committed snapshot, so it never goes stale relative to
 * a moving `internal/agui` (the story explicitly asks for this when the spec
 * allows it, and it does).
 *
 * Usage:
 *   node scripts/check-agui-drift.mjs
 *
 * The Go source directory defaults to `../../internal/agui` relative to this
 * file (this package's usual home inside the `pando` monorepo checkout).
 * Override it with PANDO_AGUI_GO_DIR for a CI job that checked the Go source
 * out elsewhere (this SDK is published from its own repository, so its own
 * standalone CI has no `internal/agui` unless a workflow step fetches it —
 * see `.github/workflows/ci.yml`). When the directory cannot be found at all,
 * the check fails loudly by default; set PANDO_AGUI_DRIFT_ALLOW_MISSING=1 to
 * skip with a warning instead (e.g. for a contributor working on the SDK
 * alone, with no monorepo checkout on disk).
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Go-side parsing
// ---------------------------------------------------------------------------

/**
 * Extracts every `EventType` constant's string value from `events.go`, e.g.
 * `EventRunStarted EventType = "RUN_STARTED"` -> `"RUN_STARTED"`.
 */
export function parseGoEventConstants(source) {
  const out = new Set();
  const re = /\w+\s+EventType\s*=\s*"([A-Z_]+)"/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    out.add(m[1]);
  }
  return out;
}

/**
 * Extracts the JSON field names of one flat Go struct (no nested struct
 * literals), e.g. `type RunAgentInput struct { ThreadID string \`json:"threadId"\` ... }`
 * -> `{"threadId", ...}`. Fields tagged `json:"-"` are skipped.
 */
export function parseGoStructJSONFields(source, structName) {
  const blockRe = new RegExp(`type\\s+${structName}\\s+struct\\s*\\{([\\s\\S]*?)\\n\\}`, "m");
  const block = blockRe.exec(source);
  if (!block) {
    throw new Error(`could not find "type ${structName} struct { ... }" in the given Go source`);
  }
  const out = new Set();
  const fieldRe = /json:"([^",]+)/g;
  let m;
  while ((m = fieldRe.exec(block[1])) !== null) {
    if (m[1] !== "-") out.add(m[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// TypeScript-side parsing
// ---------------------------------------------------------------------------

/**
 * Collects every event name pinned by a dedicated interface in `types.ts`:
 * any `type: "SOME_NAME";` field (as opposed to a bare union member
 * `| "SOME_NAME"`, which only means the name is *known*, not that it has its
 * own interface).
 */
export function parseTsPinnedEventTypes(source) {
  const out = new Set();
  const re = /\btype:\s*"([A-Z_]+)"/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    out.add(m[1]);
  }
  return out;
}

/**
 * Extracts the property names of one flat TypeScript interface (no nested
 * object-literal types spanning multiple lines with their own braces), e.g.
 * `export interface RunAgentInput { threadId: string; runId: string; ... }`
 * -> `{"threadId", "runId", ...}`.
 */
export function parseTsInterfaceFields(source, interfaceName) {
  const blockRe = new RegExp(`interface\\s+${interfaceName}\\s*\\{([\\s\\S]*?)\\n\\}`, "m");
  const block = blockRe.exec(source);
  if (!block) {
    throw new Error(`could not find "interface ${interfaceName} { ... }" in the given TS source`);
  }
  const out = new Set();
  const lines = block[1].split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(trimmed);
    if (m) out.add(m[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * Computes the drift between the Go adapter and the TypeScript declarations.
 * Pure function of the three source texts, so it is trivial to unit-test
 * against a deliberately mutated Go source without touching the filesystem.
 */
export function computeAguiDrift({ eventsGoSource, inputGoSource, typesTsSource }) {
  const goEventTypes = parseGoEventConstants(eventsGoSource);
  const tsPinnedEventTypes = parseTsPinnedEventTypes(typesTsSource);
  const missingEventInterfaces = [...goEventTypes].filter((name) => !tsPinnedEventTypes.has(name)).sort();

  const goRunAgentInputFields = parseGoStructJSONFields(inputGoSource, "RunAgentInput");
  const tsRunAgentInputFields = parseTsInterfaceFields(typesTsSource, "RunAgentInput");
  const missingRunAgentInputFields = [...goRunAgentInputFields]
    .filter((name) => !tsRunAgentInputFields.has(name))
    .sort();

  const goMessageFields = parseGoStructJSONFields(inputGoSource, "Message");
  const tsMessageFields = parseTsInterfaceFields(typesTsSource, "AguiMessage");
  const missingMessageFields = [...goMessageFields].filter((name) => !tsMessageFields.has(name)).sort();

  return { missingEventInterfaces, missingRunAgentInputFields, missingMessageFields };
}

/** `true` when `computeAguiDrift`'s result reports no gap. */
export function isClean(drift) {
  return (
    drift.missingEventInterfaces.length === 0 &&
    drift.missingRunAgentInputFields.length === 0 &&
    drift.missingMessageFields.length === 0
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function resolveGoDir() {
  if (process.env.PANDO_AGUI_GO_DIR) return resolve(process.env.PANDO_AGUI_GO_DIR);
  return resolve(__dirname, "../../../internal/agui");
}

function main() {
  const goDir = resolveGoDir();
  const eventsGoPath = resolve(goDir, "events.go");
  const inputGoPath = resolve(goDir, "input.go");
  const typesTsPath = resolve(__dirname, "../src/agui/types.ts");

  if (!existsSync(eventsGoPath) || !existsSync(inputGoPath)) {
    const message =
      `agui-drift: Go source not found at "${goDir}".\n` +
      `Set PANDO_AGUI_GO_DIR to a checkout of internal/agui (from digiogithub/pando) to run this check.`;
    if (process.env.PANDO_AGUI_DRIFT_ALLOW_MISSING === "1") {
      console.warn(`${message}\nSkipping (PANDO_AGUI_DRIFT_ALLOW_MISSING=1).`);
      process.exit(0);
    }
    console.error(message);
    process.exit(1);
  }

  const eventsGoSource = readFileSync(eventsGoPath, "utf8");
  const inputGoSource = readFileSync(inputGoPath, "utf8");
  const typesTsSource = readFileSync(typesTsPath, "utf8");

  const drift = computeAguiDrift({ eventsGoSource, inputGoSource, typesTsSource });

  if (isClean(drift)) {
    console.log("agui-drift: OK — every events.go constant and input.go field has a TypeScript counterpart.");
    process.exit(0);
  }

  console.error("agui-drift: mismatch between internal/agui (Go) and src/agui/types.ts (TypeScript).\n");
  if (drift.missingEventInterfaces.length > 0) {
    console.error("Event constants with no dedicated TypeScript interface:");
    for (const name of drift.missingEventInterfaces) console.error(`  - ${name}`);
    console.error("");
  }
  if (drift.missingRunAgentInputFields.length > 0) {
    console.error("RunAgentInput fields missing from the TypeScript RunAgentInput interface:");
    for (const name of drift.missingRunAgentInputFields) console.error(`  - ${name}`);
    console.error("");
  }
  if (drift.missingMessageFields.length > 0) {
    console.error("Message fields missing from the TypeScript AguiMessage interface:");
    for (const name of drift.missingMessageFields) console.error(`  - ${name}`);
    console.error("");
  }
  console.error("Update sdk/typescript/src/agui/types.ts to match internal/agui, then rerun this check.");
  process.exit(1);
}

// Only run the CLI when this file is executed directly (not when imported by
// the test suite).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
