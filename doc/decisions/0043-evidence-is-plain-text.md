# 0043 — A gate's evidence is plain text, stripped where it is captured

**Status** accepted · 2026-09-14 · closes #156; sharpens what
[0029](0029-the-prompt-budget-is-the-recipes.md)'s `budget.evidence` is counted in

## Context

`wi-lingtai-154`, `proposed / build`, rendered its evidence like this:

```
[31m [1mCaused by: Error [22m: Connection terminated unexpectedly [39m
```

The quoting #152 asked for was faithful: that is what the command wrote. A
`run:` gate's stdout is a pipe, and colour arrives anyway, because `pnpm` sets
`FORCE_COLOR` for the scripts it runs — so `pnpm typecheck && pnpm test` hands
vitest's emphasis straight through. That is also why it stayed hidden: the same
command in a terminal is correctly coloured, and run without `pnpm` in front
the output has no escapes at all.

The cost is not only looks. The one sentence that matters did not match a
search for itself, and the evidence is truncated: vitest's own failure output,
captured the way the gate captures it, is 1,308 characters of which 606 are
126 escape sequences — nearly half the total.
That window decides whether the failure is visible at all, and it is the same
text the fix prompt quotes.

## Decision

**Strip, at capture.** `tail()` in `packages/actions/src/command.ts`, which is
the one place a command's output becomes evidence, removes CSI, OSC and every
other escape (`ESC ( B`, `ESC 7`) before it counts lines or bytes. An OSC with
no terminator on its line loses only its `ESC ]`: stripping must never remove
the text that follows it.

- **Strip rather than render.** Rendering keeps the colour on the task page
  and does nothing for the fix prompt, `lingtai status`, or the budget. The
  evidence has more readers than the page; plain text serves all of them.
- **At capture rather than at render.** At render the record keeps the bytes
  and every reader has to know to remove them, and the budget has already been
  spent on them by the time anyone looks. At capture, `GateFailed.data.evidence`
  is plain, so the card, the fix prompt (`attempts.ts` clamps to
  `budget.evidence`) and anything written later get it for free.

## Consequences

- The tools' emphasis is lost on the page — a red `Caused by` is now just
  `Caused by`. Accepted: it was never reaching the page as colour.
- Events already in the log keep their escapes. The log is not edited; runs
  from here on are plain.
- Stripping only removes escape sequences. Carriage-return progress redraws and
  other control characters are untouched, and are a separate ticket if they
  show up.
- Pinned by `packages/actions/integration/evidence.test.ts`, against a real vitest
  failure captured through `pnpm`, at the `GateFailed` event rather than at
  `tail`.
