# 0040 — `rounds` bound depth; a second ceiling bounds breadth

**Status** accepted · 2026-09-12 · extends
[0039](0039-the-worktree-is-the-whole-of-a-pass.md) §2–§3 and contradicts none
of it; **off by default, and the default is what the evidence supports**

## Context

0039 §2 built the inner loop on one sentence:

> The first is cheap because the work is still there.

That is unarguable for a conflict and for a red build — the branch is finished,
the remedy is mechanical, and re-implementing it would be absurd. It was
extended to a refused **review** without noticing that a review says one of two
very different things, *this line is wrong* or *this approach is wrong*, and
`rounds` cannot tell them apart.

[Experiment 011](../experiments/011-patching-versus-starting-over.md) ran both
arms by accident on `#144` — same ticket, same cold reviewer, two hours apart:

| | patch in place | start over, carrying the findings |
|---|---|---|
| ceiling | `rounds: 2` | `rounds: 10` |
| reviews | refused, refused, refused | **passed** |
| rounds used | 2 of 2 | **0 of 10** |
| cost | **~$12** | **$6.56** |
| outcome | asked a person, nothing landed | **landed `b8c583d` unattended** |

Half the money, and it landed.

**What the rounds were actually buying.** Each refusal in the first arm was
about the code the round before it had written — not the original diff read more
harshly. Review 3's finding is a deadlock that did not exist until round 2
created it:

```
major packages/daemon/src/daemon.ts:124 — `startBeacon` sits between
`acquireDaemonLock` and the try/catch that releases the lock, so a failed
first beat throws out of `startDaemon` with the conductor lock held by a
process that then hangs forever.
```

**`rounds` bounds depth. That failure was breadth.** A round buys another
attempt at *this* approach; when the approach is the defect, every round pays to
get further from a fix, and the ceiling's only contribution is choosing when to
stop paying.

### Most of the mechanism already existed

This is why the decision is small. `attempts.ts` already carries everything into
a fresh pass:

```
// packages/conductor/src/attempts.ts
### What attempt 1 produced
11 file(s), +685 −44, committed on `agent/144` at `8634c5d`.
**Your worktree is cut fresh from the base branch, so those commits are not in it.**
If building on them beats starting over, `git fetch origin agent/144` and take
what is worth keeping from `8634c5d`; if it does not, ignore them.

### What refused attempt 1
  major packages/daemon/src/daemon.ts:124 — … (full failure scenario)
```

The findings travel, the branch is named, its sha is given, the fetch is spelled
out, and the *judgement* — build on it or start over — is handed to the agent
explicitly. **The prompt was complete; the branch it names was not.** What was
missing was the decision to take it — a spent ceiling asked a person, and the
person typed `requeue` — and one `git push`.

**A pass that spends its rounds has pushed nothing.** The only push in a pass is
after `proposed` passes, so a review that kept refusing leaves its commits in a
worktree that is cut `--force --detach` and deleted when the pass ends: no ref
on origin, none in the mirror. Whatever made `agent/144` fetchable for arm B, it
was not the refused pass, and `git fetch origin agent/144` off a spent one would
have failed with `couldn't find remote ref` — the prompt above lying about the
one thing it hands the agent. So a restart pushes the approach it is abandoning
before it names it, and before the arm is on the log: a push origin refuses
leaves no arm, and the ceiling is not spent on an approach nobody can read.

**Two refs, one per question.** `agent/<n>` is the name the prompt above
spells out, so it has to be the arm the *next* pass would build on — which
means the arm after that takes it over, force, from a history sharing no
ancestor. Every arm therefore also gets a ref of its own,
`agent/<n>-restart-<k>`, and that is the one `PassRestarted` records. Without
it the card at the end of §3 — every arm's findings, each headed by the branch
and sha it was refused at — would name commits origin dropped two arms ago, and
would do it precisely when a person is being asked to compare the arms.

## Decision

### 1. Two ceilings, meaning two different things

```
refusal         → round      patch, same worktree, bounded by `rounds`
rounds spent    → restart    fresh pass from the base, findings carried
restarts spent  → a person
```

```yaml
runtime:
  limits:
    turns: 150      # inside one agent run
    wall: 1h        # inside one agent run
    rounds: 3       # how many times a pass sends the agent back
    restarts: 0     # how many times a spent pass starts the ticket over
```

**The second ceiling matters more than the first**, because a loop that restarts
without a bound is a money pump on a ticket that is simply wrong. The person is
not removed; they are moved to where their judgement is worth something, which
is after the *second* approach has failed rather than after the first.

### 2. A restart is a push and a release

