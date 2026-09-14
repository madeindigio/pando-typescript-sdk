/**
 * SSE fixtures for the `PandoThread` / HITL helper tests (PANDO-US-0007,
 * PANDO-US-0008).
 *
 * These are not constructed as `AguiEvent` objects handed straight to the
 * reducer: they are serialized SSE frames, exactly the bytes a real
 * `pando agui-serve` connection sends, so the tests exercise the same
 * `parseSSE` -> `PandoThread` path a browser does. The event shapes and
 * ordering mirror what `internal/agui/translate.go`, `internal/agui/state.go`
 * and `internal/agui/hitl.go` actually produce for a two-turn conversation:
 *
 *   1. `BASIC_RUN_SSE`   — a plain turn: reasoning, text, a tool call with its
 *      result, and a `/todos` + `/tokenUsage` + `/files/-` `STATE_DELTA`
 *      sequence (`internal/agui/state.go:252-336`), plus one `CUSTOM` signal.
 *   2. `INTERRUPT_RUN_SSE` — a second turn that raises a permission prompt
 *      (`internal/agui/hitl.go:71-93`) and suspends with
 *      `RUN_FINISHED{outcome:"interrupt"}`.
 *   3. `RESUME_RUN_SSE` — the run resumed after the prompt is answered
 *      (`internal/agui/server.go:356-383`): a fresh `RUN_STARTED`/
 *      `STATE_SNAPSHOT`, the final assistant text, and a `STATE_DELTA`
 *      `replace` on the file entry the permission unlocked.
 */

export const THREAD_ID = "t1";

const INITIAL_SNAPSHOT = {
  thread: THREAD_ID,
  session: "s1",
  agent: "coder",
  model: { id: "gpt-x", name: "GPT X", provider: "openai", contextWindow: 128000 },
  todos: [],
  tokenUsage: null,
  files: [],
  subAgents: [],
};

export const TODOS_AFTER_BASIC_RUN = [{ id: "t1", content: "Check docs", status: "in_progress" }];

export const TOKEN_USAGE_AFTER_BASIC_RUN = {
  promptTokens: 120,
  completionTokens: 40,
  contextWindow: 128000,
  estimated: false,
};

export const FILE_AFTER_BASIC_RUN = { path: "README.md", name: "README.md", action: "read" };

export const PERMISSION_CALL_ID = "perm-abc123";

export const PERMISSION_ARGS = {
  toolName: "write",
  action: "execute",
  description: "Write README.md",
  path: "README.md",
  params: { content: "# README\n\nUpdated." },
};

/** Renders one SSE frame the way `internal/agui/sse.go` writes it on the wire. */
function frame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export const BASIC_RUN_SSE =
  frame({ type: "RUN_STARTED", threadId: THREAD_ID, runId: "r1" }) +
  frame({ type: "STATE_SNAPSHOT", snapshot: INITIAL_SNAPSHOT }) +
  frame({ type: "REASONING_START", messageId: "r1-msg" }) +
  frame({ type: "REASONING_MESSAGE_START", messageId: "r1-msg", role: "assistant" }) +
  frame({ type: "REASONING_MESSAGE_CONTENT", messageId: "r1-msg", delta: "Let me check " }) +
  frame({ type: "REASONING_MESSAGE_CONTENT", messageId: "r1-msg", delta: "the docs." }) +
  frame({ type: "REASONING_MESSAGE_END", messageId: "r1-msg" }) +
  frame({ type: "REASONING_END", messageId: "r1-msg" }) +
  frame({ type: "TEXT_MESSAGE_START", messageId: "r1-msg", role: "assistant" }) +
  frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "r1-msg", delta: "Hello" }) +
  frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "r1-msg", delta: " there" }) +
  frame({
    type: "TOOL_CALL_START",
    toolCallId: "call-1",
    toolCallName: "view",
    parentMessageId: "r1-msg",
  }) +
  frame({ type: "TOOL_CALL_ARGS", toolCallId: "call-1", delta: '{"file_path":"README.md"}' }) +
  frame({ type: "TOOL_CALL_END", toolCallId: "call-1" }) +
  frame({
    type: "TOOL_CALL_RESULT",
    messageId: "r1-toolresult-1",
    toolCallId: "call-1",
    content: "# README\n\nOriginal contents.",
    role: "tool",
  }) +
  frame({
    type: "STATE_DELTA",
    delta: [{ op: "replace", path: "/todos", value: TODOS_AFTER_BASIC_RUN }],
  }) +
  frame({
    type: "STATE_DELTA",
    delta: [{ op: "replace", path: "/tokenUsage", value: TOKEN_USAGE_AFTER_BASIC_RUN }],
  }) +
  frame({
    type: "STATE_DELTA",
    delta: [{ op: "add", path: "/files/-", value: FILE_AFTER_BASIC_RUN }],
  }) +
  frame({ type: "CUSTOM", name: "pando.summarize", value: { progress: 0.5, done: false } }) +
  frame({ type: "TEXT_MESSAGE_END", messageId: "r1-msg" }) +
  frame({ type: "RUN_FINISHED", threadId: THREAD_ID, runId: "r1", outcome: "success", result: "Hello there" });

const SNAPSHOT_AFTER_BASIC_RUN = {
  ...INITIAL_SNAPSHOT,
  todos: TODOS_AFTER_BASIC_RUN,
  tokenUsage: TOKEN_USAGE_AFTER_BASIC_RUN,
  files: [FILE_AFTER_BASIC_RUN],
};

