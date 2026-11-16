# 018 — Would an acceptance agent have caught it?

**Set up** 2026-11-16 · **Run** pilot (one case) 2026-11-16, the rest not yet ·
**Result** none. The question behind it is [design/acceptance.md](../design/acceptance.md).

## Why

Eight tickets landed with every check green and were later found not to do what
they asked; a second ticket fixed each. If an agent had written the acceptance
from the original ticket alone, before the implementation, would its checks
have been red on what landed? And what would that have cost?

This measures before anything is built, as 015 did for `design`.

## The cases

| # | Origin (landed) | Merge | Kind | Fixed by | Merge | What was wrong |
|---|---|---|---|---|---|---|
| A1 | #1196 | `424613370f` | UI | #1237 | not yet | the tab does not look like its mock; paths overflow; a `/private` twin is not merged |
| A2 | #1188 | `41c6006f70` | UI | #1189 | `917cfb62d6` | the home page's sandbox card breaks at ~1360px, its classes shared with the board |
| A3 | #789 | `690dbbbb7e` | UI | #794 | `2075e18ad7` | the events page keeps the old look instead of its design |
| A4 | #885 | `3b9f13cf4b` | UI | #899 | `de174ca8ed` | a long refusal widens the attempt tab past its border |
| B1 | #1151 | `de47734316` | behaviour | #1193 | `687f913adb` | on macOS a sandboxed run cannot reach its hook socket |
| B2 | #594 | `4065a428de` | behaviour | #1044 | `85b3dfbfda` | no review is shown the *What landed on the base* block |
| B3 | #923 | `ba7dbc9f63` | behaviour | #926 | `09758385ad` | a pass's claim and continuation do not carry the body it fetched |
| B4 | #621 | `e35a6eb355` | behaviour | #770 | `61b6811243` | an integer flag accepts an empty, fractional or non-numeric value |

The input for each is the origin ticket's body **as it was claimed**
(`TicketClaimed.data.body`, the first claim), not the issue as it reads today.

## Protocol

For each case, in a throwaway clone outside `~/.lingtai`:

1. **Write.** Check out the origin's base (the merge's first parent). Run one
   acceptance agent (`claude -p`, the `design` step's model) with the ticket body
   and the instruction in [the prompt](#the-prompt). It writes checks and
   `ACCEPTANCE.md`, a line per *Done when* saying which check proves it, and
   implements nothing. Its cost is the run's own `total_cost_usd`.
2. **Base.** Run the checks on the base. Each should fail. A check that passes on
   the base is *cannot fail* (rule 2 of the design).
3. **Landed.** Copy the checks onto the origin's merge and run them. A check that
   fails there, for the reason the fixing ticket names, is **caught**. A failure
   for any other reason is a **false alarm**, judged against the fixing ticket's
   Evidence, and written down with the reason.
4. **Fixed.** Copy them onto the fix's merge and run them. They should pass; a
   failure there is either a false alarm or a check later work changed, and the
   row says which.

UI cases (A1–A4) add, at step 3, the computed styles of the elements the ticket
names and a screenshot of the page on fixed data, judged item by item against
the ticket's mock or design where it had one. Where the origin ticket had no
mock, the row says so: that is the open question of who writes UI acceptance
without one.

## What is recorded

Per case: checks written; *cannot fail* count; caught (yes/no and which check);
false alarms with reasons; the acceptance run's cost and turns; wall time.

## The prompt

> You write the acceptance for this ticket, before anyone implements it. You do
> not implement it. Read `TICKET.md`. For every line under *Done when*, write
> one check that would pass only when that line is true: a vitest test in the
> package the ticket names (`<package>/unit/acceptance-<issue>.test.ts`, or
> `integration/` when it needs a process, the filesystem or git), or, for a
> line only a person can check, a numbered item in `ACCEPTANCE.md` saying
> exactly what to look at. Then write `ACCEPTANCE.md`: each *Done when* line,
> the check that proves it. Run your tests with `npx vitest run <files>`: they
> must fail on this checkout, because nothing is built yet; a test that passes
> here proves nothing and must be rewritten. Do not edit any file outside
> your tests and `ACCEPTANCE.md`.

## Pilot

[Filled in after the first case runs.]

## Result

[Filled in when all eight have run.]
