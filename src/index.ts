/**
 * @pando-ai/sdk — TypeScript/Node.js SDK for the Pando AI coding assistant.
 *
 * Pando operates in three modes:
 * 1. **Subprocess mode** ({@link PandoClient}): one-shot `pando -p "..."` runs.
 * 2. **ACP stdio mode** ({@link PandoAgent} + {@link PandoSession}): long-lived
 *    JSON-RPC 2.0 session over stdin/stdout.
 * 3. **HTTP REST mode** ({@link PandoHttpClient}): connects to a running
 *    `pando serve` or `pando app` instance.
 *
 * @example Subprocess mode
 * ```typescript
 * import { PandoClient } from '@pando-ai/sdk';
 *
 * const client = new PandoClient({ cwd: '/project' });
 * const result = await client.run('Fix lint errors', { allowAllTools: true });
 * console.log(result.response);
 * ```
 *
 * @example ACP stdio mode
 * ```typescript
 * import { PandoAgent } from '@pando-ai/sdk';
 *
 * const agent = new PandoAgent({ cwd: '/project', persona: 'software-engineer' });
 * await agent.connect();
 *
 * const session = await agent.createSession('Refactoring');
 * for await (const event of session.send('Refactor the auth module')) {
 *   if (event.type === 'content_delta') process.stdout.write(event.delta);
 * }
 *
 * await agent.disconnect();
 * ```
 *
 * @example HTTP REST mode
 * ```typescript
 * import { PandoHttpClient } from '@pando-ai/sdk';
 *
 * const client = new PandoHttpClient({ baseUrl: 'http://localhost:8765' });
 * const sessions = await client.sessions.list();
 * ```
 *
 * @module @pando-ai/sdk
 */

// Main clients
export { PandoClient } from "./client.js";
export type { PandoClientOptions, RunOptions } from "./client.js";

export { PandoAgent } from "./agent.js";
export type { PandoAgentOptions } from "./agent.js";

export { PandoSession } from "./session.js";
export type { SendOptions } from "./session.js";

export { PandoHttpClient, SessionsClient, ModelsClient, PersonasClient } from "./http.js";
export type { PandoHttpClientOptions } from "./http.js";

// Transport (advanced usage)
export { JsonRpcTransport, findPandoBinary } from "./transport.js";
export type { TransportOptions } from "./transport.js";

// Error classes
export {
  PandoError,
  PandoBinaryNotFoundError,
  PandoConnectionError,
  PandoSessionError,
  PandoTimeoutError,
  PandoRPCError,
} from "./exceptions.js";

// Types and interfaces
export type {
  // Events
  AgentEvent,
  ContentDeltaEvent,
  ThinkingDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  ResponseEvent,
  ErrorEvent,
  SummarizeEvent,
  // Data types
  ToolCall,
  ToolResult,
  Message,
  // Permission
  PermissionRequest,
  PermissionCallback,
  // Session / model / persona info
  SessionInfo,
  ModelInfo,
  PersonaInfo,
  // Run result
  RunResult,
  // HTTP streaming
  HttpSession,
  HttpStreamChunk,
  // JSON-RPC wire types
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcErrorResponse,
  JsonRpcNotification,
  JsonRpcMessage,
  AgentEventParams,
} from "./types.js";

// Event utilities
export { parseAgentEvent, isTerminalEvent, collectResponse } from "./events.js";
