# @pando-ai/sdk

TypeScript/Node.js SDK for the [Pando](https://github.com/digiogithub/pando) AI coding assistant.

## Prerequisites

- Node.js 18+
- The `pando` CLI installed and available on your PATH (or set `PANDO_PATH`)

## Installation

```bash
npm install @pando-ai/sdk
```

## Quick start

```typescript
import { PandoAgent } from '@pando-ai/sdk';

const agent = new PandoAgent({ cwd: '/path/to/project' });
await agent.connect();

const session = await agent.createSession('Fix lint errors');
const response = await session.ask('Fix all TypeScript errors in the project');
console.log(response);

await agent.disconnect();
```

## Modes

### Mode 1: Subprocess (one-shot)

Run `pando -p "..."` for single-turn, non-interactive prompts.

```typescript
import { PandoClient } from '@pando-ai/sdk';

const client = new PandoClient({
  cwd: '/path/to/project',
  model: 'copilot.gpt-5.4',  // optional
  timeout: 300_000,            // 5 minutes
});

// Promise-based
const result = await client.run('Fix all lint errors', { allowAllTools: true });
console.log(result.response); // string

// Streaming text
for await (const chunk of client.stream('Explain this code')) {
  process.stdout.write(chunk);
}
```

### Mode 2: ACP stdio (persistent sessions)

Long-lived JSON-RPC 2.0 session over stdin/stdout. Best for multi-turn conversations and streaming.

```typescript
import { PandoAgent } from '@pando-ai/sdk';

const agent = new PandoAgent({
  cwd: '/path/to/project',
  model: 'claude-sonnet-4-6',
  persona: 'software-engineer',
  onToolPermission: async (req) => {
    console.log(`Approve ${req.toolName}?`);
    return true; // approve all
  },
});

await agent.connect();

// Create a session
const session = await agent.createSession('Refactoring task');

// Stream events
for await (const event of session.send('Refactor the database layer')) {
  switch (event.type) {
    case 'content_delta':
      process.stdout.write(event.delta);
      break;
    case 'tool_call':
      console.log('\n[Tool]', event.toolCall.name);
      break;
    case 'tool_result':
      console.log('[Result]', event.toolResult.content.slice(0, 100));
      break;
    case 'response':
      console.log('\n[Done]');
      break;
    case 'error':
      throw new Error(event.error);
  }
}

await session.close();
await agent.disconnect();
```

#### Using `await using` (Symbol.asyncDispose)

```typescript
await using agent = new PandoAgent({ cwd: '/project' });
await agent.connect();

const session = await agent.createSession('task');
const result = await session.ask('What files have TODO comments?');
console.log(result);
// agent.disconnect() is called automatically on scope exit
```

#### Managing sessions

```typescript
// List all sessions
const sessions = await agent.listSessions();

// Load an existing session
const session = await agent.loadSession(sessions[0].sessionId);

// Continue the conversation
const response = await session.ask('Continue where we left off');

// Manage personas
const personas = await agent.listPersonas();
// ['assistant', 'software-engineer', 'qa', 'system-engineer']

await session.setPersona('qa');

// Cancel an in-progress run
await session.cancel();
```

### Mode 3: HTTP REST

Connect to a running `pando serve` or `pando app` instance.

```typescript
import { PandoHttpClient } from '@pando-ai/sdk';

const client = new PandoHttpClient({
  baseUrl: 'http://localhost:8765',
  rejectUnauthorized: false, // for self-signed TLS certs
  apiToken: 'your-token',    // optional
  timeout: 60_000,
});

// Health check
const healthy = await client.health();

// Sessions
const session = await client.sessions.create('Task title');
const sessions = await client.sessions.list();
await client.sessions.rename(session.id, 'New title');

// Streaming messages (SSE)
for await (const chunk of client.sessions.sendMessage(session.id, 'Fix lint')) {
  if (chunk.event === 'content_delta') {
    process.stdout.write(chunk.delta ?? '');
  }
  if (chunk.event === 'done') break;
}

// Reconnect to an in-progress session
for await (const chunk of client.sessions.streamSession(session.id)) {
  process.stdout.write(chunk.delta ?? '');
}

// Models
const models = await client.models.list();
await client.models.setActive('claude-sonnet-4-6');

// Personas
const personas = await client.personas.list();
await client.personas.setActive('software-engineer');
```

### Mode 4: AG-UI (`@pando-ai/sdk/agui`)

[AG-UI](https://docs.ag-ui.com) is the protocol CopilotKit and other Generative-UI
frontends speak to agent backends. Pando serves it from `pando agui-serve --port 8090`
(or `pando serve --agui-port 8090`); it is **off by default** and requires a bearer
token and an origin allow-list, because it exposes a code-executing agent to a browser.

This is a **separate subpath export**: importing the main entry point pulls in none of
it, and `@ag-ui/client` / `@copilotkit/runtime` are optional peers of the subpath only.

```typescript
import { PandoAguiClient } from '@pando-ai/sdk/agui';

const client = new PandoAguiClient({
  baseUrl: 'http://localhost:8090',
  token: process.env.PANDO_TOKEN,
  agent: 'coder',
});

// Discovery: which agents exist, their model, which capabilities are on
const info = await client.info();

for await (const event of client.run({ prompt: 'Summarise the repo' })) {
  switch (event.type) {
    case 'TEXT_MESSAGE_CONTENT':
      process.stdout.write(event.delta);
      break;
    case 'STATE_SNAPSHOT':
      console.log(event.snapshot.todos, event.snapshot.subAgents);
      break;
    case 'RUN_FINISHED':
      if (event.outcome === 'interrupt') {
        // The agent called one of your `tools`: run it, then call `run` again on
        // the same thread with a `tool` message carrying the result.
      }
      break;
  }
}
```

With CopilotKit, in a Next.js route:

```typescript
// app/api/copilotkit/route.ts
import { registerPandoCopilotKit } from '@pando-ai/sdk/agui';

export const { POST, GET, OPTIONS } = await registerPandoCopilotKit({
  baseUrl: process.env.PANDO_URL!,
  token: process.env.PANDO_TOKEN,
});
```

`registerPandoCopilotKit` reads `/info` and registers every agent Pando advertises. Under
a bundler, pass `HttpAgent` and `runtimeModule` explicitly so the peers are resolved
statically. A full example — chat, shared-state dashboard, a frontend tool and in-page
approvals — is in [`examples/copilotkit/`](../../examples/copilotkit/).

| Export | Purpose |
|---|---|
| `PandoAguiClient` | Dependency-free run/discovery client (`run`, `runText`, `info`) |
| `createPandoAgent` | One `HttpAgent` for one Pando agent, token attached |
| `discoverPandoAgents` | Every advertised agent, keyed by name, for `CopilotRuntime` |
| `registerPandoCopilotKit` | The whole Next.js route in one call |
| `PandoState` | Type of the shared-state document (`useCoAgent<PandoState>()`) |
| `parseSSE` | The event-stream parser, if you issue the request yourself |

#### Recording AG-UI fixtures

The agui test suite (`tests/agui*.test.ts`) mostly replays committed SSE fixtures —
`tests/fixtures/agui/*.sse`, raw byte-for-byte response bodies, plus the hand-built
event sequences in `tests/fixtures/agui-recorded-stream.ts` — so it runs offline, with
no network and no live server. To regenerate the `.sse` fixtures from a real
`pando agui-serve` instance instead of hand-editing them:

```bash
# Needs a `pando` binary (PANDO_BIN, defaults to `pando` on PATH — build one from
# the `pando` monorepo with `go build -o /path/to/pando .`) and a configured LLM
# provider for the target directory (PANDO_AGUI_RECORD_CWD, defaults to the
# current directory) — driving a real agent run needs one.
npm run record:agui-fixtures
```

`scripts/record-agui-fixtures.mjs` spawns `pando agui-serve --no-tls` on loopback,
posts a couple of real prompts to it, and writes each run's raw SSE response body
verbatim to `tests/fixtures/agui/<name>.sse` — no parsing, no reformatting, exactly
the bytes the wire sent. It is **not** part of CI and is not invoked by `npm test`:
it is a maintainer tool, run by hand when the fixtures need to be refreshed (e.g.
`internal/agui`'s event shapes changed). Inspect the diff before committing — a real
model's wording and tool choice vary run to run.

Permission-prompt and `AskUserQuestion` round trips (approve/deny/malformed-answer/
cancel) are instead covered by `tests/agui-integration.test.ts`, a live-server
integration suite gated behind `PANDO_AGUI_INTEGRATION_BIN` (skipped whenever that
binary path is not set — including in CI, which never sets it):

```bash
PANDO_AGUI_INTEGRATION_BIN=/path/to/pando npm test -- agui-integration
```

Separately, `scripts/check-agui-drift.mjs` (`npm run check:agui-drift`) parses
`internal/agui/events.go` and `internal/agui/input.go` directly and diffs them
against `src/agui/types.ts`, failing when a Go event constant or `RunAgentInput`/
`Message` field has no TypeScript counterpart — see that script's module doc
comment for how it locates the Go source.

## TypeScript types reference

### `AgentEvent`

```typescript
type AgentEvent =
  | { type: 'content_delta'; sessionId: string; delta: string }
  | { type: 'thinking_delta'; sessionId: string; delta: string }
  | { type: 'tool_call'; sessionId: string; toolCall: ToolCall }
  | { type: 'tool_result'; sessionId: string; toolResult: ToolResult }
  | { type: 'response'; sessionId: string; message: Message }
  | { type: 'error'; sessionId: string; error: string }
  | { type: 'summarize'; sessionId: string };
```

### `PermissionRequest`

```typescript
interface PermissionRequest {
  sessionId: string;
  toolName: string;
  description: string;
  action: string;
  path: string;
  params: Record<string, unknown>;
}
```

### `RunResult`

```typescript
interface RunResult {
  response: string;
  sessionId: string;
  raw: Record<string, unknown>;
}
```

## Error handling

All SDK errors extend `PandoError`:

```typescript
import {
  PandoError,
  PandoBinaryNotFoundError,
  PandoConnectionError,
  PandoSessionError,
  PandoTimeoutError,
  PandoRPCError,
} from '@pando-ai/sdk';

try {
  await agent.connect();
} catch (err) {
  if (err instanceof PandoBinaryNotFoundError) {
    console.error('Install pando from https://github.com/digiogithub/pando');
  } else if (err instanceof PandoConnectionError) {
    console.error('Connection failed:', err.message, 'exit code:', err.exitCode);
  } else if (err instanceof PandoTimeoutError) {
    console.error('Timed out after', err.timeoutMs, 'ms');
  } else if (err instanceof PandoRPCError) {
    console.error('RPC error', err.code, err.message);
  }
}
```

## Binary resolution

The SDK resolves the `pando` binary in this order:

1. `pandoPath` constructor option
2. `PANDO_PATH` environment variable
3. Each directory in `PATH`

## Building

```bash
npm install
npm run build              # produces dist/index.js (ESM) and dist/index.cjs (CJS)
npm test                   # run Jest tests (includes agui)
npm run typecheck          # TypeScript type checking only
npm run test:bun           # Bun-native test suite (tests/bun/, includes agui)
npm run test:deno          # Deno-native test suite (tests/deno/, includes agui)
npm run test:browser-build # Vite + React 18 fixture build for @pando-ai/sdk/agui/client
npm run check:agui-drift   # diff internal/agui (Go) against src/agui/types.ts
```
