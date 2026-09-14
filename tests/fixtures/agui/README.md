# AG-UI recorded fixtures

Raw SSE byte streams (`*.sse`), one Server-Sent-Events response body per file, in
the exact wire format `internal/agui/sse.go`'s `SSEWriter` writes
(`data: <json>\n\n` per event, no `event:` field — AG-UI puts the discriminator
inside the JSON payload). Produced by `scripts/record-agui-fixtures.mjs`
(PANDO-US-0010) against a real `pando agui-serve --no-tls` instance — see the
SDK README's "Recording AG-UI fixtures" section for how to run it.

## Files

- `interrupt-frontend-tool.sse` — a run where the agent calls a
  browser-declared frontend tool (`get_weather`) and the run suspends:
  `RUN_FINISHED{outcome:"interrupt"}` with one pending `TOOL_CALL_*` sequence.
- `resume-frontend-tool.sse` — the same thread's next run, after the browser
  answered the tool call: a fresh `RUN_STARTED`/`STATE_SNAPSHOT`, the final
  assistant text, `RUN_FINISHED{outcome:"success"}`.
- `state-delta-todos-tokenusage-files.sse` — one run whose `STATE_DELTA`
  sequence covers all three shapes `internal/agui/state.go` emits: a
  `replace` on `/todos`, a `replace` on `/tokenUsage`, and an `add` on
  `/files/-`.

## Provenance note (2026-09-14)

These three files were hand-authored to the exact Go wire format above,
**not captured from a live `pando agui-serve` run** — this task's sandbox had
no LLM provider credentials configured (driving a real agent run needs one)
and `internal/agui` was being edited concurrently by other agents at the time,
so a live capture would have been unrepeatable anyway. The event shapes,
field names and ordering were verified line-by-line against
`internal/agui/translate.go`, `state.go`, `frontend_tool.go` and `sse.go`
rather than guessed. Regenerate them for real with the recorder script
(`npm run record:agui-fixtures` from `sdk/typescript`) the next time a
maintainer has both a Go toolchain and a configured provider on hand — the
replay tests in `tests/agui-fixtures.test.ts` only assert on the *shape* AG-UI
guarantees (event ordering, `STATE_DELTA` application, the resume request
body), so swapping these files for a genuine capture should not require test
changes.
