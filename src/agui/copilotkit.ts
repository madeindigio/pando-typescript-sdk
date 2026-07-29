/**
 * CopilotKit glue for Pando's AG-UI endpoint.
 *
 * Two levels of convenience:
 *
 *  - {@link createPandoAgent} builds one `HttpAgent` pointed at a Pando agent,
 *    with the bearer token already attached. Use it when you want to own the
 *    `CopilotRuntime` yourself.
 *  - {@link registerPandoCopilotKit} builds the whole Next.js route: it reads
 *    `/info`, registers every agent Pando advertises, and returns the request
 *    handler (P7).
 *
 * Neither `@ag-ui/client` nor `@copilotkit/runtime` is a dependency of
 * `@pando-ai/sdk`: they are optional peers of this subpath only. Both functions
 * import them on demand, and both accept them injected instead — which is what
 * you want under a bundler, since a dynamic import of a variable specifier
 * cannot be statically analysed.
 */

import { PandoError } from "../exceptions.js";
import { PandoAguiClient, DEFAULT_AGUI_PATH } from "./client.js";
import type { PandoAguiClientOptions } from "./client.js";
import type { AguiAgentDescriptor } from "./types.js";

/**
 * The part of `@ag-ui/client`'s `HttpAgent` this module relies on: it is
 * constructed with a URL and headers. Typing it structurally keeps the peer
 * dependency out of the build.
 */
export interface HttpAgentLike {
  url: string;
}

export type HttpAgentConstructor = new (config: {
  url: string;
  headers?: Record<string, string>;
  agentId?: string;
  description?: string;
}) => HttpAgentLike;

export interface CreatePandoAgentOptions {
  /** Origin of the adapter, e.g. `http://localhost:8090`. */
  baseUrl: string;
  /** Agent name as advertised by `/info`. Defaults to `coder`. */
  agent?: string;
  /** Route prefix. Defaults to `/api/v1/agui`. */
  path?: string;
  /** Bearer token. Required unless the server runs with `--no-token`. */
  token?: string | undefined;
  headers?: Record<string, string>;
  /**
   * `HttpAgent` from `@ag-ui/client`. Pass it explicitly in bundled
   * environments (Next.js, Vite); omitted, it is imported at runtime.
   */
  HttpAgent?: HttpAgentConstructor;
}

/**
 * Builds an AG-UI `HttpAgent` for one Pando agent.
 *
 * @example
 * ```typescript
 * import { HttpAgent } from '@ag-ui/client';
 * import { createPandoAgent } from '@pando-ai/sdk/agui';
 *
 * const pando = await createPandoAgent({
 *   baseUrl: 'http://localhost:8090',
 *   token: process.env.PANDO_TOKEN,
 *   HttpAgent,
 * });
 * ```
 */
export async function createPandoAgent(
  options: CreatePandoAgentOptions,
): Promise<HttpAgentLike> {
  const Agent = options.HttpAgent ?? (await loadHttpAgent());
  const base = options.baseUrl.replace(/\/+$/, "");
  const path = (options.path ?? DEFAULT_AGUI_PATH).replace(/\/+$/, "");
  const agent = options.agent ?? "coder";

  return new Agent({
    url: `${base}${path}/${agent}`,
    headers: authHeaders(options.token, options.headers),
    agentId: agent,
  });
}

/**
 * Builds an `HttpAgent` for every agent `/info` advertises, keyed by name — the
 * shape `CopilotRuntime`'s `agents` option expects.
 *
 * The URLs come from the server, so an agent served on its own port or behind a
 * proxy is reached at the address it reports rather than one guessed here.
 */
export async function discoverPandoAgents(
  options: CreatePandoAgentOptions & { client?: PandoAguiClient },
): Promise<Record<string, HttpAgentLike>> {
  const Agent = options.HttpAgent ?? (await loadHttpAgent());
  const client =
    options.client ??
    new PandoAguiClient({
      baseUrl: options.baseUrl,
      ...(options.path ? { path: options.path } : {}),
      token: options.token,
      ...(options.headers ? { headers: options.headers } : {}),
    } satisfies PandoAguiClientOptions);

  const info = await client.info();
  const headers = authHeaders(options.token, options.headers);
  const agents: Record<string, HttpAgentLike> = {};

  for (const descriptor of info.agents ?? []) {
    agents[descriptor.name] = new Agent({
      url: agentUrl(descriptor, options.baseUrl),
      headers,
      agentId: descriptor.name,
      ...(descriptor.description ? { description: descriptor.description } : {}),
    });
  }
  if (Object.keys(agents).length === 0) {
    throw new PandoError(
      `${options.baseUrl} advertises no AG-UI agents; check the [AGUI] Agents setting`,
    );
  }
  return agents;
}

/**
 * `/info` reports absolute URLs built from the Host header. Behind a proxy that
 * rewrites it, that host can be unreachable from this process, so the origin the
 * caller configured wins and only the path is taken from discovery.
 */
function agentUrl(descriptor: AguiAgentDescriptor, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  try {
    return base + new URL(descriptor.url).pathname;
  } catch {
    return descriptor.url;
  }
}

