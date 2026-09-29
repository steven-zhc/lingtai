# 0066 — A large answer is a locator on the log, and where it lands is a plugin

**Status** accepted · **Date** 2026-09-28 · **Changes**
[0065](0065-the-default-is-a-plugin.md) §4's row for `design` — what that
step's plugin returns · **Extends**
[0031](0031-a-run-that-never-started.md) §1 from a classification to a location ·
**Makes load-bearing** [0064](0064-a-plugin-declares-the-steps-it-implements.md)
§4's *a plugin declares its own `at`*, which is what lets a second destination
join without the core learning about it · **§6's second paragraph and §7's
last two rows are corrected** (`#299`) — a run-time failure is not retried on
the backoff, and the asking row *can* buy a round; both were written before
anything could produce either ending, and both are now measured by
`packages/conductor/unit/what-a-destination-costs.test.ts`. The corrections are
at §6 and §7 below; §1–§5 and §7's first row stand · **§9's last paragraph — the
test of whether §4 held — is retired** (`#303`): it named a check no destination
could pass, and `packages/conductor/unit/a-locator-the-core-did-not-write.test.ts`
is what measures §4 instead. §4 itself is unchanged

## 1. What is wrong today: the design is bought, used once, and cannot be kept

`design` has been the recipe's since
[#265](https://github.com/steven-zhc/lingtai/issues/265) and **no recipe has
declared it**. Nothing is broken; it has never been worth turning on, because
what it produces cannot be kept.

The document goes three places and survives in none of them:

| | |
|---|---|
| `WroteTheDesign.design` | the in-memory ending, gone when the pass ends |
| `implement`'s prompt | `{{design}}`, or appended — used once |
| `StepPassed.evidence` | **the whole document, uncapped** |

That third one is where it persists, and it is the wrong place twice over.

**It is unbounded.** A `run:` action clips its output to 60 lines and 8,000
bytes before it reaches an event — `command.ts`, *Enough to act on, bounded* —
and an `agent:` action writes whatever the model produced. One action kind knows
to clip what it puts on the log and the other does not, and the one that does not
is the one whose length a model chose. `runtime.budget.evidence` does not cover
this: it is how much of an earlier failure's output the **next prompt** carries.

**And an event is read far more often than it is written.** `task_view` and
`finding_backlog` are folds, and a rebuild replays the whole log — so a document
on an event is carried on every replay to show a person something they will read
once, if ever. The size is not the cost; paying it repeatedly is.

## 2. The reason this is worth building, and it is not taste

A design that is real work — read the ticket, read the code, write down the shape
and the decision that is not obvious — is what makes the implementing agent's job
smaller. **A smaller job can be done by a smaller model.**

`implement` is the most expensive run in a pass. On 2026-09-27/28,
[#269](https://github.com/steven-zhc/lingtai/issues/269),
[#265](https://github.com/steven-zhc/lingtai/issues/265) and
[#266](https://github.com/steven-zhc/lingtai/issues/266) each spent **151 turns
and $20–26** writing the change and hit the ceiling; the pass that started from
an existing branch spent **24 turns and $1.78**.

So *is the design worth buying* has an answer that is measurable: it is worth
buying if it lets a cheaper model implement. **That measurement is impossible
while the design is a paragraph in a prompt.** It has to be a thing with a
location that a person and a later reading can both find.

## 3. The decision

An action that makes something large returns **two things**: the thing, for
whatever in the pass needs it, and a **locator**, for the log.

For `design` that is the document — which still reaches `implement`, because §2
depends on it — and a string saying where the document went.

**`evidence` then becomes what it is for**: a sentence a person reads on a card.
*Wrote a 2.4 kB design to `doc/design/x.md` · 12 turns · $0.38* — not the
document.

## 4. The locator is a string, and only the plugin that wrote it reads it

Not a union, not a tagged shape, not a path type. A `file:` plugin's locator is a
repository path; a `confluence:` plugin's is a page URL; the next one's is
whatever that destination can read back.

**The pipeline must not learn to parse it.** This is 0031 §1's rule — a
classification lives where it is known — applied to a location. The moment the
core understands three kinds of locator, the fourth destination is a change to
the core rather than a plugin, and the extension point has quietly closed.

## 5. Where it lands is a plugin, not a field

`file:` and `confluence:` are two plugins rather than one with a `destination:`.
They do different things — one writes into the tree that `build` and `review`
then read, the other makes a network call and touches no file — fail differently,
and take different fields.

**A shared plugin with a field only one destination uses is the trap this
repository has hit twice**: `worktree.submodules`
([#268](https://github.com/steven-zhc/lingtai/issues/268)) and `queue:`'s three
shared fields ([#269](https://github.com/steven-zhc/lingtai/issues/269)) both let
a half-written block change behaviour silently. A plugin per destination has no
half-written block to write.

`PLUGINS` is not closed against this and says so in its own docblock: *the set is
not closed against new work … a plugin doing something no code did before joins
the same set by the same rules — a key, a schema, and an `at` saying which steps
it serves.* `refs:`
([#240](https://github.com/steven-zhc/lingtai/issues/240)) is the precedent.

## 6. A configuration error is refused when the recipe resolves

A locator whose shape is wrong, a missing field, a destination with no
credentials named: **refused before a worktree, before an agent, before any
money**, which is what the rest of the schema already does and says in those
words.

This is the important half of the failure story because of what the alternative
costs. A configuration error that survives to run time is retried on the
recipe's backoff — **every hour here** — and each retry claims the ticket, cuts a
worktree, dispatches and fails again.

**Corrected (`#299`): it is not retried, and that makes the alternative worse
rather than better.** A configuration error that survives to run time ends the
pass `blocked` and the item then sits there: `outcomeOf` (`pass.ts`) reads a
`did-not-finish` as `blocked`, `conduct.ts` appends `WorkItemBlocked`,
`task_view` folds that to `state: "waiting"`, and `selectRunnable` (`queue.ts`)
drops any row that is not `queued` **before** it consults the backoff at all. So
what it costs is one claim, one worktree, one paid agent — and then a person,
who is being asked to answer a refusal a schema line could have printed before
anything was claimed. The paragraph above priced it as an hourly leak; it is a
single charge and a stop. **The section's decision is unchanged and is if
anything better supported** — only the mechanism was wrong.

## 7. Three failures, three endings, and only one waits for a person

`design` **may not refuse** — it is a rectangle in 0058 §3's list — so none of
these buys a fix round. What it may do is arrive at the router, which 0058
separates from refusing in one sentence: *arriving at the router and refusing are
different things, and only one of them is charged for.*

| what happened | ending | what it costs |
|---|---|---|
| the recipe is wrong | refused at resolve | nothing; the daemon claims nothing until a person fixes the line |
| the destination was briefly unreachable | `did-not-finish` | the pass stops, the item is released, the backoff retries it |
| the destination needs a person | `did-not-finish` carrying `needs-input` | reaches `proposed`, and with no judge declared, a person — **and buys no round** |

**Corrected (`#299`): the last two cost cells are wrong**, and so is the rule
below them for telling the rows apart. Measured against the code by
`packages/conductor/unit/what-a-destination-costs.test.ts`:

| the row | what the cell says | what happens |
|---|---|---|
| unreachable | *the item is released, the backoff retries it* | the item is **not** released: the pass ends `blocked`, the row folds to `waiting`, and the queue passes over it however long its backoff has run (§6's correction) |
| needs a person | *and buys no round* | it buys none getting there — but it arrives with **`design` itself on the offer**, so a `judge:` declared at `when: needs-input` that answers `design` pays for a second design run, up to `runtime.limits.rounds` |

The second cell is this section's own first sentence read backwards. *`design`
may not refuse* is a fact about `refused`, and **a round is bought at the
router**, which is the other transaction — so it settles nothing about what any
of these costs, and the row that reaches the router is the one that can cost
more than once.

**Which runtime failures are the second row and which are the third is left to
measurement.** *Unreachable* and *needs a person* are the same event seen at two
moments. Start everything at the second row — but **not** by watching for retries,
since neither row is retried. The observable is the person: move a failure to
the third row when the person the block reached answers it with something only
they knew — a space, a path, a credential — rather than by running it again.

Two things this row depends on are open:
[#294](https://github.com/steven-zhc/lingtai/issues/294) — nothing can produce a
`needs-input` from `design` yet — and
[#296](https://github.com/steven-zhc/lingtai/issues/296), which splits that
ending from the crash it currently shares a name with.

## 8. An `agent:`'s evidence is bounded, wherever it is declared

Independent of everything above and true today: what an `agent:` action writes
into `evidence` is clipped before it reaches an event, the way a `run:` action's
already is, at `command.ts`'s numbers until something argues for others.

This is not part of the locator design. It is the bug that design made visible,
and it is worth fixing whether or not a `file:` plugin is ever built.

## 9. What it costs

**Two plugins rather than one**, and a plugin is not free: a column in
`step-matrix.test.ts`, a branch in `whyThatPair` — a class that has now landed
five times without one — and a page under `doc/plugins/`, which
[#280](https://github.com/steven-zhc/lingtai/issues/280)'s test makes a red test
rather than a memory.

**A wider contract at the step boundary.** `WroteTheDesign` carries a document
today; it grows to carry a locator, and what an `implement` plugin receives has to
be decided rather than assumed.

**And nothing at all for anyone who does not use it.** `design`'s default is
deliberately nothing (0065 §4), so a recipe that declares no `design:` is
unaffected by every paragraph here — which is also why this can be built and
turned on one machine at a time.

The test of whether §4 held is the **second** destination. If adding it needs a
change in `packages/conductor`, the locator did not stay a string and this
decision needs a superseding file rather than a patch.

**Retired (`#303`): no destination can meet that criterion, and none ever
could.** Both that landed needed `conduct.ts` — `file:` +90 lines (`819941c`),
`file-brief:` +39 (`fa06a7a`) — and the 39 are not a parser but a **port**:
`read`, beside `file:`'s `keep`, the way a `confluence:` would want a `fetch`.
Every plugin that touches the world outside the pass needs one port from the
conductor, and a port is additive. So the diff size measured the wrong thing,
and a real second destination measures it *worse* than a fixture does, because
the port's lines drown the signal. What §4 forbids is **the core branching on
what a locator looks like**, which is a property of the code:
`packages/conductor/unit/a-locator-the-core-did-not-write.test.ts` carries a URL
locator from a fixture destination through the pass and out the other side and
asserts it byte-for-byte at both ends, and its fixture is
`packages/conductor/test/a-url-destination.ts`. **§4 stands and there is no
superseding file** — a check that measures the wrong thing is a correction to a
test, not to a decision — and this note sits here rather than only in that file
for `#299`'s reason: a correction that lives only in a second file gets
reinstated from the first.

## What this does not decide

- **Whether `design:` should be declared on this machine.** A recipe change and a
  separate judgement, and it should follow the first `file:` plugin rather than
  precede it.
- **Whether the design document is committed.** A `file:` plugin writes into the
  worktree; whether that file is committed — and therefore read by `review` and
  merged by the lane — is the plugin's own decision and needs its own sentence.
  `#265`'s guard (`head === startedAt`) means a design commit can no longer stand
  in for the implementer's receipt, so the question is about what belongs in the
  change, not about safety.
- **Whether `implement` can then be a smaller model.** That is the thesis §2 makes
  testable, not a claim this establishes. `runtime.limits` and `runtime.agent` are
  per-pass today, not per-step; a cheaper `implement` needs that to move first.

## Related

- [0058](0058-lingtai-is-a-development-pipeline.md) §2 and §3c — which steps may
  refuse, and the sentence separating that from arriving at the router.
- [0065](0065-the-default-is-a-plugin.md) — the default at a step is a plugin;
  `design`'s is deliberately nothing and stays nothing.
- [0064](0064-a-plugin-declares-the-steps-it-implements.md) §4 — a plugin declares
  its own `at`.
- [0031](0031-a-run-that-never-started.md) §1 — a classification lives where it is
  known. §4 above is that rule applied to a location.
- [0037](0037-an-extension-is-a-command.md) — an extension is a command. A
  destination plugin is the other kind, and the difference is worth stating:
  `run:` extends what a step *checks*; these extend where an answer *goes*.
- [0034](0034-the-run-log.md) — a run log is kept only
  while something is still owed an explanation, which is why it is not where a
  design can live.
