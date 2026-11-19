# Best practices

## TL;DR

- [Write the ticket as the prompt](#write-the-ticket-as-the-prompt): the issue body is pasted whole into the agent's prompt, so write it to be worked from.
- [Size it for one attempt](#size-it-for-one-attempt): one ticket, one attempt, a result you can check in one sitting.
- [Order and release](#order-and-release): a kind label sets priority, a chain goes in *blocked by*, and nothing is released unread.
- [Choose a model for each role](#choose-a-model-for-each-role): a recipe names a runtime and model per role, and a reviewer from another family has other blind spots.
- [Gate what has failed](#gate-what-has-failed): keep the gates that refuse, delete the ones that never do, and watch each one fail once.
- [Read a failure in this order](#read-a-failure-in-this-order): a rule answers first, a judge or triage names a cause, a person is asked for a limit, a question or the environment; read receipt, run log, triage, then events, narrowest view outward.
- [Set the limits](#set-the-limits): treat each limit as an alarm with a reason, and read one that fires as news about the ticket.

The habits that make Lingtai cheap and predictable. Every section is its rule,
a short *do this* list and one figure that shows why. The settings themselves
are in [`reference.md`](reference.md#policy--every-number-that-decides-behaviour).

## Write the ticket as the prompt

**The rule.** The issue body *is* the agent's prompt, pasted whole:
`prompts/ticket.md:5` is `{{body}}`. Since #643 a fix of a refusal and the cold
reviewer read it too (`packages/conductor/src/conduct.ts:3929` puts the body
into the fix brief). What the body leaves undecided, the agent guesses and the
reviewer refuses.

**Do this.**

- Open with a four-row table: **Problem**, **Want**, **Fix**, **Watch out**.
  **Watch out** is the trap: what costs money, fails silently, or has been got
  wrong before. Leave the row out when there is no trap.
- Under a rule, **Evidence**: the exact output, and `file.ts:line` for every
  claim about the code. A claim nobody found the line for does not go in.
- **Edges**: one line per case and its rule. **Out of scope**: what a reviewer
  must not hold the ticket to.
- **Done when**, as checkboxes that a person or a test can check.
- **Related**, saying what the other ticket *decided*. Give every issue a kind
  label: `packages/conductor/src/discover.ts:205` skips one with none
  (`skip: "no-kind"`).

`implement`'s brief asks the agent to **commit each piece that works as it
finishes it**, so a run that is cut off is redone from its head and loses only the
piece in progress (`packages/conductor/src/prompt.ts:400`). Write the ticket so that
its pieces can be committed one at a time.

On 2026-11-01 two passes of #811 failed because the reviewer chased a race with a
projection rebuild; one line under *Out of scope* would have said it was not
wanted.

## Size it for one attempt

**The rule.** One ticket, one attempt, and a result you can check in one sitting.
Before you file, ask: *can I name the shape of the diff that would close this?*
If the honest answer is *it depends what the agent finds*, it is research wearing
a ticket's clothes, and a run is the most expensive way to do research.

**Do this.**

- Split along seams. A ticket that makes four decisions is four tickets.
- Give documentation its own ticket. A documentation requirement added to a
  code ticket grows it every round.
- If a ticket touches the same files as another, make it wait for the other.
- If the ticket turns on a fact about a dependency, say how to check that fact.
  If you cannot say how, that uncertainty is the item: file it as one.

A ticket still too big for one run is **split by the system, once** (`ticketSplits`):
triage's plan opens up to 8 children, and the parent keeps its `## Done when`
and waits behind them. When the last child closes it is taken once more, and that
list is what it is checked against. So the parent's `## Done when` is the
contract; write it as if nobody will read the children.

On 2026-09-29 with the same configuration, `implement` cost $0.92 for a 27-turn
ticket (#317) and $17.24 for a 239-turn one (#308); switching the model from Opus
to Sonnet was worth about 2.19× per turn, so ticket size is the bigger lever.

## Order and release

**The rule.** The kind label decides priority, a chain goes in GitHub's own
*blocked by*, and nothing is released that you have not read. These rules are
about GitHub issues.

**Do this.**

- Give every issue a kind label. The recipe's `source.kinds` is the vocabulary,
  the filter and the priority order at once; currently `bug`, `tech-debt`,
  `feature`, `documentation`, in that order, and the earlier kind wins when an
  issue carries two.
- Put a chain in *blocked by*, never in the body. The queue passes over a ticket
  with an open blocker and takes it again on its own once the last blocker
  closes (`packages/conductor/src/discover.ts:219`, `blocked-by`; its comment at
  `:212-214` says it counts *open* blockers, not total).
- Hold by default with `agent:hold`, and remove it from what you have read. It
  works only because it is in `source.exclude`; a label you have not put there
  excludes nothing.
- For the first runs against a repository, use
  `lingtai run <project> --issue <n> --no-merge`: discovery, claim, worktree,
  agent and gates, and then it stops and asks.
- To decide something first, `lingtai ask <project> --issue <n> "<question>"`
  holds the ticket and `lingtai answer` hands it back with the answer on the
  record; `lingtai now <project> --issue <n>` jumps the backoff.

A well-written ticket with no kind label is invisible: guessing a kind would put
unclassified issues at the front of the queue.

## Choose a model for each role

**The rule.** A recipe names a runtime and a model per action, not once:
`agent:` and `model:` sit beside each step's action
(`packages/recipe/src/recipe.ts:225-234`), and `runtime.agent` is only the
default a step's `agent:` overrides. This page records one repository's choices
as of 2026-11-01, not a recommendation; models change faster than it does.

**Do this.**

- Write down, per role, which runtime and model you run and the reason in one
  line. The recipe's comments are where ours live
  ([`examples/lingtai-recipe.yml`](examples/lingtai-recipe.yml)).
- Decide per role whether its work is worth the model's price. Ours: Opus once
  at `design:` (`:60-63`), Sonnet at `implement` (`:84-89`).
- Decide whether your reviewer should share the writer's blind spots; ours does
  not: `review` runs Codex, *"another model family than the writer's, so its
  blind spots are not the writer's"* (`:117-132`).
- Write the review prompt yourself, from your own repository's history: the
  generic checklist is already built in (`packages/actions/src/agent-action.ts:182`,
  `CHECKLIST`); what a reviewer lacks is what *your* codebase keeps getting wrong.
- Check that every runtime any role names is installed and signed in, before the
  first attempt ([requirements](requirements.md)).

Over tickets that landed in October 2026 (measured 2026-11-01), work was 56% of
spend and answering refusals 35%: answering refusals is a third of the spend, which
is why the ticket and the review prompt matter more than the model.

## Gate what has failed

**The rule.** A gate runs once per attempt, not once per item, so its cost is its
runtime multiplied by how often your items fail — the number nobody estimates.
Keep the gates that refuse and delete the ones that never do.

**Do this.**

- Put what makes the worktree usable at `prepared`, the cheapest place to fail,
  and the checks you would not merge without at `build`, and nothing else.
- Keep the AI review at `review`; it is the one action that costs agent money.
- Use `watch:` to stop for a person on a path, with no process and no agent.
  Declare a hold for a person at `proposed:`, never at `merge:`: `human:` and
  `watch:` are refused at `merge`, and the lane is the last action there.
- Add a new gate only on a green base, still: a red base no longer parks
  tickets, it passes them over as `base-red` and each continues from its saved
  head when the base is green (`packages/conductor/src/base-red.ts:1-10`), but a
  new gate that is red on the base means every ticket queues behind it.
- A red check runs twice. A red that turns green on the rerun, and whose failing
  tests are not in the diff and have failed on the base before, does not stop the
  attempt: it is filed as a minor finding.
- Every plugin is `replay: safe` or `external`, and an `external` one — one that
  writes outside the worktree — is refused when the recipe resolves at `prepared`,
  `design`, `implement` or `review`, because those steps are redone whole. Write
  a `run:` there only if it is safe to run twice.
- For every gate, check that it runs and that you have seen it fail.

Ten steps, closed forever — `claim`, `admit`, `prepared`, `design`,
`implement`, `build`, `review`, `proposed`, `merge`, `end`
([reference](reference.md#step--10-closed-forever)). Fourteen action kinds, of
which four produce a verdict, two run for effect, one keeps what a step made,
one reads it back, and six are names for code the attempt calls itself and no step
yet reads
([reference](reference.md#gate-action--14-keys-of-which-4-produce-a-verdict)).

`#58` was a `merge` point that **did not execute**, so a run without `--no-merge`
merged itself into `main` unapproved; a point that never refuses and a point that
never runs look identical from outside.

## Read a failure in this order

**The rule.** A failure is answered in three layers, and a person is the last of
them (0108 §6, §16):

1. **A rule** answers what is mechanical or transient, free: no agent is paid.
2. **A cause the system acts on.** A judge (within the bounds) or triage (where
   a wait would open) **names a cause** and never an action; the system chooses
   the action and carries it out.
3. **A person**, asked only for a *limit* (a bound is spent), an *unclear*
   requirement or a broken *environment*.

So a wait on the board means a rule, and a judge or triage, have already
answered what they could, and it is one of those three kinds. A wait the system
resolved itself is **a line on the card**, not a wait: *Triage read only
unfinished; the step is being redone — 2 of 3 redos used*.

Then read a failure from the narrowest view outward: the receipt, then the run
log, then triage's summary, then the events. The instinctive order is wrong: on
2026-09-08 *"why is this not moving?"* was asked of `#80`, `#87`, `#89` and `#94`
in a single day and **answered wrongly four times**
([0032](decisions-archive/0032-the-page-is-organised-by-attempt.md)).

**Do this.**

- Open the attempts ledger on `/task/<id>` first: one row per attempt, with its
  prompt, files, gates and outcome. Read the outcome word on the failing row
  before anything else; `never-started` is Lingtai's own failure, not the
  ticket's.
- Open the refusing gate's evidence through the pointer on the row.
- If the item has not landed, tail the run log: `pnpm lingtai attach <runId>`. A
  run that landed has no log.
- Read triage's summary for a waiting ticket as the cause it named; what was
  done with it is the system's, and the card says which bound it spent. When a
  card says `disagreement`, a fixer's `Disputed` is waiting for a judge to rule
  on it; it is a judgement to make, not a repair, and a fixer that committed
  nothing may have declined.
- When you must settle a behavioural claim, read `events` and cite the seq.
  Absence from documentation is not absence from the program (`#89`, $13.04).

## Set the limits

**The rule.** Every limit is in the recipe, so a repository can read its own
policy without opening Lingtai's source. Treat each as an alarm or a bound with
a reason, set it to the failure it protects against, and read one that fires as
information about the ticket before you raise it. The values and defaults are in
[`reference.md`](reference.md#policy--every-number-that-decides-behaviour).

**Do this.**

- Set `runtime.limits` — `run` (`turns`, `wall`), `attempt` (`refusalFixes`,
  `conflictResolutions`) and `ticket` (`newAttempts`) — so that together they say
  what a ticket may spend in `implement` runs, not how long a drain waits. The
  old keys `rounds` and `restarts` are refused by name, and the refusal names
  the key that replaced each.
- Set the daily ceiling `limits.day_usd` in your installation config before you
  run unattended.
- Read `error_max_turns` as *the ticket was wrong*, not *the number was low*.
- Size `runtime.budget.evidence` to the capture your gate produces; this
  repository sets `evidence: 10200` (`examples/lingtai-recipe.yml:245`).
- Each automatic path has its own bound, so something does cap the ordinary
  attempts: `newAttempts` for a ticket started over, `ticketSplits` for a ticket
  split, `personAsks` for how often it asks you. They are counted on the
  attempt's or the ticket's own stream and no restart resets them
  ([reference](reference.md#what-an-attempt-may-spend--runtimelimits-the-recipes)).
  Read the ledger early and use `agent:hold`.

`source.backoff` stops blind retries: the old harness re-ran #58 and #59 five
times for roughly $29 exactly that way
([0028](decisions-archive/0028-the-backoff-is-the-recipes.md)).

## What to read next

- [`examples/lingtai-recipe.yml`](examples/lingtai-recipe.yml) — the recipe this
  repository runs, as of 2026-11-01; every role and limit above is a line in it.
- [`requirements.md`](requirements.md) — which runtimes and keys a recipe needs
  before its roles can run.
- [`operating.md`](operating.md#when-something-refuses) — what every refusal
  means, in a table, when one of the above turns into a message on your terminal.
- [`reference.md`](reference.md#policy--every-number-that-decides-behaviour) —
  every number that decides behaviour, with the column that says whether it is
  the recipe's or Lingtai's.
- [`doc/decisions/`](decisions/) — the arguments behind all of it.
- [`doc/experiments/`](experiments/) — things actually run against real data,
  with their results, including the ones that did not work.
