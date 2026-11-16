# Acceptance — every paid agent call records the prompt it was handed as `RunPrompted`, tagged with its `RunSpent`'s `for`

The ticket is in `TICKET.md`. Its issue number could not be found offline (detached `HEAD`, no `gh`), so the files are named `acceptance-run-prompted.test.ts`, not `acceptance-<issue>.test.ts`. Rename them once the number is known.

## Tests

| File | Project | What it drives |
|---|---|---|
| `packages/domain/unit/acceptance-run-prompted.test.ts` | unit | `parsePayload('RunPrompted', …)`, `reduceAttempt`, the committed `doc/events.json` |
| `packages/conductor/unit/acceptance-run-prompted.test.ts` | unit | whole passes through `once()` (`test/one-attempt.ts`) with the memory store and a runtime that records each `RunRequest` and what the log held when it was called |
| `apps/cli/unit/acceptance-run-prompted.test.ts` | unit | `waitTriage` and `holdDiscussion` + `discussionAsk`, with `createMemoryEventStore()` and a runtime that records the same way |

Run:

    npx vitest run packages/domain/unit/acceptance-run-prompted.test.ts \
      packages/conductor/unit/acceptance-run-prompted.test.ts \
      apps/cli/unit/acceptance-run-prompted.test.ts

**How "appended before the dispatch" is proved.** Each fake runtime reads the store at the moment `run` is called and records which `RunPrompted` events are already there. A test passes only if the call's own prompt was on the log before the call ran. Comparing seq numbers afterwards could not show that.

**How the end-to-end Want is proved.** The conductor's fakes serve no hook, so for the implement call the fake runtime does what the hook's `UserPromptSubmit` branch does (`packages/agent/src/hook-socket.ts:230`): it appends one `RunPrompted` with no `for` to the pass stream. The test then reduces the pass stream with `reduceAttempt`, as the task page does, and checks that `prompt` is still the implementer's and `prompts` is 1 after the review, judge and fix prompts are recorded next to it.

## Page

There is no page in this ticket. Showing these prompts on the task page or in `lingtai status` is out of scope, so there is no style table and no visual checklist.

## Want → proof

| Want clause | Proved by |
|---|---|
| Every paid agent call has a `RunPrompted` … | conductor: *Want + Done when 2 & 3* (review, judge, fix) and *Done when 3: the design agent*; cli: *Done when 3 (triage)* and *Done when 3 (discussion)* |
| … with the whole prompt it was handed … | Same tests: `RunPrompted.prompt` must equal `RunRequest.prompt` exactly, one per call, and triage also checks `bytes`. Any truncation fails this. |
| … tagged with the same `for` its `RunSpent` carries | Same tests: the list of `RunPrompted.for` equals the list of `RunSpent.for` for that kind of call, and the stream ids match too (Edges: *Stream*) |
| The attempt's own `prompt` stays the implementer's | domain: *Done when 4*; conductor: the end of *Want + Done when 2 & 3*, reduced off a real pass stream |

## Done when → proof

| Done when | Proved by |
|---|---|
| 1. `RunPrompted` has `for: SpentFor.optional()`, and a unit test parses an event without `for` | domain: *Done when 1*. It parses without `for` and with each `SpentFor` variant, and `for` must survive the parse. |
| 2. Fix lap, fake runtime, memory store: one `RunPrompted`, `prompt` = what `runtime.run` got, `for` = the round's `RunSpent.for`, appended before the dispatch | conductor: *Want + Done when 2 & 3*, through `provesKind(…, 'fix')`. The agent judge answers `implement`, so the pass buys a real fix round (`:fix:1`). |
| 3. The same for the cold reviewer, a judge, the design agent, triage and a discussion, each read back off the call's stream | conductor: `provesKind` for `review` and `judge` (same test) and `design` (*Done when 3: the design agent*); cli: *Done when 3 (triage)* reads `ticket-…`, and *Done when 3 (discussion)* reads `chat-…` over two rounds |
| 4. Attempt reducer: implement `RunPrompted` (no `for`), then a fix one (with `for`), leaves `prompt` the implementer's and `prompts` at 1 | domain: *Done when 4*, which also adds a review one and checks `promptMeta` |
| 5. An append that throws does not stop the dispatch (failing store) | conductor: *Done when 5 / Watch out* (review, judge, fix); cli: *Done when 5 … (triage)* and *Done when 5 (discussion)*. Each checks that the append **was attempted**, exactly once per call, and that the call still ran and still got its `RunSpent`. |
| 6. `doc/events.json` regenerated; `pnpm typecheck` and `HOME=/nonexistent pnpm test` green | domain: *Done when 6* checks that the committed `RunPrompted` entry names a second site beside the hook and lists every stream `RunSpent` goes to. The existing `packages/domain/unit/events-json.test.ts` (*events.json is current*) checks that the file matches the code. Typecheck and the full suite are commands, not tests (see below). |

