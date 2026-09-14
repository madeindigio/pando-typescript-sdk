/**
 * `@pando-ai/sdk/agui/hitl` — typed answers for Pando's two human-in-the-loop
 * shapes: permission prompts and `AskUserQuestion`.
 *
 * Both interrupt a `PandoThread` run as a pending tool call
 * (`internal/agui/hitl.go`, see `./thread.js`). The helpers here only build
 * the tool-result payload string; none of them touch the transcript or the
 * network — deliver the result with `PandoThread.resume(toolCallId, result)`.
 */

import { PERMISSION_TOOL_NAME } from "./client.js";
import type { PandoPermissionAnswer, PandoPermissionRequest } from "./client.js";
import type { PendingToolCall } from "./thread.js";

/**
 * The tool name a question prompt arrives as, mirroring
 * `tools.AskUserQuestionToolName` (`internal/llm/tools/ask_user_question.go:12`).
 * The adapter substitutes a client-blocking implementation but keeps the
 * tool's identity and schema unchanged (`internal/agui/hitl.go:176-220`), so
 * this is the same name the model itself sees.
 */
export const QUESTION_TOOL_NAME = "AskUserQuestion";

/** One selectable option of a {@link PandoQuestion}. */
export interface PandoQuestionOption {
  label: string;
  description: string;
}

/** One question, mirroring `AskUserQuestionParamQuestion` (`ask_user_question.go:41-46`). */
export interface PandoQuestion {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: PandoQuestionOption[];
}

/**
 * Arguments of a {@link QUESTION_TOOL_NAME} call, mirroring
 * `AskUserQuestionParams` (`internal/llm/tools/ask_user_question.go:37-39`).
 */
export interface PandoQuestionRequest {
  questions: PandoQuestion[];
}

/** One answered question, mirroring the decoder in `internal/agui/hitl.go:240-247`. */
export interface PandoQuestionAnswerEntry {
  questionId: string;
  header?: string;
  selected: string[];
  otherText?: string;
}

/**
 * Answer shape the adapter accepts for a question prompt
 * (`answerFromMessage`, `internal/agui/hitl.go:228-262`). `cancelled: true`
 * reads as "the user did not answer" regardless of what `answers` carries —
 * it mirrors the same fail-closed default a permission prompt has: nothing
 * here is ever inferred as an answer unless it is explicit.
 */
export interface PandoQuestionAnswer {
  cancelled?: boolean;
  answers: PandoQuestionAnswerEntry[];
}

/** A pending tool call known to be Pando's synthetic permission prompt. */
export interface PandoPermissionPendingCall extends PendingToolCall {
  name: typeof PERMISSION_TOOL_NAME;
  args: PandoPermissionRequest;
}

/** A pending tool call known to be a real `AskUserQuestion` call. */
export interface PandoQuestionPendingCall extends PendingToolCall {
  name: typeof QUESTION_TOOL_NAME;
  args: PandoQuestionRequest;
}

/** Narrows a `PandoThread.pendingToolCalls` entry to a permission prompt. */
export function isPermissionRequest(call: PendingToolCall): call is PandoPermissionPendingCall {
  return call.name === PERMISSION_TOOL_NAME;
}

/** Narrows a `PandoThread.pendingToolCalls` entry to an `AskUserQuestion` call. */
export function isQuestionRequest(call: PendingToolCall): call is PandoQuestionPendingCall {
  return call.name === QUESTION_TOOL_NAME;
}

/**
 * Approves a permission prompt.
 *
 * Returns the canonical `{"approved":true}` JSON string
 * `approvalFromMessage` (`internal/agui/hitl.go:145-172`) accepts. The
 * server also tolerates looser forms (`"yes"`, `"allow"`, …) from other
 * clients, but this helper only ever emits the one canonical shape.
 */
export function approve(): string {
  const answer: PandoPermissionAnswer = { approved: true };
  return JSON.stringify(answer);
}

/**
 * Denies a permission prompt.
 *
 * Returns the canonical `{"approved":false}` JSON string. **Deny is
 * Pando's default**: `approvalFromMessage` (`internal/agui/hitl.go:145-172`)
 * treats anything that is not an explicit approval — a malformed answer,
 * prose, a client error, a timeout, or no answer at all — as a denial. Call
 * this helper explicitly when you have one, but know that simply not
 * answering (letting the 10-minute suspension window elapse,
 * `internal/agui/frontend_tool.go:41`) denies just the same.
 *
 * `reason` is accepted for the caller's own UI/audit trail only: the wire
 * shape Pando parses has no field for it, so it is never sent.
 */
export function deny(reason?: string): string {
  void reason;
  const answer: PandoPermissionAnswer = { approved: false };
  return JSON.stringify(answer);
}

/**
 * Answers an `AskUserQuestion` prompt with the structured form
 * (`internal/agui/hitl.go:228-262`).
 */
export function answerQuestion(answer: PandoQuestionAnswer): string {
  return JSON.stringify(answer);
}

/**
 * Shortcut for `answerQuestion({cancelled: true, answers: []})` — the
 * question equivalent of a denial: the model proceeds on its own judgement
 * (`questionCancelled`, `internal/agui/hitl.go:222-225`).
 */
export function cancelQuestion(): string {
  return answerQuestion({ cancelled: true, answers: [] });
}
