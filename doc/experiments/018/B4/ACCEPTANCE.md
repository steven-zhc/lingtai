# Acceptance — the commands that answer a wait print one verdict and take `--json`

Ticket: `TICKET.md`. **The issue number is not in the ticket.** The files are
named `621` because this is the next in the #616–#620 series (`doc/design/616.md`
… `620.md`). Rename them if the issue is a different number.

This is a CLI change, not a page, so there is no style table. The visual checks
below are about terminal output.

## Files

| file | half | what it drives |
|---|---|---|
| `apps/cli/unit/acceptance-621.test.ts` | unit (81 tests) | `runCli` from `src/cli.ts` with the argv a person types. Stubbed at the package boundary only: `@lingtai/conductor`'s `loadProject`, `approve`, `requeue`, `answer`, `close`, `resolveWait`; `projectClient`; `hasGitHubApp`; `@lingtai/daemon`'s `requestRun`; `withProjector`; and the log `grant-fix-round` reads, which is a memory store. Nothing in `apps/cli/src` is stubbed. |
| `apps/cli/integration/acceptance-621.test.ts` | integration (6 tests) | The same entry with nothing stubbed: real store, real lock, real decision. The appended event is read back. Covers `requeue`, `answer` and `now`, the three that need no GitHub client. |

## The `--json` shape these tests fix

Each of the six (`approve`, `requeue`, `grant-fix-round`, `close`, `answer`,
`now`) prints, under `--json`, exactly one line:

```json
{ "version": 1, "command": "<name>", "outcome": "accepted" | "refused",
  "reason": "<conductor code, where it gives one>", "detail": "<its sentence>",
  "ticketId": "...", … }
```

- `reason` is the conductor's own code, unchanged: `reason-required`,
  `no-saved-head`, `not-blocked`, `stale`, … (the ticket's *Watch out*).
- Facts the old prose carried are fields: `continuesAt` and `unscheduled` for
  `approve`; `project` and `issue` for `now`; `ticketId` and `detail` for every
  command.
- A usage error is still 0121 §5's `{ error: { code: "usage", message } }`, and
  its message is about the flag that was wrong.
- Exit codes: accepted 0, refused 1.

The text form, under `NO_COLOR`: exactly one line with `✓` (accepted) or `✗`
(refused), the glyphs from 0121 §2. An accepted command's last line starts with
`next:` (0121 §1).

## Want → check

| Want clause | proved by |
|---|---|
| the six commands are parsed by `@effect/cli` | unit: *Done when 1: X routes to @effect/cli*, ×6 (`routeOf`); *runCli answers `X` rather than refusing it as an unknown subcommand*, ×6 |
| they print the ADR's layout through the output module | unit: *X accepted: exactly one ✓ verdict line, and it closes on `next:`*, ×6; *X refused: exactly one ✗ verdict line*, ×5; *FORCE_COLOR paints it and stripping gives the same text*, ×6. The last one fails if the verdict is a bare string rather than `paint`/`symbol`. Integration: *requeue, plain under NO_COLOR: one ✓ verdict line, closing on next:* |
| each takes `--json` | unit: *`lingtai X --help` names --json*, ×6; every `--json` case below |
| one verdict line plus what happens next | the verdict-line and `next:` tests above |
| `--json` reports the outcome, accepted | unit: *approve/requeue/answer/close/grant-fix-round/now: { outcome: accepted } …*. Integration: *requeue --json: accepted … WaitResolved{Requeue} is appended*, *answer --json: accepted, and the answer is on the log*, *now --json: accepted* |
| `--json` reports the outcome, refused with the reason code | unit: *approve: reason-required is the API*, *grant-fix-round: no-saved-head is the API*, *requeue/answer/close: { outcome: refused } keeps the state the refusal named*, *grant-fix-round: an item not waiting on a fix decision is refused*, *X: a project never added is one document on stdout*, ×6. Integration: *requeue --json: refused … appends nothing*, *answer --json: refused … appends nothing* |
| Watch out: keep the refusal codes | the two *is the API* tests: the code is the `reason` field |
| Watch out: keep every fact | see *Done when 3* below |
| Watch out: `--json` lands with the new text; greps move to `--json` | not a test. See checklist item 5 |

## Done when → check

| Done when | proved by |
|---|---|
| 1. Each command parses through `@effect/cli` and prints through the output module; plain under `NO_COLOR`/non-TTY | routing ×6, runCli answers ×6, verdict-line tests, *no escape under NO_COLOR; FORCE_COLOR paints it …* ×6, *--no-color is NO_COLOR for the process, and beats FORCE_COLOR* ×6, *X --json: no colour even with FORCE_COLOR* ×6. A spied stdout is not a TTY, so every plain-mode test is also the non-TTY case |
| 2. Each read command's `--json` has a test pinning its shape | all six are pinned here by `toMatchObject` on `version`, `command`, `outcome`, `reason`, `ticketId`, `detail`, and the per-command facts. The implementer's own shape tests come on top of these |
| 3. No fact the old output printed is lost | approve: `ticketId` + `continuesAt` (JSON and text), `unscheduled`; now: project + `#issue` (JSON and text); requeue/answer/close: `detail` with the state named; grant-fix-round: `ticketId`; refusal codes in both forms. Old parser facts: *approve --reject is still refused by name, pointing at requeue*; *answer / close: an unquoted sentence still arrives whole*; *requeue: --note left off is recorded as ""* (#424); *grant-fix-round: --if-head reaches the resolution*; *a blank close reason / a blank answer is refused before anything is decided*; *--issue that is not a number is a usage error* ×6 |
| 4. `pnpm typecheck` and `HOME=/nonexistent pnpm test` are green | not a test here. Run both on the branch. The unit acceptance file is part of `pnpm test`, so a green run includes it |

## Visual checklist (a terminal, 80 columns, beside ADR 0121's example)

Run each command once accepted and once refused, both with colour and with
`NO_COLOR=1`.

1. Is there exactly one verdict line, starting with `✓` (accepted) or `✗` (refused)?
2. Is `✓` green (`paint.pass`) and `✗` red (`paint.fail`), and does nothing in the output use amber (`paint.signal`), which 0121 §2 keeps for "waiting on you"?
3. On an accepted command, is the last line `next: …`, naming a real command or saying what the daemon does next?
4. With `NO_COLOR=1`, is the text identical apart from the missing escapes, with the same glyphs and the same alignment?
5. Does `rg -n "lingtai (approve|requeue|grant-fix-round|close|answer|now)" doc/ scripts/ CLAUDE.md README.md` show anything that parses these commands' prose (a pipe to `grep`/`awk`/`sed`, or a quoted old phrase such as `back in the queue`, `fix round granted`, `requested `)? Each one should now use `--json`. On this checkout the search finds no such pipe.
6. Does no line wrap at 80 columns for a typical ticket id and detail?

## Lines with no automated check

- **Done when 4** (typecheck and the suite are green): it is a command to run, not a behaviour.
- **Watch out: greps move to `--json` in the same change**: nothing parses these commands today (checklist item 5's search finds none), so a test would pass on this checkout and prove nothing. It is a review item.
- **`approve`, `close` and `grant-fix-round` against the real log**: each builds a GitHub client (`projectClient`, `hasGitHubApp`) before it decides, and no test may reach GitHub. Their accepted and refused outcomes, and the codes, are proved in the unit half against the conductor's real result shapes (`ApproveResult`, `ResolveWaitResult`, `CloseOutcome`).
- **`now` appending `RunRequested`**: the integration test checks the document but does not read the control stream back, because which stream that is belongs to `@lingtai/daemon`. The unit test checks that `requestRun` is called once.
