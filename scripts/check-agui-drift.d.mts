/**
 * Type declarations for `check-agui-drift.mjs`, consumed by
 * `tests/agui-drift.test.ts` via dynamic `import()`. Kept as a hand-written
 * `.d.mts` (TypeScript's convention for typing a plain `.mjs` module) rather
 * than converting the script itself to `.ts`: the script has to run standalone
 * with plain `node`, with no build step, in both local dev and CI.
 */

export interface AguiDriftSources {
  eventsGoSource: string;
  inputGoSource: string;
  typesTsSource: string;
}

export interface AguiDriftResult {
  missingEventInterfaces: string[];
  missingRunAgentInputFields: string[];
  missingMessageFields: string[];
}

export function parseGoEventConstants(source: string): Set<string>;
export function parseGoStructJSONFields(source: string, structName: string): Set<string>;
export function parseTsPinnedEventTypes(source: string): Set<string>;
export function parseTsInterfaceFields(source: string, interfaceName: string): Set<string>;
export function computeAguiDrift(sources: AguiDriftSources): AguiDriftResult;
export function isClean(drift: AguiDriftResult): boolean;
