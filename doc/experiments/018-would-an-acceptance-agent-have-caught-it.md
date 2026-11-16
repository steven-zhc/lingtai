# 018 — Would an acceptance agent have caught it?

**Set up** 2026-11-16 · **Run** pilot A1 2026-11-16, the rest not yet ·
**Result** A1 caught (below). The question behind it is [design/acceptance.md](../design/acceptance.md).

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

[`018/prompt.md`](018/prompt.md). It asks for checks that prove the ticket's
**Want** end to end, with *Done when* as the minimum: B4 (#621) and B1 (#1151)
showed, before any run, that their defects lie outside every *Done when* line —
#621 never asked for flag validation, and every one of #1151's lines is a unit
test over fakes, none a real Codex run reaching its hook. A prompt that only
mirrors *Done when* would miss both by construction.

## Pilot: A1 (#1196 → #1237)

**Run** 2026-11-16, on `49bfd9d9` (`424613370f`'s first parent), with #1196's
body as claimed and the mock already in the tree. `claude -p`, Opus 5.5:
**$3.82, 63 turns, 9 min 6 s.** Output in [`018/A1/`](018/A1/): `ACCEPTANCE.md`
(a 48-row style table, a 23-item visual checklist, a map of every *Want* clause
and *Done when* line) and 57 tests in two files.

| Step | Result |
|---|---|
| Base | 57 of 57 tests fail, each on an assertion about what the ticket builds. *Cannot fail*: 0. |
| Landed (`424613370f`) | 30 pass, 27 fail. |
| Landed, the page | the style rows checked by `getComputedStyle` on the demo attempt, and the checklist's overflow and twin items: **every one fails, each for a reason #1237 names** (table below). |
| Fixed | not yet: #1237 has not landed. |

| Check | Expected | Landed |
|---|---|---|
| S1 summary | `1px solid var(--rule)`, 10px, grid | `--muted` (`#5e6e74`), 6px, flex |
| S14 part heading | 12px, 600, uppercase, `--muted` | 15.8px, 700, none, `--ink` |
| S23 Blocked header row | Host · Refused · By · First | no `th` |
| S31 boundary pill | `--pass-soft` | transparent |
| S33 / S37 box, chip | `--rule` border; chip on `--ground` | `--muted` border; chip transparent |
| Checklist 15: no chip leaves its box | 0 | 3 (`/var/folders/…`) |
| Checklist 17: a `/private` twin is one chip | one | two (`…/T/` and `/private/…/T`) |

**Caught: yes**, by the style table and the checklist, not by the tests.

**The 27 failing tests are not 27 findings.** About 21 fail on an interface the
agent had to guess (`shortNameOf` returning a string, a `BUILT_IN_VENDORS`
export, `aria-label="Legend"`, a header `Kind` not `kind`), and two on wording
(*outside the sandbox* for the ticket's *outside it*; no *the set above, nothing
more* row). Looking back, those read as false alarms; in a pipeline that writes
the acceptance first, they are the interface the implementer is handed, and an
implementation would meet them. A retrospective run cannot tell the two apart,
so the rest of the cases count them separately.

**What the pilot says about the design.** The checks that caught it were the
UI half, and they were checked by hand here (`getComputedStyle` in a browser on
the demo board). The agent took exact values from the mock's CSS and noticed the
mock's `--rule-2` is the board's `--surface-2`. A pipeline needs the harness the
design draft names: the board on fixture data, a browser, the style table run as
a script.

## Result

[Filled in when all eight have run.]
