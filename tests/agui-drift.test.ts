import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * PANDO-US-0009 — the AG-UI protocol drift check.
 *
 * `scripts/check-agui-drift.mjs` parses `internal/agui/events.go` and
 * `internal/agui/input.go` at check time and diffs them against
 * `src/agui/types.ts`, rather than against a committed snapshot: the Go
 * adapter is edited concurrently with this SDK work, so a snapshot would go
 * stale immediately. This suite therefore runs the check against the real,
 * live Go source in this checkout (a regression guard: it must stay clean),
 * and separately proves the mutation case the acceptance criteria ask for —
 * "a deliberate test mutation of events.go makes the job red" — by feeding
 * the parser a mutated copy of the real source text, with no filesystem
 * writes and no dependency on CI wiring.
 */

const goDir = fileURLToPath(new URL("../../../internal/agui/", import.meta.url));
const typesTsPath = fileURLToPath(new URL("../src/agui/types.ts", import.meta.url));

// Only meaningful inside the `pando` monorepo checkout this package normally
// lives in (see scripts/check-agui-drift.mjs's module doc comment). Skips
// cleanly when the Go source is not on disk, e.g. a standalone SDK clone.
function goSourceAvailable(): boolean {
  try {
    readFileSync(`${goDir}events.go`, "utf8");
    readFileSync(`${goDir}input.go`, "utf8");
    return true;
  } catch {
    return false;
  }
}

const describeIfGoSource = goSourceAvailable() ? describe : describe.skip;

describeIfGoSource("agui drift check against the real Go source", () => {
  it("reports no drift between internal/agui and src/agui/types.ts", async () => {
    const { computeAguiDrift, isClean } = await import("../scripts/check-agui-drift.mjs");

    const eventsGoSource = readFileSync(`${goDir}events.go`, "utf8");
    const inputGoSource = readFileSync(`${goDir}input.go`, "utf8");
    const typesTsSource = readFileSync(typesTsPath, "utf8");

    const drift = computeAguiDrift({ eventsGoSource, inputGoSource, typesTsSource });
    expect(drift.missingEventInterfaces).toEqual([]);
    expect(drift.missingRunAgentInputFields).toEqual([]);
    expect(drift.missingMessageFields).toEqual([]);
    expect(isClean(drift)).toBe(true);
  });
});

describe("agui drift check parsing (unit, no filesystem)", () => {
  const eventsGoFixture = `
package agui

const (
	EventTextMessageStart EventType = "TEXT_MESSAGE_START"
	EventRunStarted       EventType = "RUN_STARTED"
)
`;

  const inputGoFixture = `
package agui

type RunAgentInput struct {
	ThreadID       string    \`json:"threadId"\`
	RunID          string    \`json:"runId"\`
	ParentRunID    string    \`json:"parentRunId,omitempty"\`
	ForwardedProps any       \`json:"forwardedProps,omitempty"\`
}

type Message struct {
	ID           string \`json:"id"\`
	Role         string \`json:"role"\`
	ActivityType string \`json:"activityType,omitempty"\`
}
`;

  const typesTsFixtureClean = `
export interface RunStartedEvent {
  type: "RUN_STARTED";
}

export interface TextMessageStartEvent {
  type: "TEXT_MESSAGE_START";
}

export interface RunAgentInput {
  threadId: string;
  runId: string;
  parentRunId?: string;
  forwardedProps?: unknown;
}

export interface AguiMessage {
  id: string;
  role: string;
  activityType?: string;
}
`;

  it("reports clean when every Go constant and field has a TS counterpart", async () => {
    const { computeAguiDrift, isClean } = await import("../scripts/check-agui-drift.mjs");
    const drift = computeAguiDrift({
      eventsGoSource: eventsGoFixture,
      inputGoSource: inputGoFixture,
      typesTsSource: typesTsFixtureClean,
    });
    expect(isClean(drift)).toBe(true);
  });

  it("goes red when events.go gains a constant with no TypeScript interface (deliberate mutation)", async () => {
    const { computeAguiDrift, isClean } = await import("../scripts/check-agui-drift.mjs");

    // The deliberate mutation: a new event constant the TS side has never
    // heard of, exactly the scenario the acceptance criteria describe.
    const mutatedEventsGo =
      eventsGoFixture + `\nconst EventFooBarBaz EventType = "FOO_BAR_BAZ"\n`;

    const drift = computeAguiDrift({
      eventsGoSource: mutatedEventsGo,
      inputGoSource: inputGoFixture,
      typesTsSource: typesTsFixtureClean,
    });

    expect(isClean(drift)).toBe(false);
    expect(drift.missingEventInterfaces).toEqual(["FOO_BAR_BAZ"]);
  });

  it("goes red when input.go gains a RunAgentInput field missing from the TS interface", async () => {
    const { computeAguiDrift, isClean } = await import("../scripts/check-agui-drift.mjs");

    const mutatedInputGo = inputGoFixture.replace(
      "type RunAgentInput struct {",
      'type RunAgentInput struct {\n\tNewField string `json:"newField,omitempty"`',
    );

    const drift = computeAguiDrift({
      eventsGoSource: eventsGoFixture,
      inputGoSource: mutatedInputGo,
      typesTsSource: typesTsFixtureClean,
    });

    expect(isClean(drift)).toBe(false);
    expect(drift.missingRunAgentInputFields).toEqual(["newField"]);
  });

  it("goes red when input.go's Message struct gains a field missing from AguiMessage", async () => {
    const { computeAguiDrift, isClean } = await import("../scripts/check-agui-drift.mjs");

    const mutatedInputGo = inputGoFixture.replace(
      "type Message struct {",
      'type Message struct {\n\tNewField string `json:"newMessageField,omitempty"`',
    );

    const drift = computeAguiDrift({
      eventsGoSource: eventsGoFixture,
      inputGoSource: mutatedInputGo,
      typesTsSource: typesTsFixtureClean,
    });

    expect(isClean(drift)).toBe(false);
    expect(drift.missingMessageFields).toEqual(["newMessageField"]);
  });
});
