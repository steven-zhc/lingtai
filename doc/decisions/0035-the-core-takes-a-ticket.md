# 0035 — The core takes a ticket, and where it came from is an adapter's business

**Status** accepted · 2026-09-09 · clarifies
[0016](0016-the-settled-model.md) §1's queue-refresh row; applies
[0023](0023-effect-at-the-boundary.md)'s port boundary to a seam it did not
have

## Context

Lingtai reads tickets from GitHub. 0016 §1 lists that among the seven things
the core owns and will not delegate, with this reason:

> | refreshing the queue from GitHub | Lingtai never decides which issues exist ([0012](0012-one-task-view.md)) |

**The reason argues that the queue is a refresh from outside rather than
internal state. It does not argue that GitHub belongs in the core.** There is a
step missing between the premise and the conclusion, and it held for a year
because there was only ever one source to notice it with.

### The core already does not care

Nothing in `conductor`, `daemon` or `domain` reads `WorkItemDiscovered.source`
to decide anything. The projection carries it —

```ts
// packages/domain/src/work-item.ts:182
source: d.source,
```

— and that is the whole of its use. Every other match on the word is something
else: `recipe.source.kinds` is the recipe's own block (a name collision, see
Consequences), and `repair.ts:156`'s `failure.source` is `"project" | "run"`,
unrelated.

### The log has been source-neutral all along

```ts
// packages/domain/src/events.ts:99
export const WorkItemDiscovered = z.object({
  project: z.string(),
  source: z.enum(["github-issue", "manual", "agent-followup"]),
  externalRef: z.string(),
  title: z.string(),
  /** A label of the repository's, not a member of a set this file keeps. */
  kind: z.string(),
  labels: z.array(z.string()),
});
```

No `number`, no `url`, no `state`. `source` is already an enum of three, of
which GitHub is one. `externalRef` is already the abstraction over an issue
number. `kind` was freed from a core enum by `#76`, for a reason that generalises
exactly:

> Which of a repository's labels name work is a fact **that repository has and
> this schema does not**. — `recipe.ts:164`

### The blast radius is two packages

`@lingtai/github` is imported by `conductor` and `daemon`, and by the two apps.
Its exports already fall into three groups that are the shape of the answer:

| `app.ts` | `appJwt`, `installationToken`, `permissionGaps` | credentials |
| `client.ts` | `createGitHubClient`, `Issue`, `Label` | fetch and write back |
| `webhook.ts` | `verifyWebhook` | "something changed" |

**So the principle is already true in the core and false only in the plumbing.**
This is an extraction, not a redesign: the loop does not change.

## Decision

### 1. The core's input is a ticket

The core takes a `Ticket` and runs it. Where the ticket came from is recorded
for write-back and **never branched on**. `manual` and `agent-followup` are not
preserved special cases needing their own door — they are somebody handing the
core a ticket, through the same door the GitHub adapter uses.

### 2. `TicketStore` is a port, and an adapter implements it

The pattern is [0023](0023-effect-at-the-boundary.md)'s, already in
`packages/conductor/src/ports.ts`. This adds a boundary, not a concept.

**It is called `TicketStore`, not `Repository`.** The pattern's name in the
literature is Repository, and that name is used in this document — but
`packages/repo` already means git, worktrees and the merge lane. A codebase
where `repo` means two things is the mistake [0022](0022-the-seams.md) renamed
`@lingtai/core` to avoid.

### 3. Two shapes, because there are two moments

```ts
/** Discovery, the queue, the board. Cheap, in bulk, possibly hundreds. */
interface TicketRef {
  source: string;
  externalRef: string;   // "123", "PROJ-456", a URL — the store's own identity
  title: string;
  kind: string;
  labels: string[];
}

/** After the claim. One, and it is going to run. */
interface Ticket extends TicketRef {
  body: string;          // becomes the prompt
}
```

The split is not invented. `WorkItemDiscovered`'s payload **is** `TicketRef`,
and the body is fetched at run time by the caller, not carried through:

> The one thing this file will not do is fetch — `prompt.ts:14`

In the pattern's terms, the list is a read model and the single fetch is the
aggregate. In this system's terms, listing is what the board and the queue do
every pass, and fetching a body is what happens once, to the ticket that won.

### 4. The store translates; it does not judge

A declarative filter goes in, and the adapter renders it in its backend's query
language. **Translation is not logic**, and it is all the store is allowed:

```
list({ anyLabel: [...], noLabel: [...] })
   GitHub → ?labels=bug,tech-debt
   Jira   → JQL: labels in (...)
```

Everything that decides *whether a ticket runs and in what order* stays in the
core: `kindOf`, priority, backoff, and the exclusions.

**`agent:hold` is therefore the core's concept expressed in the source's
vocabulary.** The store is told to exclude tickets carrying a label; it never
learns what holding means. A backend without labels maps the exclusion onto
whatever it does have, which is the work an adapter exists to do.

This keeps `recipe.ts:172`'s claim true — *"This is the only reason an issue is
passed over for its labels"* — and it keeps the filter pushed down to the API,
rather than fetching a repository's every issue to reject most of them locally.

### 5. Write-back stays a gate action at `end`, and calls the store

An `end` action already **is** source write-back:

```ts
// packages/conductor/src/end-point.ts:97
type Resolved = { name: string; close: true } | { name: string; labels: string[] };
```

It is only the GitHub client downstream of it that is hard-wired. Moving
write-back *into* the store would cost the reason 0015 made `end` a point at
all:

> Closing the issue, or labelling it, **as a subscriber would be invisible** —
> you could not tell from the recipe whether anything did it. As a gate point it
> is a declared, skippable, **displayable** step.

That sentence holds word for word for a Jira transition. **The action is the
declaration; the store is the mechanism.** Both properties survive.

`labels: ["agent:done"]` is passed to the store verbatim and the store decides
what it means — a label on GitHub, a transition on Jira. Same principle as §4,
from the other end.

### 6. A store is trusted, and is not a plugin

[0036](0036-an-extension-is-a-command.md) makes extensions untrusted processes.
**A ticket store is not one of them**, and the reason is not convenience:

> **A store cannot be untrusted, because the core cannot run on data it does not
> trust.** If the ticket source lies, the core dispatches agents against
> fabricated work, and no sandbox repairs that.

It is trusted the way a database driver is trusted: chosen by whoever operates
the system, running with its credentials, replaced by editing configuration
rather than by a plugin manifest. This is why 0015 and 0016's **"two extensions,
and only two"** survives this decision intact — what was missing was never a
third kind of extension.

## Consequences

- **`source` opens from an enum to a string.** `events.ts:101` is the last
  GitHub-shaped thing in the domain, and it is only a label — nothing reads it.
  A closed enum means adding a Jira adapter edits the core's event schema, which
  is the road `kind` already travelled in `#76`.

- **`recipe.source` collides and one of them must be renamed.** `recipe.source`
  is a block of GitHub label configuration; `WorkItemDiscovered.source` is which
  system a ticket came from. Once stores exist, every reader will take the first
  for the second.

- **`recipe.source.kinds` splits.** Today one array is deliberately three things
  at once — vocabulary, filter and priority (`recipe.ts:153`). The vocabulary
  and the filter are a declaration the store translates; the **priority stays in
  the core**, because which ticket runs first is scheduling.

- **`{{issue}}` should become `{{ref}}`.** `prompt.ts:144` already says *"a
  number is not a ticket"* and then keeps a number, because at the time every
  ticket had one. Jira's is `PROJ-123`.

- **The board's Queued column changes shape.** It asks GitHub on render; it will
  ask a store. `#112` is the same call path and is already slow, so this lands on
  a known problem rather than a fresh one.

## Open

- **Whether `TicketRef` is enough for `admit`.** The split in §3 is evidenced by
  what the *log* stores, and that is a storage fact, not an interface fact. An
  `admit` action that wants to read the body — "reject anything with no
  reproduction steps" — is a reasonable thing to want, and it runs before the
  claim. Nobody has looked at what `admit` actions actually need.

- **`externalRef` uniqueness.** Two stores can both say `123`. The model needs
  `source + project + externalRef` to be the identity; whether the stream id
  already is that has not been checked.

- **Push, not pull.** §3 and §4 describe a store the core asks. GitHub webhooks
  push, and `apps/board/src/app/api/webhook/route.ts` receives them today. A
  store that wants to say "something changed" needs a channel back, and a
  channel back is the thing that makes a store able to flood the queue. Left
  unanswered rather than answered badly.

- **Write-back reliability.** `end` cannot refuse, and a store's `save` can
  still fail. GitHub's answer today is `reconcile`, which converges. Whether
  every adapter must supply a convergence — which would make the port
  considerably larger than §4 suggests — is not decided. The
  [outbox is gone](0022-the-seams.md), so there is no general mechanism to fall
  back on.
