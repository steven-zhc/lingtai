# Checks and spend

*What is checked, who reviews, and what a run and a day may cost*

A recipe decides what must pass before review, which model reviews, and what a run, a ticket and a day may spend.

## What goes at `build:`

A check runs once per attempt, not once per ticket, so its cost is its runtime multiplied by how often your tickets fail it. Keep the checks that refuse.

- Put what makes the worktree usable at `prepared`, the cheapest place to fail. Install dependencies there.
- Put the checks you would not merge without at `build`, and nothing else. `build` refuses, and a refusal buys the agent a round to fix it.
- Keep the AI review at `review`. It is the one check that costs agent money.
- A red check runs twice. A red that turns green on the rerun, whose failing tests are not in your diff and have failed on the base before, does not stop the attempt. It is filed as a minor finding.
- Add a new check only on a green base, or every ticket queues behind it.
- For every check, make it fail once on purpose and watch the attempt refuse.

To stop for a person, declare a [`human:`](plugins/human.md) or [`watch:`](plugins/watch.md) at `proposed:`, never at `merge:`. A [`run:`](plugins/run.md) written at a step that is redone whole must be safe to run twice. Every key and where it may be written is in [Plugins](plugins/index.md).

## Who reviews

A recipe names an agent and a model per action, not once. `agent:` and `model:` sit beside each step's action, and `runtime.agent` is only the default a step's `agent:` overrides.

- Write down, per role, which runtime and model you run and why, in one line in the recipe. Ours are in [`examples/lingtai-recipe.yml`](examples/lingtai-recipe.yml).
- Review with another model family than the writer's, so the reviewer's blind spots are not the writer's.
- Write the review prompt yourself, from your own repository's history. The generic checklist is already built in. What a reviewer lacks is what your codebase keeps getting wrong.
- Check that every runtime a role names is installed and signed in before the first attempt. [Requirements](requirements.md#accounts-you-must-sign-in-to) lists each sign-in.

GitHub Copilot and Antigravity can be named at `implement` and nowhere else, and neither reports a cost. For spend that means `runtime.limits.run.usd` never stops a run on Copilot, and the day's ceiling cannot see it. [Where each agent may be named](reference.md#where-each-agent-may-be-named) has the rest.

## What a run and a day may spend

Treat each limit as an alarm with a reason, and read one that fires as news about the ticket before you raise it.

- `runtime.limits` bounds a run (`turns`, `wall`), an attempt (`refusalFixes`, `conflictResolutions`) and a ticket (`newAttempts`), and `runtime.budget.evidence` sizes the capture your check produces. [The reference](reference.md#what-an-attempt-may-spend--runtimelimits-the-recipes) has each key and its default.
- Read `error_max_turns` as *the ticket was wrong*, not *the number was low*.
- Each automatic path has its own bound, and no restart resets it. Read the ledger early and use `lingtai:hold`.

The day's ceiling is `limits.day_usd` in `~/.lingtai/config.yml`, not in the recipe, and it covers the whole installation. Set it before you run unattended, and before you raise `runtime.concurrency` above 1, which is ignored without one. When the day's recorded spend reaches it, the conductor finishes every pass in flight and takes no new work until local midnight. `lingtai resume` does not lift it; [`lingtai ceiling`](cli.md#lingtai-ceiling) raises it for the day.

The ceiling counts what runs reported plus rate-card estimates for the runs that reported nothing, such as every Codex run. A run nothing could price is unknown and outside the figure.

## Where you see what was spent

- **The footer** on every page that reads the log shows today's spend as two figures against the ceiling, reported and estimated, never summed into one.
- **The bar** turns today's spend to the fail colour once it passes 80 % of the ceiling.
- **A banner** under the bar says when the day's ceiling, a person's pause or a runtime's usage limit has stopped work.
- **`/spend`** is one click from the footer, with spend and the pass limits in full.

## Next

[Safety](safety.md)