// ---------------------------------------------------------------------------
// Mastra-style one-liner route (P7)
// ---------------------------------------------------------------------------

/**
 * Minimal shape of `@copilotkit/runtime`'s pieces used here.
 *
 * The parameters are deliberately untyped. CopilotKit's real signatures are far
 * more specific than what this module needs, and they change between minor
 * versions; a precise structural type here would reject the actual module — the
 * exact opposite of the point. The call sites below are what pins the contract.
 */
export interface CopilotKitRuntimeModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  CopilotRuntime: new (config: any) => unknown;
  copilotRuntimeNextJSAppRouterEndpoint: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: any,
  ) => { handleRequest: CopilotKitRequestHandler };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ExperimentalEmptyAdapter: new (...args: any[]) => unknown;
}

/** Next.js accepts either a sync or an async route handler. */
export type CopilotKitRequestHandler = (
  req: Request,
) => Response | Promise<Response>;

export interface RegisterPandoCopilotKitOptions extends CreatePandoAgentOptions {
  /**
   * Route this handler is mounted on. It must match the file's own path, since
   * CopilotKit's client posts to it. Defaults to `/api/copilotkit`.
   */
  endpoint?: string;
  /**
   * Agents to expose. Omitted, every agent `/info` advertises is registered.
   */
  agents?: Record<string, HttpAgentLike>;
  /**
   * `@copilotkit/runtime`. Pass it explicitly under a bundler; omitted, it is
   * imported at runtime.
   */
  runtimeModule?: CopilotKitRuntimeModule;
  /**
   * Service adapter. Defaults to `ExperimentalEmptyAdapter`, which is correct
   * here: the agent, not the runtime, owns the model.
   */
  serviceAdapter?: unknown;
}

/** What a Next.js App Router route file re-exports. */
export interface PandoCopilotKitRoute {
  POST: CopilotKitRequestHandler;
  GET: CopilotKitRequestHandler;
  OPTIONS: CopilotKitRequestHandler;
  /** The agents that were registered, for logging or tests. */
  agents: Record<string, HttpAgentLike>;
}

/**
 * Mounts a CopilotKit endpoint backed by Pando in one call.
 *
 * @example
 * ```typescript
 * // app/api/copilotkit/route.ts
 * import { registerPandoCopilotKit } from '@pando-ai/sdk/agui';
 *
 * const route = await registerPandoCopilotKit({
 *   baseUrl: process.env.PANDO_URL!,
 *   token: process.env.PANDO_TOKEN,
 * });
 *
 * export const { POST, GET, OPTIONS } = route;
 * ```
 *
 * Note this still runs inside your Node/edge server: it removes the boilerplate,
 * not the hop. CopilotKit's runtime protocol is GraphQL, which Pando's Go server
 * deliberately does not implement — the adapter speaks AG-UI, the protocol every
 * other backend speaks, and CopilotKit's own runtime does the translation.
 */
export async function registerPandoCopilotKit(
  options: RegisterPandoCopilotKitOptions,
): Promise<PandoCopilotKitRoute> {
  const runtimeModule = options.runtimeModule ?? (await loadCopilotRuntime());
  const agents = options.agents ?? (await discoverPandoAgents(options));

  const runtime = new runtimeModule.CopilotRuntime({ agents });
  const serviceAdapter =
    options.serviceAdapter ?? new runtimeModule.ExperimentalEmptyAdapter();

  const { handleRequest } = runtimeModule.copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter,
    endpoint: options.endpoint ?? "/api/copilotkit",
  });

  return { POST: handleRequest, GET: handleRequest, OPTIONS: handleRequest, agents };
}

// ---------------------------------------------------------------------------
// Optional peer loading
// ---------------------------------------------------------------------------

function authHeaders(
  token: string | undefined,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

async function loadHttpAgent(): Promise<HttpAgentConstructor> {
  const mod = await importOptional<{ HttpAgent?: HttpAgentConstructor }>(
    "@ag-ui/client",
    "createPandoAgent",
  );
  if (!mod.HttpAgent) {
    throw new PandoError("@ag-ui/client does not export HttpAgent");
  }
  return mod.HttpAgent;
}

async function loadCopilotRuntime(): Promise<CopilotKitRuntimeModule> {
  return importOptional<CopilotKitRuntimeModule>(
    "@copilotkit/runtime",
    "registerPandoCopilotKit",
  );
}

/**
 * Imports an optional peer, turning a missing package into an actionable error
 * instead of a bare MODULE_NOT_FOUND.
 *
 * The specifier is a variable on purpose: a static import would make the peer a
 * hard dependency of every consumer of this subpath.
 */
async function importOptional<T>(specifier: string, caller: string): Promise<T> {
  try {
    return (await import(/* @vite-ignore */ specifier)) as T;
  } catch (error) {
    throw new PandoError(
      `${caller} requires the optional peer "${specifier}". ` +
        `Install it (npm i ${specifier}) or pass the module in explicitly. ` +
        `Original error: ${(error as Error).message}`,
    );
  }
}