The push of the abandoned approach, then `PassRestarted` on the work item's
stream, then the ordinary release. The last two are in that order as
`RepairRequested`'s are, because the fold has to carry the arm before anything
can claim the next one; the push is first because the event names a branch and a
sha, and an event that names a ref nobody published is a lie the next prompt
repeats. **There is no new prompt**: the next claim is an ordinary pass, and
`attempts.ts` is what makes it work — which is exactly why the ref it spells out
has to exist. There is deliberately no `pendingRestart` beside `pendingRepair`,
because a repair has to *become* the next run and a restart does not.

`source.backoff` applies. A repair is exempt from it because the next claim is
the repair and is told what went wrong; a restart is an ordinary claim, and an
arm that comes straight back is the whole queue on a repository running one
ticket at a time.

### 3. Only a judgement is worth another approach

In code (`decideRestart`), not by recipe: **no number a project writes down
should be able to make a typecheck error buy a fresh worktree.** A red build and
a conflict stay in the worktree, because for those *the work is still there* is
a fact and not an assumption — which is 0039 §2 kept rather than contradicted.

Three other refusals are excluded and each names itself:

- **A fixing agent that declined.** 0039 §5 gave it exactly one way to say
  *this refusal is wrong or is not this change's*: commit nothing. Restarting on
  that would spend money to bury the one verdict the loop was built to carry.
- **A refusal with no criterion.** `decideFix` buys nothing for a gate with
  nothing to hold a fixer to; buying a whole pass for it here would be
  incoherent one extent up.
- **Anything else already asking for a person** — a `human:` action, a `watch:`
  that saw a migration, a repair. Releasing the item would throw their question
  away. `--no-merge` is not one of these: it says *do not merge without me*, and
  a restart merges nothing.

Reaching the second ceiling blocks with **every arm's findings on the card**.
Each arm's refusal lives on a run stream no later pass reads, which is why
`PassRestarted` carries the findings and not a count of them: arm A's third
refusal in 011 was a defect round 2 created, and a person shown only the last
arm cannot see that.

### 4. The default is zero, and zero is today's behaviour

0025 §3's rule for a spending default — *the smallest number that makes the
feature exist* — would say one. **It does not apply here.** That rule is about
not taking a feature away by defaulting it too low, and this default takes
nothing away: until a project writes a number down there is no feature to take.
What is being avoided is the opposite mistake — turning a new way to spend an
agent on for every project on the strength of **n = 1**.

What the evidence does not support, and must not be glossed:

- **n = 1.** One ticket. `#144` was a design question with a small surface; a
  ticket whose approach is right and whose execution is fiddly would plausibly
  run the other way, and that is the case `rounds` exists for. 011 did not
  produce one.
- **No second restart has ever been observed.** The interesting failure — two
  fresh starts both exhausting their rounds — has not happened, so §1's second
  ceiling is argued and not measured.

So what changes the default is runs in `doc/experiments/`, with both arms
recorded, on more than one ticket. Until then the mechanism is built and off.

### 5. `passCeiling` multiplies again

What a ticket may cost is `(restarts + 1) × (rounds + 1) × wall`, and the one
function that says what a pass costs says it. A second ceiling multiplying the
first, described by a sentence that did not know about it, would be the
2026-09-10 drain failure again with more money on it.

The wording is careful about whose bound each is: a pass is what an operator
waits for, and a restart happens *after* a pass has ended and the item has been
through the backoff — so the product is what the ticket may cost in agent time,
not how long any one command blocks.

## Consequences

- **`FixDecision` carries a rule and not only a sentence.** `decideRestart`
  turns on *was the ceiling what stopped this*, and reading `decideFix`'s `why`
  to find out would have made every edit to that wording a change to what money
  is spent.
- **A card says which arm, not only how many attempts.** `attempts` counts
  claims, so a claim after a crash, after a backoff and after an abandoned
  approach all read as `attempt 3`. `restarts` and `restarts_of` are new
  columns on `task_view`, so a rebuild is needed to see them on history:
  `lingtai projection rebuild task_view`.
- **The board and `lingtai status` read one sentence.** `describeArm`, beside
  the fields, for `describeHold`'s reason: two places wording the same fact
  differently is the failure this repository keeps finding.
- **0039's last Open is narrowed and not closed.** *What bounds re-claiming
  after a run that ended* — a crash or a quota stop releases the item and
  `source.backoff` holds it an hour before it is claimed again, for ever. This
  decision bounds the one re-claim it is about, a judgement the reviewer would
  not accept, and leaves that one exactly where it was.

## Open

- **Whether the third arm is a person at all.** At `restarts: 1` the person
  arrives after two approaches. Whether two is the right number is the thing
  §4 says is unmeasured; it may turn out that the honest answer is *one
  approach, then a person* for some kinds of ticket and *three* for others,
  which is a per-ticket judgement no ceiling expresses.
- **The arms are not compared to each other.** Nothing reads two arms' findings
  together and asks whether they refused the *same* thing. If they did, the
  ticket is probably wrong in a way a third approach will not fix, and that is
  the signal a person is currently being paid to notice.
