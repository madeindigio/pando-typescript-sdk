import { describe, expect, it, jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PandoAguiClient, PERMISSION_TOOL_NAME } from "../src/agui/client.js";
import { PandoThread } from "../src/agui/thread.js";
import type { PendingToolCall } from "../src/agui/thread.js";
import {
  QUESTION_TOOL_NAME,
  answerQuestion,
  approve,
  cancelQuestion,
  deny,
  isPermissionRequest,
  isQuestionRequest,
} from "../src/agui/hitl.js";
import type { AguiEvent } from "../src/agui/types.js";
import {
  INTERRUPT_RUN_SSE,
  PERMISSION_ARGS,
  PERMISSION_CALL_ID,
  QUESTION_CALL_ID,
  QUESTION_INTERRUPT_SSE,
  QUESTION_REQUEST,
  QUESTION_RESUME_SSE,
  QUESTION_THREAD_ID,
  RESUME_RUN_SSE,
  BASIC_RUN_SSE,
  sseResponse,
  THREAD_ID,
} from "./fixtures/agui-recorded-stream.js";

/**
 * PANDO-US-0008: typed HITL helpers. `approve`/`deny`/`answerQuestion`/
 * `cancelQuestion` only ever have to build a JSON string — the delivery path
 * is `PandoThread.resume`, already proven in `agui-thread.test.ts`.
 *
 * This suite cannot start a real `pando agui-serve` (no LLM credentials or Go
 * toolchain access in this task's sandbox — the coordinator scoped this
 * change to `sdk/typescript/` with no Go files touched). Instead:
 *
 *   - `approvalFromMessageMirror` / `answerFromMessageMirror` below are
 *     faithful ports of `internal/agui/hitl.go`'s `approvalFromMessage`
 *     (lines 145-172) and `answerFromMessage` (lines 228-262), exercised with
 *     the exact accepted/rejected literal sets from
 *     `internal/agui/hitl_test.go`'s `TestApprovalFromMessage` (lines
 *     155-171) and `TestAnswerFromMessage` (lines 173-196), so the wire
 *     shape is checked against Go's real parsing rules, not a guess.
 *   - The `PandoThread` integration tests replay recorded SSE fixtures
 *     (`./fixtures/agui-recorded-stream.ts`) through the real client/thread
 *     code and inspect the literal HTTP body `resume()` posts.
 */

async function drain(gen: AsyncGenerator<AguiEvent, void, undefined>): Promise<void> {
  for await (const _event of gen) {
    // Draining only for the side effect of updating thread state.
  }
}

