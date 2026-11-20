# 0.16 — the Linear experiments: what to run, and how

**Status** planned · 2026-11-20 · the measurements [0.16.md](0.16.md)'s
ticket-source part asks for before its tickets are cut. The results go to a
`doc/experiments/` write-up; this file is the procedure.

Linear's API is documented and covers every verb Lingtai needs; what the docs
cannot say is how a real workspace behaves under Lingtai's own tickets. Each
experiment answers one such question. Where the docs claim an answer, it is
written beside the experiment to confirm or refute, never as the answer.

## The survey behind it (2026-11-20)

From Linear's developer docs and its SDK's schema
(`packages/sdk/src/schema.graphql` in [linear/linear](https://github.com/linear/linear)):

| Lingtai's verb | Linear | Known before the run |
|---|---|---|
| list open, labels, open-blocker count | `issues(filter:{team, state:{type:{nin:[completed,canceled,duplicate]}}, hasBlockedByRelations})` | a filter for *no open blockers* exists; no count field — counted from `inverseRelations` |
| get | `issue(id)` — UUID or `ENG-123` | `description` is Markdown |
| create | `issueCreate` | labels by UUID; the label must already exist and be available to the team |
| comment / edit comment | `commentCreate` / `commentUpdate` | — |
| labels: replace / add / remove | `issueUpdate{labelIds}`; `issueAddLabel` / `issueRemoveLabel` | `labelIds` cannot be combined with added/removed ids; a single-select label group keeps one |
| close done / not planned | `issueUpdate{stateId}` of the team's state of type `completed` / `canceled` | a team may have several states of one type |
| replace body if unchanged | `issueUpdate{description}` | **no precondition of any kind** |
| blockers | `inverseRelations` of type `blocks`; `issueRelationCreate` | `hasBlockedByRelations` sees open-to-open links only |
| created since, oldest first | `issues(filter:{createdAt:{gt}}, orderBy:createdAt, last:N)` | **`first` is newest-first, `last` oldest-first** |
| webhooks | `webhookCreate` | admin or OAuth `admin` scope; public HTTPS; HMAC `Linear-Signature` |

Identity: `id` (UUID) is stable; `identifier` (`ENG-123`) changes when an issue
moves team, the old ones kept in `previousIdentifiers`. Auth: a personal API key
(`Authorization: <key>`, no `Bearer`), or an OAuth app; client credentials give
a 30-day token acting as the app. Rate limits: API key 2,500 requests and
3,000,000 complexity points an hour; an unsized nested connection counts as 50.
Free plan: 250 issues, 2 teams, API and webhooks included.
`@linear/sdk` is 103.0.0 (2026-11-18), its major moving about weekly.

## Where it runs

On Foundry, in `~/workspace/acp-lab` beside the ACP round, against a **free
Linear workspace made for the round and nothing else**. Its key is in
`~/workspace/acp-lab/linear.key` (`LINEAR_API_KEY=…`, mode 600), written by the
operator and never printed. A small client (`tracker-lab/linear.mjs`) speaks raw
GraphQL, so what is measured is Linear and not a library; `@linear/sdk` is tried
in L9 only.

## The experiments

### L1 — does Lingtai's body survive

*Question:* is a Lingtai ticket body, written as Markdown, the same when read
back?

1. Take five real bodies from this repository — #1298, #1301, #1302 (tables,
   code fences, `file:line` cites, checkboxes, nested lists), one with a long
   table, one with HTML entities and backticks inside table cells.
2. `issueCreate` with each as `description`; read it back; diff against the
   original byte for byte, then normalised (trailing whitespace, line endings).
3. Edit one in Linear's UI (a checkbox ticked) and read it back again.

*Record:* per body, identical / differs only in whitespace / differs in content,
and the differences. *Decides:* whether *body unchanged* can ever be compared
by string, and what the adapter's read normalises.

### L2 — labels

1. Apply `agent:hold`, `bug`, `feature` to a new issue by name: what happens when
   the label does not yet exist?
2. Create them as workspace labels and as team labels; can one issue carry a
   team `bug` and a workspace `bug`, and which does a name lookup find?
3. Replace the set with `labelIds`; add and remove one; apply two labels of one
   single-select group.

*Decides:* whether the adapter creates labels, at which scope, and how a name
resolves.

### L3 — closing

1. List the default team's states and their `type`.
2. Close one issue *done* and one *not planned* by type; read back `state`.
3. Add a second `completed` state in the UI; which one does choosing by type and
   `position` pick?

*Decides:* the close rule, and what the declared *not planned* capability is.

### L4 — blockers

1. A blocked by B and C (`issueRelationCreate` with B and C as blockers).
2. Read A's `inverseRelations` with each blocker's state; list with
   `hasBlockedByRelations:{eq:false}` — is A excluded?
3. Close B, then C: when does A appear in the unblocked listing, and what does its
   open-blocker count read at each step?
4. Add the same link twice.

*Decides:* how the listing's open-blocker count is built, and its cost in
complexity points (read from `X-Complexity`).

### L5 — editing at the same time

1. Read an issue; edit its description in the UI; write a new description from
   the client. Whose survives? Does `updatedAt` change on every edit, and on a
   comment or label change too?
2. Time a read-compare-write loop: how long is the window?

*Decides:* what *best-effort* means for Linear's *replace if unchanged*, or
whether it is declared absent.

### L6 — identity across a move

1. Move an issue from team one to team two (the free plan has two).
2. Read it by its UUID, its old `ENG-…` and its new identifier.

*Decides:* that the stable id is the UUID, and whether an old key a person typed
still resolves.

### L7 — listing order and paging

1. With 60 issues, list open ones with `first:50` and `last:50`; which is oldest
   first?
2. List created since a date, oldest first, across two pages.
3. Include an archived issue: when is it returned?

*Decides:* the discovery query, and that it never reverses the queue.

### L8 — limits and cost

1. Each query the adapter would run, at the sizes Lingtai uses: read
   `X-Complexity` and the `X-RateLimit-*` headers.
2. One discovery sweep every five minutes for an hour: the share of the hourly
   budget it spends.

*Decides:* whether the five-minute sweep fits, and the nested page sizes.

### L9 — auth, and the SDK

1. Personal API key: every verb above.
2. An OAuth app with client credentials, `actor=app`: does it work on the free
   plan, with what scopes, and who is the author of a comment it writes?
3. `@linear/sdk` at its current version: the same five verbs; does its typing
   cover `hasBlockedByRelations` and `inverseRelations`?

*Decides:* which credential Lingtai asks for, and raw GraphQL or the SDK.

### L10 — webhooks (optional)

Only if a public HTTPS address is to hand (a tunnel to Foundry): create one,
change an issue, check `Linear-Signature` and the delivery delay. Otherwise
written down as *not measured*; the five-minute sweep stands without it.

### L11 — assignee (added 2026-11-20)

1. Read `viewer`; create one issue assigned to it and one to nobody.
2. List with `assignee:{isMe:{eq:true}}`, `assignee:{null:true}` and by id.
3. Unassign the first; list `isMe` again. Assign a malformed id.

*Decides:* how *take only my tickets* reads *me* on Linear.

## What it costs

Nothing but time: the free plan, no agent, no model. The 250-issue cap is the
limit to watch — the round uses well under 100, and the workspace is deleted
after.

## The write-up

A `doc/experiments/` entry with the date, the API version (`@linear/sdk` and the
schema's commit), a table per experiment, and what each decision in 0.16.md's
ticket-source part rests on. Then the tickets.
