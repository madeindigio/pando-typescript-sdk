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
npm run build      # produces dist/index.js (ESM) and dist/index.cjs (CJS)
npm test           # run Jest tests
npm run typecheck  # TypeScript type checking only
```