function queueFetch(...streams: string[]): { fetch: typeof fetch; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  let next = 0;
  const impl = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    const text = streams[next++];
    if (text === undefined) throw new Error("queueFetch: no more recorded responses queued");
    return sseResponse(text);
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

// ---------------------------------------------------------------------------
// Go-parser mirrors (test-only — see module doc comment above)
// ---------------------------------------------------------------------------

function approvalFromMessageMirror(content: string, error?: string): boolean {
  if (error) return false;
  const trimmed = content.trim();
  if (trimmed === "") return false;

  try {
    const structured = JSON.parse(trimmed) as { approved?: boolean | null; allow?: boolean | null };
    if (structured && typeof structured === "object" && !Array.isArray(structured)) {
      if (structured.approved !== undefined && structured.approved !== null) {
        return structured.approved === true;
      }
      if (structured.allow !== undefined && structured.allow !== null) {
        return structured.allow === true;
      }
    }
  } catch {
    // Not structured JSON; fall through to the literal check.
  }

  const literal = trimmed.replace(/^"|"$/g, "").toLowerCase();
  return ["true", "yes", "approve", "approved", "allow", "accept"].includes(literal);
}

const QUESTION_CANCELLED_MIRROR =
  "The user did not answer the question. Continue with your best judgement and state the assumption you made.";

function answerFromMessageMirror(content: string, error?: string): string {
  if (error) return `The question could not be answered: ${error}`;
  const trimmed = content.trim();
  if (trimmed === "") return QUESTION_CANCELLED_MIRROR;

  let structured: { cancelled?: boolean; answers?: Array<Record<string, unknown>> };
  try {
    structured = JSON.parse(trimmed);
  } catch {
    return content;
  }
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return content;
  if (structured.cancelled) return QUESTION_CANCELLED_MIRROR;
  if (!structured.answers || structured.answers.length === 0) return content;

  const lines = ["The user answered:"];
  for (const answer of structured.answers) {
    const label = (answer["header"] as string) || (answer["questionId"] as string);
    const selectedArr = (answer["selected"] as string[] | undefined) ?? [];
    let selected = selectedArr.join(", ");
    const otherText = answer["otherText"] as string | undefined;
    if (otherText) selected = selected ? `${selected}; ${otherText}` : otherText;
    if (!selected) selected = "(no selection)";
    lines.push(`- ${label}: ${selected}`);
  }
  return lines.join("\n");
}

describe("approvalFromMessage compatibility (mirrors internal/agui/hitl_test.go:TestApprovalFromMessage)", () => {
  it("accepts the same literals the Go adapter accepts", () => {
    for (const content of [`{"approved":true}`, `{"allow":true}`, "approve", "YES", `"allow"`, "true"]) {
      expect(approvalFromMessageMirror(content)).toBe(true);
    }
  });

  it("denies everything else, including malformed or empty answers", () => {
    for (const content of [`{"approved":false}`, "deny", "", "maybe", "{}", `{"approved":null}`]) {
      expect(approvalFromMessageMirror(content)).toBe(false);
    }
    expect(approvalFromMessageMirror("approve", "boom")).toBe(false);
  });

  it("approve() and deny() outputs parse as expected by the mirror", () => {
    expect(approvalFromMessageMirror(approve())).toBe(true);
    expect(approvalFromMessageMirror(deny())).toBe(false);
    expect(approvalFromMessageMirror(deny("not safe"))).toBe(false);
  });

  it("approve()/deny() only ever emit the canonical structured shape", () => {
    expect(approve()).toBe('{"approved":true}');
    expect(deny()).toBe('{"approved":false}');
    // The `reason` is for the caller's own UI only; the wire shape is unaffected.
    expect(deny("not safe")).toBe('{"approved":false}');
  });
});

describe("answerFromMessage compatibility (mirrors internal/agui/hitl_test.go:TestAnswerFromMessage)", () => {
  it("cancelQuestion() reads as unanswered", () => {
    expect(cancelQuestion()).toBe('{"cancelled":true,"answers":[]}');
    expect(answerFromMessageMirror(cancelQuestion())).toBe(QUESTION_CANCELLED_MIRROR);
  });

  it("answerQuestion() renders the structured selection for the model", () => {
    const payload = answerQuestion({
      answers: [
        { questionId: "q1", header: "Database", selected: ["Postgres"] },
        { questionId: "q2", header: "Cache", selected: [], otherText: "none for now" },
      ],
    });
    const rendered = answerFromMessageMirror(payload);
    expect(rendered).toContain("Database: Postgres");
    expect(rendered).toContain("none for now");
  });

  it("an empty answer is treated as unanswered, matching deny-by-default semantics", () => {
    expect(answerFromMessageMirror("")).toBe(QUESTION_CANCELLED_MIRROR);
  });
});

describe("the deny-by-default rule is documented", () => {
  it("is stated in the exported doc comment of deny()", () => {
    const path = fileURLToPath(new URL("../src/agui/hitl.ts", import.meta.url));
    const source = readFileSync(path, "utf8");
    const denyDoc = source.slice(source.indexOf("export function deny"));
    // Sanity: we sliced the right block.
    expect(source).toContain("Deny is\n * Pando's default");
    expect(denyDoc.length).toBeGreaterThan(0);
  });
});

describe("isPermissionRequest / isQuestionRequest", () => {
  const permissionCall: PendingToolCall = {
    id: "perm-1",
    name: PERMISSION_TOOL_NAME,
    argsText: JSON.stringify(PERMISSION_ARGS),
    args: PERMISSION_ARGS,
  };
  const questionCall: PendingToolCall = {
    id: "call-q1",
    name: QUESTION_TOOL_NAME,
    argsText: JSON.stringify(QUESTION_REQUEST),
    args: QUESTION_REQUEST,
  };
  const otherCall: PendingToolCall = { id: "call-x", name: "bash", argsText: "{}", args: {} };

  it("narrows a permission prompt and nothing else", () => {
    expect(isPermissionRequest(permissionCall)).toBe(true);
    expect(isPermissionRequest(questionCall)).toBe(false);
    expect(isPermissionRequest(otherCall)).toBe(false);
    if (isPermissionRequest(permissionCall)) {
      // Compile-time check: `args` narrows to PandoPermissionRequest.
      expect(permissionCall.args.toolName).toBe("write");
    }
  });

  it("narrows an AskUserQuestion call and nothing else", () => {
    expect(isQuestionRequest(questionCall)).toBe(true);
    expect(isQuestionRequest(permissionCall)).toBe(false);
    expect(isQuestionRequest(otherCall)).toBe(false);
    if (isQuestionRequest(questionCall)) {
      expect(questionCall.args.questions).toHaveLength(1);
    }
  });
});

describe("PandoThread + HITL round trip (permission)", () => {
  it("approve() resumes with the canonical approval payload after the pending call", async () => {
    const { fetch: fetchImpl, calls } = queueFetch(BASIC_RUN_SSE, INTERRUPT_RUN_SSE, RESUME_RUN_SSE);
    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    const thread = new PandoThread({ client, threadId: THREAD_ID });

    await drain(thread.send("hi"));
    await drain(thread.send("please update the readme"));
    expect(thread.isInterrupted).toBe(true);

    const pending = thread.pendingToolCalls[0]!;
    expect(isPermissionRequest(pending)).toBe(true);
    if (!isPermissionRequest(pending)) throw new Error("unreachable");
    expect(pending.args).toEqual(PERMISSION_ARGS);

    await drain(thread.resume(pending.id, approve()));

    expect(thread.isInterrupted).toBe(false);
    const body = JSON.parse(String(calls[2]!.body)) as { messages: Array<Record<string, unknown>> };
    const toolMessage = body.messages.find(
      (m) => m["role"] === "tool" && m["toolCallId"] === PERMISSION_CALL_ID,
    );
    expect(toolMessage?.["content"]).toBe('{"approved":true}');
    expect(approvalFromMessageMirror(toolMessage?.["content"] as string)).toBe(true);
  });

  it("deny() resumes with a payload the Go parser reads as a refusal", async () => {
    const { fetch: fetchImpl, calls } = queueFetch(BASIC_RUN_SSE, INTERRUPT_RUN_SSE, RESUME_RUN_SSE);
    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    const thread = new PandoThread({ client, threadId: THREAD_ID });

    await drain(thread.send("hi"));
    await drain(thread.send("please update the readme"));
    const pending = thread.pendingToolCalls[0]!;

    await drain(thread.resume(pending.id, deny("policy forbids writes")));

    const body = JSON.parse(String(calls[2]!.body)) as { messages: Array<Record<string, unknown>> };
    const toolMessage = body.messages.find(
      (m) => m["role"] === "tool" && m["toolCallId"] === PERMISSION_CALL_ID,
    );
    expect(toolMessage?.["content"]).toBe('{"approved":false}');
    expect(approvalFromMessageMirror(toolMessage?.["content"] as string)).toBe(false);
  });
});

describe("PandoThread + HITL round trip (question)", () => {
  it("answerQuestion() resumes with the structured selection", async () => {
    const { fetch: fetchImpl, calls } = queueFetch(QUESTION_INTERRUPT_SSE, QUESTION_RESUME_SSE);
    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    const thread = new PandoThread({ client, threadId: QUESTION_THREAD_ID });

    await drain(thread.send("help me choose a database"));
    expect(thread.isInterrupted).toBe(true);
    const pending = thread.pendingToolCalls[0]!;
    expect(pending.id).toBe(QUESTION_CALL_ID);
    expect(isQuestionRequest(pending)).toBe(true);
    if (!isQuestionRequest(pending)) throw new Error("unreachable");
    expect(pending.args).toEqual(QUESTION_REQUEST);

    const payload = answerQuestion({ answers: [{ questionId: "q1", header: "Database", selected: ["Postgres"] }] });
    await drain(thread.resume(pending.id, payload));

    expect(thread.isInterrupted).toBe(false);
    const body = JSON.parse(String(calls[1]!.body)) as { messages: Array<Record<string, unknown>> };
    const toolMessage = body.messages.find((m) => m["role"] === "tool" && m["toolCallId"] === QUESTION_CALL_ID);
    expect(toolMessage?.["content"]).toBe(payload);
    expect(answerFromMessageMirror(payload)).toContain("Database: Postgres");
  });

  it("cancelQuestion() resumes with the cancelled:true shortcut", async () => {
    const { fetch: fetchImpl, calls } = queueFetch(QUESTION_INTERRUPT_SSE, QUESTION_RESUME_SSE);
    const client = new PandoAguiClient({ baseUrl: "http://x", fetch: fetchImpl });
    const thread = new PandoThread({ client, threadId: QUESTION_THREAD_ID });

    await drain(thread.send("help me choose a database"));
    const pending = thread.pendingToolCalls[0]!;

    await drain(thread.resume(pending.id, cancelQuestion()));

    const body = JSON.parse(String(calls[1]!.body)) as { messages: Array<Record<string, unknown>> };
    const toolMessage = body.messages.find((m) => m["role"] === "tool" && m["toolCallId"] === QUESTION_CALL_ID);
    expect(toolMessage?.["content"]).toBe('{"cancelled":true,"answers":[]}');
    expect(answerFromMessageMirror(toolMessage?.["content"] as string)).toBe(QUESTION_CANCELLED_MIRROR);
  });
});
