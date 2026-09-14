/**
 * `@pando-ai/sdk/agui/client` — the browser-safe half of the AG-UI subpath.
 *
 * Re-exports only `client.ts` (the transport) and `types.ts` (the protocol
 * types). Nothing here imports `copilotkit.ts`, so this entry never pulls in
 * the CopilotKit surface or its optional-peer dynamic `import()`: a bundler
 * building for the browser (Vite, webpack, esbuild) sees a closed dependency
 * graph with no Node built-ins and no dead CopilotKit weight.
 *
 * For CopilotKit glue (`createPandoAgent`, `registerPandoCopilotKit`, …),
 * import `@pando-ai/sdk/agui/copilotkit` instead. `@pando-ai/sdk/agui` keeps
 * re-exporting both halves for existing consumers.
 *
 * @example
 * ```typescript
 * import { PandoAguiClient } from '@pando-ai/sdk/agui/client';
 *
 * const client = new PandoAguiClient({
 *   baseUrl: 'http://localhost:8090',
 *   token: import.meta.env.VITE_PANDO_TOKEN,
 * });
 *
 * for await (const event of client.run({ prompt: 'Summarise the repo' })) {
 *   if (event.type === 'TEXT_MESSAGE_CONTENT') console.log(event.delta);
 * }
 * ```
 *
 * @module
 */

export {
  PandoAguiClient,
  PandoAguiError,
  parseSSE,
  randomId,
  DEFAULT_AGUI_PATH,
  PERMISSION_TOOL_NAME,
} from "./client.js";
export type {
  PandoAguiClientOptions,
  RunOptions,
  PandoPermissionRequest,
  PandoPermissionAnswer,
} from "./client.js";

export type * from "./types.js";
