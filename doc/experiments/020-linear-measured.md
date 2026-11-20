# 020 — What does Linear actually do with Lingtai's tickets?

**Set up** 2026-11-20 · **Run** 2026-11-20 on Foundry · **Result** every verb
Lingtai needs works; four behaviours the adapter must handle by name — Markdown
is rewritten (a fixed point after one write), label names collide
case-insensitively with Linear's defaults, the API's `createdAt` order cannot be
trusted, and *replace if unchanged* can only be best-effort. Raw GraphQL, not
the SDK's object API. The procedure is
[tracker-experiments.md](../milestone/0.16.0/tracker-experiments.md); the plan
it serves is [0.16.md](../milestone/0.16.0/0.16.md)'s ticket-source part.

## Where and what

A free Linear workspace made for the round, one team (`HCZ`) and a second made
by L6; a personal API key on Foundry, never printed. Raw GraphQL over `fetch`
(`acp-lab/tracker-lab/lin.mjs`), every call's complexity and remaining budget
logged; `@linear/sdk` 103.0.0 for L9 only. Scripts and outputs are in
`~/workspace/acp-lab/tracker-lab/` on Foundry.

## Results

### L1 — does Lingtai's body survive

Five real bodies — #1298, #1299, #1301, #1302, #340 — written as `description`
and read back: **every one changed**, by 5 to 19 characters. Linear re-serialises
Markdown:

| Written | Read back |
|---|---|
| `- item` | `* item` (task lists keep `- [ ]`) |
| `\| \| \|` / `\|---\|---\|` | `\|  \|  \|` / `\| -- \| -- \|` |
| `[x](../path)` | `[x](<../path>)` |
| `**Copilot's `x` text**` | `**Copilot's** `x` **text**` (emphasis split at inline code) |
| `~2 s` | `\~2 s` |
| `*"…\"gpt-5\"…"*` | the `\"` unescaped |
| a trailing newline | dropped |

**No content was lost**, and **Linear's own form is a fixed point**: written back,
all five returned byte-identical. Two readers in Lingtai do not survive the
rewrite:

- the board's four-row table, `ticketOpening` (`apps/board/src/app/standing.tsx:678`):
  its rule regex wants `-{3,}` and Linear writes `--`; and it rejects a cell
  holding `<` or `>`, which Linear's `](<url>)` puts in any cell with a link. A
  Linear ticket's task page would lose its Problem/Want/Watch out.
- `doneWhenItems` (`packages/domain/src/done-when.ts:16`) accepts `*` items and
  `[ ]`: fine.

### L2 — labels

- **Label names are unique case-insensitively across the workspace.** A new
  workspace already has `Bug`, `Feature`, `Improvement`; creating `bug` or
  `feature` is refused *duplicate label name* — Lingtai's kinds collide with
  Linear's defaults. `issueLabels(filter:{name:{eqIgnoreCase}})` finds them.
- A team label `tech-debt` and a workspace `tech-debt` cannot both exist (the
  second refused): one name, one label — the ambiguity the survey feared does not
  arise.
- `labelIds` takes ids, never names (*Argument Validation Error*).
- `labelIds` replaces the set; `issueRemoveLabel` removes one; `issueAddLabel`
  twice leaves one.

### L3 — closing

Default states: Backlog (backlog), Todo (unstarted), In Progress and In Review
(started), Done (completed), Canceled (canceled), Duplicate (duplicate). Closing
by type set `completedAt` for Done and `canceledAt` for Canceled. With a second
completed state (`Shipped`, position 1003) added, the lowest `position` still
picks `Done`.

### L4 — blockers

A blocked by B and C: two links, two open; `hasBlockedByRelations:{eq:false}`
excludes A. B closed: one open, still excluded. C closed: none open, A listed.
The same link created twice stays one link. Reading A's `inverseRelations` with
each blocker's state costs 67 complexity points.

### L5 — editing at the same time

`updatedAt` moves on a body or label change, **not on a comment**. A reader that
checks `updatedAt` before writing sees the other writer's change; without the
check, the last writer wins. A read-compare-write takes ~200 ms: *replace if
unchanged* is best-effort, as GitHub's is.

### L6 — identity across a team move

`HCZ-17` moved to the second team became `LTW-1`, `previousIdentifiers: ["HCZ-17"]`;
the UUID resolves, and **the old identifier still resolves** to the moved issue.

### L7 — listing order

**`orderBy: createdAt` returns newest first with `first` and with `last`**, and
the four issues Linear made at sign-up (equal timestamps) came back out of order
(`last:5` → HCZ-4, 3, 2, 1, 5). The survey's *`last` is oldest first* does not
hold as a page order. Filtering `createdAt: {gt}` works.

### L8 — cost

One discovery sweep — open issues of a team, 100 a page, labels and blockers 10
each — cost **38 complexity points** and 96 ms; left unsized, the nested
connections cost 60. A sweep every five minutes is 456 points an hour of
3,000,000 (0.015%) and 12 of 2,500 requests.

### L9 — the SDK

`@linear/sdk` 103.0.0: `issues()` works, but `labels()` and `inverseRelations()`
are lazy calls — **ten extra requests and ~1 s for five issues**, where one raw
query returns them all. `rawRequest` works. Its major version moves about
weekly (102.0.0 on 2026-11-11, 103.0.0 on 2026-11-18).

OAuth client credentials: not measured (no app created).

### L10 — webhooks

Not measured: no public HTTPS address. The five-minute sweep stands without them.

## What it means for 0.16.md

1. **The body**: Lingtai keeps Markdown; after any write the adapter keeps
   Linear's returned form as *the body as last read*, and compares against that,
   never against what it sent. Lingtai's own readers of a body — the board's
   four-row table first — accept the equivalent forms (`--` rules, `<url>` links).
2. **Labels** are matched case-insensitively and reused; the adapter creates only
   a label no name matches, as a workspace label.
3. **Closing** by state type, lowest `position`; *not planned* is `canceled`.
4. **Blockers**: `hasBlockedByRelations` for the listing, `inverseRelations`
   (sized) for the count.
5. **Order is Lingtai's**: sort by `createdAt` then number on the client; never
   trust the page order.
6. **Replace if unchanged** is declared best-effort, checked by `updatedAt`.
7. **Identity**: the UUID is the stable id; the identifier is for display, and an
   old one a person types still resolves.
8. **Raw GraphQL** with zod-checked responses and sized nested connections; not
   the SDK's object API.