export const INTERRUPT_RUN_SSE =
  frame({ type: "RUN_STARTED", threadId: THREAD_ID, runId: "r2" }) +
  frame({ type: "STATE_SNAPSHOT", snapshot: SNAPSHOT_AFTER_BASIC_RUN }) +
  frame({ type: "TEXT_MESSAGE_START", messageId: "r2-msg", role: "assistant" }) +
  frame({
    type: "TEXT_MESSAGE_CONTENT",
    messageId: "r2-msg",
    delta: "I will update the README; let me confirm first.",
  }) +
  // A permission prompt has no counterpart in the agent's own stream, so the
  // adapter synthesizes it with no `parentMessageId`
  // (`NewToolCallStart(callID, permissionToolName, "")`, `hitl.go:78` — an
  // empty string is `omitempty` and drops the key entirely on the wire).
  frame({
    type: "TOOL_CALL_START",
    toolCallId: PERMISSION_CALL_ID,
    toolCallName: "pando_permission_request",
  }) +
  frame({ type: "TOOL_CALL_ARGS", toolCallId: PERMISSION_CALL_ID, delta: JSON.stringify(PERMISSION_ARGS) }) +
  frame({ type: "TOOL_CALL_END", toolCallId: PERMISSION_CALL_ID }) +
  frame({ type: "TEXT_MESSAGE_END", messageId: "r2-msg" }) +
  frame({ type: "RUN_FINISHED", threadId: THREAD_ID, runId: "r2", outcome: "interrupt" });

export const FILE_AFTER_RESUME = { path: "README.md", name: "README.md", action: "write" };

export const RESUME_RUN_SSE =
  frame({ type: "RUN_STARTED", threadId: THREAD_ID, runId: "r3" }) +
  frame({ type: "STATE_SNAPSHOT", snapshot: SNAPSHOT_AFTER_BASIC_RUN }) +
  frame({ type: "TEXT_MESSAGE_START", messageId: "r3-msg", role: "assistant" }) +
  frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "r3-msg", delta: "Done, README.md updated." }) +
  frame({
    type: "STATE_DELTA",
    delta: [{ op: "replace", path: "/files/0", value: FILE_AFTER_RESUME }],
  }) +
  frame({ type: "TEXT_MESSAGE_END", messageId: "r3-msg" }) +
  frame({
    type: "RUN_FINISHED",
    threadId: THREAD_ID,
    runId: "r3",
    outcome: "success",
    result: "Done, README.md updated.",
  });

// ---------------------------------------------------------------------------
// A question prompt (real `AskUserQuestion` call, PANDO-US-0008)
// ---------------------------------------------------------------------------

export const QUESTION_THREAD_ID = "t2";
export const QUESTION_CALL_ID = "call-q1";

export const QUESTION_REQUEST = {
  questions: [
    {
      question: "Which database should we use?",
      header: "Database",
      multiSelect: false,
      options: [
        { label: "Postgres", description: "Relational, strong consistency." },
        { label: "SQLite", description: "Embedded, zero-ops." },
      ],
    },
  ],
};

const QUESTION_SNAPSHOT = {
  thread: QUESTION_THREAD_ID,
  session: "s2",
  agent: "coder",
  model: { id: "gpt-x" },
  todos: [],
  tokenUsage: null,
  files: [],
  subAgents: [],
};

// Unlike the synthetic permission call, `AskUserQuestion` is a real tool call
// (`internal/agui/hitl.go:190-220`): its START carries the run's ordinary
// `parentMessageId`, same as any other tool the agent calls.
export const QUESTION_INTERRUPT_SSE =
  frame({ type: "RUN_STARTED", threadId: QUESTION_THREAD_ID, runId: "q1" }) +
  frame({ type: "STATE_SNAPSHOT", snapshot: QUESTION_SNAPSHOT }) +
  frame({ type: "TEXT_MESSAGE_START", messageId: "q1-msg", role: "assistant" }) +
  frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "q1-msg", delta: "Let me ask you something first." }) +
  frame({
    type: "TOOL_CALL_START",
    toolCallId: QUESTION_CALL_ID,
    toolCallName: "AskUserQuestion",
    parentMessageId: "q1-msg",
  }) +
  frame({ type: "TOOL_CALL_ARGS", toolCallId: QUESTION_CALL_ID, delta: JSON.stringify(QUESTION_REQUEST) }) +
  frame({ type: "TOOL_CALL_END", toolCallId: QUESTION_CALL_ID }) +
  frame({ type: "TEXT_MESSAGE_END", messageId: "q1-msg" }) +
  frame({ type: "RUN_FINISHED", threadId: QUESTION_THREAD_ID, runId: "q1", outcome: "interrupt" });

export const QUESTION_RESUME_SSE =
  frame({ type: "RUN_STARTED", threadId: QUESTION_THREAD_ID, runId: "q2" }) +
  frame({ type: "STATE_SNAPSHOT", snapshot: QUESTION_SNAPSHOT }) +
  frame({ type: "TEXT_MESSAGE_START", messageId: "q2-msg", role: "assistant" }) +
  frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "q2-msg", delta: "Great, using Postgres." }) +
  frame({ type: "TEXT_MESSAGE_END", messageId: "q2-msg" }) +
  frame({
    type: "RUN_FINISHED",
    threadId: QUESTION_THREAD_ID,
    runId: "q2",
    outcome: "success",
    result: "Great, using Postgres.",
  });

/** Builds a `Response` streaming `text` as its body, byte for byte. */
export function sseResponse(text: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}
