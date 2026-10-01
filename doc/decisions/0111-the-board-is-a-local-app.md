# 0111 — The board: a local Next.js app over the log, a task page organised by attempt, and a run log that is a trace

**Status** accepted · 2026-10-01

The board (`apps/board`) is a Next.js application served on loopback for one
person, reading the store directly and updating live over Server-Sent Events;
every control on it appends an event. One work item's page is organised by
attempt, and its control is the prompt the next attempt will be sent, editable
for that attempt only. While a run is going, it writes a log file under
`~/.lingtai/runs/` that anyone can tail with `lingtai attach` or on the task
page — a trace that explains and never settles anything. Gate evidence is plain
text, with terminal escapes stripped at the moment the output is captured.

## Context

The board is where a person finds out what the system did and decides what it
does next, so the diff, the verdicts and the controls have to be on it rather
than on GitHub. A work item can be claimed several times, and the log keeps one
stream per run; a page that flattens them cannot say which attempt a gate, a
cost or a failure belongs to. A running agent is otherwise opaque until it
exits, and the one live view that exists — the hook socket's tool calls — needs
somewhere to go. Gate output arrives coloured even through a pipe, because
`pnpm` sets `FORCE_COLOR`, and escapes cost both readability and the evidence
budget.

## Decision

1. **The board is Next.js (App Router, React 19), and not a static export.**
   Server Components query the store and the projections directly, with no API
   layer; the workspace packages it reaches are compiled by `transpilePackages`
   so an event definition change breaks the board at compile time. `pnpm build`
   ships it as Next's `standalone` output (see
   [0113](0113-distribution-is-a-versioned-binary.md)).
2. **It serves loopback, one person, no authentication.** The port is
   `board.port` in `~/.lingtai/config.yml`, else `BOARD_PORT = 17820`
   (`packages/env`); a value that is not a port number is refused by name.
   `lingtai board` always sets the host to `127.0.0.1`, because Next's default is
   `0.0.0.0`. From a checkout, `pnpm --filter @lingtai/board dev|start`
   (`apps/board/serve.ts`) serves the same port.
3. **Live updates are SSE at `/api/stream`, woken by the store, never by a
   timer.** The route bridges the store's waker; its one `setInterval` is a
   keep-alive comment. The seq is the SSE event id, and a reconnect resumes from
   `Last-Event-ID` exclusive, so a reconnect replays what it missed. The same
   socket carries `health` frames (projection lag and the daemon's beacon). The
   Queued column is the exception: being queued is a fact about GitHub, asked on
   render (`apps/board/src/lib/queued.ts`).
4. **Every control is a Server Action that appends an event**
   (`apps/board/src/app/actions.ts`): approve, answer, requeue, close, edit
   prompt, send attempt, run now, accept or decline a backlog finding, resume.
   The actor is `human:<os username>` (`apps/board/src/lib/actor.ts`). Nothing
   the board decides is silent.
5. **The task page's skeleton is the attempt.** `TaskDetail` carries `runs`,
   oldest first (`apps/board/src/lib/task.ts`); a ledger gives one row per
   attempt, opening into its prompt, files, gates, run log and outcome, and
   money and turns are totalled across them. History is grouped by run and comes
   last.
6. **State and how long it has held come first, as two readings.** The verdict
   block names the one deciding line and the attempt it came from; the whole
   evidence lives in that attempt and is never printed twice. Times are relative
   and dated.
7. **The control is the prompt, and an edit applies to the next run only.**
   `editPrompt` appends `PromptEdited { text, hash, by, basedOn, chatId }` on the
   work item stream; `reduceWorkItem` holds it as `pendingPrompt` and the next
   `WorkItemClaimed` consumes it. Empty `text` is the removal. `sendAttempt`
   appends the edit and then `WorkItemUnblocked`, in that order. The run's
   `promptVersion` names the edit by hashing its final text —
   `ticket@1924+failure@1c5708ba+human@a91f2e` — so two runs that share a version
   shared a prompt. Anything meant to outlast one attempt belongs in the GitHub
   issue body, where it versions as `ticket@NNNN`.
8. **Markdown is decided by source, never by sniffing.** The issue body is
   untrusted and rendered through `rehype-sanitize` with no raw HTML and no
   remote image fetched (an image renders as a link). The prompt is shown raw,
   with a rendered view as a toggle; the edit box is always raw. Gate output,
   `RunFailed.detail` and `RepairRequested.detail` are never rendered as
   markdown.
9. **A run writes `~/.lingtai/runs/<project>/<runId>.log`, outside the
   worktree.** The conductor chooses the path (`runLogPath`,
   `packages/conductor/src/run-log.ts`) and hands it to the adapter as
   `RunRequest.logPath`; `packages/agent` never learns the home layout. The file
   is mode `0600` in a `0700` directory and stops at `RUN_LOG_MAX_BYTES` (8 MB),
   saying in itself where it stopped. Writing never gates a tool call, and a
   failed write never fails a run.
10. **The log is a composed trace of every agent in the pass.** The implementer's
    tool calls come from the hook socket with their verdicts, and its prose from
    the `stream-json` output. Each step action writes a start line and an end line
    under `<step>:<action>`; an agent action's own output and tool calls (taken
    off the stream via `RunRequest.traceTools`, redacted as the socket redacts)
    appear between them. The fixer writes under `fix:<round>`, a judge agent under
    `judge:<when>`. Only the conductor writes the `RUN_LOG_END` (`end`) line.
11. **Landed deletes the log; anything else keeps it.** The conductor decides in
    the run's finalizer (`runLog.close(didLand ? "delete" : "keep")`).
    `reconcile`'s `findOrphanLogs` removes logs whose work item has landed and
    reports, never removes, a log with no `RunStarted` behind it.
12. **`lingtai attach <runId>` and the task page's run log are tails of that
    file.** Both start at byte zero and stop at `RUN_LOG_END`; neither touches the
    store, so they work with the daemon and the database down. The board's
    route is `/api/run/[runId]`, a separate SSE stream that ignores
    `Last-Event-ID`; the browser keeps the last `KEEP_LINES` (2000) lines.
13. **The run log is a trace, not a record.** Nothing may read it to decide what
    happened; if some behaviour would change with its contents, the design is
    wrong. The only thing taken from its contents is the end line, so a tail
    knows to stop.
14. **Gate evidence is plain text, stripped at capture.** `tail()` in
    `packages/actions/src/command.ts` removes CSI, OSC and every other escape
    sequence before it counts lines or bytes, so `GateFailed.data.evidence`, the
    fix prompt (clamped to `budget.evidence`) and the page all get plain text. An
    unterminated OSC loses only its `ESC ]`. Carriage-return redraws and other
    control characters are left alone.

## Consequences

- The board needs a Node runtime and holds a store connection per open tab;
  fine for one person, wrong for anything larger.
- Before the board is reachable by anyone else it needs authentication, an
  authorisation model for approvers, and a review of Server Actions, which
  trust their caller completely.
- Logs of landed runs are gone; the diff and the events remain. An investigable
  run keeps its log until its work item lands.
- The run log holds whatever the agent printed, including values from its
  environment, which is why it is `0600` and why it is deleted on landing.
- Colour is lost from evidence on the page. Stripping happens at capture only:
  an event already in the log is never rewritten, so an old one may still carry
  escapes.

---
*Replaces archived 0008, 0032, 0034, 0043 in [decisions-archive](../decisions-archive/).*
