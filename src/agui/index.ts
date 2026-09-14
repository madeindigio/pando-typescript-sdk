/**
 * `@pando-ai/sdk/agui` — AG-UI protocol client for Pando.
 *
 * AG-UI (https://docs.ag-ui.com) is the wire contract CopilotKit and other
 * Generative-UI frontends speak to agent backends. Pando serves it from
 * `pando serve --agui-port` or the standalone `pando agui-serve` process; this
 * subpath is the typed client for it.
 *
 * The subpath is separate so the main entry point stays untouched: nothing here
 * is loaded — or bundled — unless you import it.
 *
 * This entry re-exports both halves of the surface (the plain client and the
 * CopilotKit glue) for existing consumers. For a browser build where dead
 * CopilotKit weight and its dynamic peer-loading `import()` matter (e.g. a
 * Vite app), import the narrower subpaths instead:
 *  - `@pando-ai/sdk/agui/client` — `PandoAguiClient` + protocol types only.
 *  - `@pando-ai/sdk/agui/copilotkit` — `createPandoAgent`,
 *    `discoverPandoAgents`, `registerPandoCopilotKit`.
 *
 * @example Stream a run without CopilotKit
 * ```typescript
 * import { PandoAguiClient } from '@pando-ai/sdk/agui';
 *
 * const client = new PandoAguiClient({
 *   baseUrl: 'http://localhost:8090',
 *   token: process.env.PANDO_TOKEN,
 * });
 *
 * for await (const event of client.run({ prompt: 'Summarise the repo' })) {
 *   if (event.type === 'TEXT_MESSAGE_CONTENT') process.stdout.write(event.delta);
 * }
 * ```
 *
 * @example Back a CopilotKit route with every agent Pando advertises
 * ```typescript
 * import { registerPandoCopilotKit } from '@pando-ai/sdk/agui';
 *
 * export const { POST, GET, OPTIONS } = await registerPandoCopilotKit({
 *   baseUrl: process.env.PANDO_URL!,
 *   token: process.env.PANDO_TOKEN,
 * });
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

export { PandoThread, applyJsonPatch } from "./thread.js";
export type {
  PandoThreadOptions,
  PandoThreadRunOptions,
  PandoCustomEvent,
  PendingToolCall,
} from "./thread.js";

export {
  QUESTION_TOOL_NAME,
  isPermissionRequest,
  isQuestionRequest,
  approve,
  deny,
  answerQuestion,
  cancelQuestion,
} from "./hitl.js";
export type {
  PandoQuestion,
  PandoQuestionOption,
  PandoQuestionRequest,
  PandoQuestionAnswer,
  PandoQuestionAnswerEntry,
  PandoPermissionPendingCall,
  PandoQuestionPendingCall,
} from "./hitl.js";

export {
  createPandoAgent,
  discoverPandoAgents,
  registerPandoCopilotKit,
} from "./copilotkit.js";
export type {
  CreatePandoAgentOptions,
  RegisterPandoCopilotKitOptions,
  PandoCopilotKitRoute,
  CopilotKitRuntimeModule,
  HttpAgentLike,
  HttpAgentConstructor,
} from "./copilotkit.js";

export type * from "./types.js";
