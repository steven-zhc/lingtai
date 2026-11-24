# Best practices

## TL;DR

- [Choose a model for each role](#choose-a-model-for-each-role): a recipe names a runtime and model per role, and a reviewer from another family has other blind spots.
- [Gate what has failed](#gate-what-has-failed): keep the gates that refuse, delete the ones that never do, and watch each one fail once.
- [Set the limits](#set-the-limits): treat each limit as an alarm with a reason, and read one that fires as news about the ticket.

The habits that make Lingtai cheap and predictable. Every section is its rule,
a short *do this* list and one figure that shows why. The settings themselves
are in [`reference.md`](reference.md#policy--every-number-that-decides-behaviour).

## Choose a model for each role

### Copilot or Antigravity at `implement`

GitHub Copilot and Antigravity can be named as the `agent:` of an action at
`implement`, and nowhere else (#1300 is the follow-up for review and judges).
Read what each cannot do before choosing one:

- **Implement only.** Not `runtime.agent`, not `discuss`, not triage, not
  `design`, `review` or any `judge:`; the recipe is refused by name.
- **Unpriced.** Neither reports a cost, so `run.usd` never stops a run. Only
  `turns` and `wall` bound one. The day's ceiling cannot see Copilot; for
  Antigravity it counts an estimate where a rate for its model has been fetched.
- **Antigravity runs unsandboxed**, and a recipe with `sandbox.required: true`
  cannot name it.

Install and sign in: for Copilot, `copilot login` (or `gh`'s login) when the
project is unsandboxed, and `lingtai token copilot` when it is sandboxed
([requirements](requirements.md#tokens-for-a-sandboxed-run)). For Antigravity, `agy acp --login`, and
Lingtai must run in your GUI login session, not over ssh, because the sign-in
lives in the keychain (019 E10). Versions measured on 2026-11-19: Copilot CLI
1.0.112, Antigravity CLI 1.5.9. The full table is in
[the reference](reference.md#where-each-agent-may-be-named).

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
  Read the ledger early and use `lingtai:hold`.

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