## Edges and Watch out → proof

| Line | Proved by |
|---|---|
| Watch out: the reducer overwrites `prompt` on every `RunPrompted` | domain *Done when 4*; conductor end-to-end reduce |
| Watch out: do not record the implement run twice | conductor *Want + Done when 2 & 3*: exactly one `RunPrompted` of the implement kind on the log, and it has no `for` (the hook's) |
| Watch out / Edges *A failed append*: logged and swallowed, not retried | the three *Done when 5* tests. Triage and the discussion check `tried` equals exactly one stream entry per call, so a retry fails them. The conductor checks one attempt per unhooked call. |
| Edges *Which calls* | `provesKind` for review, judge, fix, design; the triage and discussion tests |
| Edges *Stream* | stream-id equality in `provesKind`; triage reads `ticket-…`, the discussion reads `chat-…`; domain *Done when 6* checks that `RunPrompted`'s documented streams include every `RunSpent` stream |
| Edges *Order* | the `recordedBefore` / `promptedBefore` witnesses described above |
| Edges *Size*: no truncation | exact string equality with the prompt as handed (a fix brief includes the diff) |
| Edges *Stored events*: none rewritten; no `for` means the implement run | domain *Done when 1* (the payload without `for` parses unchanged); domain *Done when 4* (no `for` is the one the reducer reads) |
| Edges *The attempt reducer*: `histories.ts` fixtures still reduce to the same state | the existing `packages/domain/unit/attempt.test.ts` and the tests that use `test/histories.ts`; this file adds nothing for it |
| Edges *Generated docs* | domain *Done when 6* |
| Edges *Two passes at once / restart / drain* | the ticket says this does not apply; no check |
| Edges *ADR* | none changes; no check |

## Lines with no check, and why

- **`pnpm typecheck` and `HOME=/nonexistent pnpm test` are green.** These are commands the implementer runs, not behaviour a test can assert. The acceptance files cast the new `for` field (`as never`) so the domain test does not fail typecheck before the schema has the field. After it lands, the casts can be removed.
- **Out of scope:** the task page or `lingtai status` showing these prompts, recording a person's choice on a wait, hooking the unhooked runs, and truncation or retention. No check, on purpose.
- **The second review visit.** In the conductor scenario the fix round commits nothing new, so the pass does not visit `review` a second time. `review` is proved on its first visit only. The `for` comparison is per call, so a second visit would be held to the same rule.

## For the implementer: existing tests this will turn red

These tests pin exact event-type sequences. Once `RunPrompted` is appended beside each unhooked `RunSpent`, they will go red even when the change is correct. Each needs `RunPrompted` added to its expected list:

- `packages/conductor/unit/what-an-attempt-writes-today.test.ts`: every row with a review, judge, fix or design `RunSpent`
- `packages/conductor/unit/discuss.test.ts`: the `store.types()` lists, such as `['DiscussionAsked', 'RunSpent', 'DiscussionAnswered']`
- `apps/cli/unit/discuss-ask.test.ts:121` and `apps/cli/unit/triage.test.ts`: the `typesOf(...)` lists, such as `['TriageStarted', 'RunSpent', 'WaitTriaged']`
- possibly `packages/domain/src/events.ts:2356` (`RunPrompted: [...AGENT_STEPS]`) and `:251` in `scripts/events.ts` (`RunPrompted: ['pass-']`), which say where the event may be written and must widen to `proposed`/`outside` and `ticket-`/`chat-`
