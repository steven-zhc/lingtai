# Later — ticket sources and the GitLab acceptance run

**Status** measured and partly decided, not scheduled · moved out of 0.16.0 on
2026-11-20, when the operator narrowed 0.16.0 to the ACP runtime and solo and
team modes ([0.16.md](../0.16.0/0.16.md)): *a Linear adapter, or any other
tracker, does not change much for a person; solo and team changes it for every
one, a new user first.* A milestone is chosen for it when it is next planned.
Epic #340 holds it.

## The GitLab acceptance run

Not a feature: with tickets in the local store, discovery, claiming and
landing never ask the remote's host anything, and the landing is a local
`git merge --no-edit` and a push (`packages/actions/src/merge-action.ts:47`).
`repo.remote` takes any git URL (#394). What is unproven is the run itself, so
the acceptance is:

- a clean machine with nothing of Lingtai on it, installed from the release
  script, measured from the first command to the first landing (the *first run
  on a clean machine* moved here from 0.15.0);
- a GitLab project as `repo.remote`, `source.tickets: db`, local tickets with a
  blocker between them;
- which credential the push used, written down;
- the documentation the run proves, and a ticket for each thing it found.

Bitbucket is the same claim and is not run separately.

## Ticket sources: the groundwork, then Linear

Decided 2026-11-20, from a survey of the trackers' APIs against what Lingtai
asks of one (the procedure is [tracker-experiments.md](tracker-experiments.md)).

**Who uses what.** Stack Overflow's 2025 survey: Jira 52% of professional
developers, GitLab 37% and Azure DevOps 19% (both counted as whole platforms),
Linear 4% — but Linear's new-company adoption rose 67% in a year while Jira's
fell 32% ([survey](https://survey.stackoverflow.co/2025/technology),
[Bloomberry](https://bloomberry.com/blog/the-data-on-jira-vs-linear-whos-winning-new-customers/)).
Linear is first because it is the least work and the measurement is cheap;
Jira, the most used, is the hardest — its bodies are ADF with no official
Markdown converter, closing is a per-workflow transition, and JQL cannot ask
for unblocked tickets — and moves to a later milestone, measured first in the
same way.

**What Lingtai asks of a tracker today.**

- The ten verbs of `Tickets` (`packages/conductor/src/ticket-store.ts:76`),
  every reference a `number` (`getIssue(number)`, `comment(issue: number)`, …);
  34 source files take a reference as `number`; branch names `agent/<n>` are
  built in three places; a split child's `number` is in an event
  (`packages/domain/src/events.ts:428`). Most events already carry references as
  strings (`externalRef`, `issue: z.string()`).
- Verbs outside the interface that only GitHub answers: open-blocker counts on
  the listing and `addBlockedBy` (`packages/conductor/src/split-ticket.ts`),
  `addLabels`/`removeLabel`, a split child's milestone and assignees
  (`split-ticket.ts:116`). A webhook is optional: a five-minute sweep is the
  fallback (`packages/daemon/src/work-loop.ts:162`).
- `TicketSource = z.enum(['github', 'db'])` (`packages/recipe/src/recipe.ts:1112`);
  0109's *Not built yet* still lists the closed `source` enum.

**The groundwork**, whatever the tracker:

1. A reference is a string, and two of them: a **stable id** (Linear's UUID,
   Jira's numeric id) and a **display key** (ENG-123, PROJ-123), because both
   trackers change the key when an issue moves.
2. Blockers (read the open count, add a link), one label added or removed, and a
   child's placement move behind `Tickets`.
3. Each tracker declares its capabilities, as a runtime does: whether *replace
   the body only if unchanged* is exact, best-effort or absent (Jira none;
   GitHub and Linear best-effort, Linear's by `updatedAt`; `db` exact), whether it has blockers,
   whether it has assignees,
   whether a close carries *not planned*. Lingtai degrades or refuses by that,
   and `lingtai doctor` says so.
4. Markdown is Lingtai's format; an adapter converts at its edge.
5. `source` is open; one contract suite holds every adapter, as it holds
   `memoryTickets` and `dbTickets`.

6. Lingtai's own readers of a body accept the equivalent Markdown another
   tracker writes back: any tracker may re-serialise, and Linear does.
7. The order of the queue is Lingtai's: sorted on the client, never the page
   order a tracker returns.

**Decided by measurement** — [experiment 020](../../experiments/020-linear-measured.md),
2026-11-20. Every verb Lingtai needs works on Linear; what the adapter does by
name:

| Found | So |
|---|---|
| Linear rewrites Markdown (`-`→`*`, `\|--\|` rules, `](<url>)`, emphasis split at code); nothing lost, and its own form is a fixed point | The adapter keeps Linear's returned body as *the body as last read* and compares against that. The board's four-row table (`ticketOpening`, `apps/board/src/app/standing.tsx:678`) accepts `--` rules and `<url>` links — groundwork 6 |
| Label names are unique case-insensitively, and `Bug`/`Feature` exist from the start | Match by name ignoring case and reuse; create only a label nothing matches, at workspace level |
| Several states may share a type | Close done by type `completed`, not planned by `canceled`, the lowest `position` of each |
| `hasBlockedByRelations` and the open count behave as documented; a link made twice is one | The listing filters on it; the count comes from sized `inverseRelations` |
| `updatedAt` moves on body and label edits, not on comments; a check-then-write window of ~200 ms | *Replace if unchanged* is declared best-effort |
| A team move changes `HCZ-17` to `LTW-1`; the UUID and the old key both still resolve | The UUID is the stable id, the identifier the display key |
| `orderBy: createdAt` is newest-first with `first` and `last`; equal timestamps come back in any order | Sort by `createdAt`, then number, on the client — groundwork 7 |
| A sweep costs 38 complexity points, 0.015% of the hourly budget at one every five minutes | The five-minute sweep is enough; webhooks stay optional |
| `@linear/sdk`'s objects load lazily (10 extra requests for 5 issues) and its major moves weekly | Raw GraphQL with zod-checked responses |
| One assignee per issue, a user id; the key's own user is `viewer`, and `isMe` filters server-side | *Take only my tickets* on Linear needs no login written (below) |

Not measured: OAuth client credentials (no app), webhooks (no public address),
a checkbox ticked in Linear's UI. None changes a row above.

Epic #340 is this part; its children are cut from these findings when it is scheduled.

### Take only my tickets, on other sources

What 0.16.0's team mode leaves for this part (its GitHub half is in
[0.16.md](../0.16.0/0.16.md), *Solo and team*):

- `login` is a GitHub word. Linear's assignee is a user id, one per issue, and
  *me* is the API key's own user (`viewer`, L11) — nothing to write, and the
  query filters by it. Jira's will be an account id.
- **The groundwork's shape:** the listing carries assignees as the tracker's own
  user ids; the adapter answers *who am I* — GitHub from the login the recipe
  names, Linear from `viewer`; a source that tracks no assignee declares it.
- **Decided 2026-11-20: on Linear, *me* is the key's own user**, always: nothing
  is written, the query filters on `isMe`. Taking another person's tickets is
  that person's key.
- **Not measured: Linear beside a code host.** Linear has no PR; a team keeps
  code on GitHub or GitLab, and Linear's integration links a PR by the issue key
  in its branch name or title, or by a magic word (`Fixes HCZ-12`) in its
  description, and moves the issue's state when the PR opens and merges
  ([Linear's docs](https://linear.app/docs/github-integration)). Team mode's PR
  draft would write Linear's magic words, keep `lingtai:landed` rather than move
  Linear's states, and name branches with the key. *Where tickets live* and *where
  the PR opens* are two capabilities, of two systems. To measure (L12) before
  this part is cut.

