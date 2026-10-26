# Coming from Symphony

If you run OpenAI's [Symphony](https://github.com/openai/symphony) and are
weighing Lingtai, this page says what corresponds to what, what you gain and
give up, and how to move a project. Every Symphony claim links to its
[SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md).

## The one difference

Both tools watch a tracker, give each ticket a workspace and hand it to a coding
agent. They differ in **where the pipeline lives**.

**In Symphony it is in the prompt.** The Markdown body of `WORKFLOW.md` is the
per-issue prompt template
([SPEC §5.4](https://github.com/openai/symphony/blob/main/SPEC.md)), and the
agent normally performs the ticket writes — state transitions, comments, PR
links — through tracker tools that run with the configured tracker credential
([SPEC §1, §11.5](https://github.com/openai/symphony/blob/main/SPEC.md)). The
scheduler is deliberately a reader of the tracker. Its own state is held in
memory, and after a restart it polls again and dispatches what is still eligible
([SPEC §14.3](https://github.com/openai/symphony/blob/main/SPEC.md)). The
pipeline is as flexible as the prompt: you change it by editing one file in
prose.

**In Lingtai it is outside the agent.** A pass is ten fixed steps
([the pass](the-pass.html)): the `build` check, a cold reviewer, the merge lane.
The agent cannot skip them or reach them, and it never holds a tracker
credential. Everything that happens is appended to a log, so a restart loses
nothing.

That is a trade. What you get is a pipeline an agent cannot talk its way past.
What you give up is a pipeline you edit in prose, Linear, and more than one agent
at a time.

## The concept map

| `WORKFLOW.md` | Lingtai |
|---|---|
| `tracker.kind` ([SPEC §5.3](https://github.com/openai/symphony/blob/main/SPEC.md)) | `source:` — GitHub only today (#340) |
| `tracker.required_labels` | the kind labels the recipe's `source.kinds` names (`bug`, `feature`, …); an issue with none is invisible to the queue |
| `tracker.active_states`, `tracker.terminal_states` | none — Lingtai keeps its own states for a ticket, and a closed issue is finished |
| `polling.interval_ms` | not a recipe setting: the daemon polls on its own schedule, for the whole machine |
| `workspace.root`, `hooks.after_create` (cloning) | a worktree Lingtai cuts for each pass |
| `hooks.after_create` (installing dependencies) | the install command you give `lingtai add --install` |
| `agent.max_concurrent_agents` | one at a time today (#341) |
| `agent.max_turns` | `runtime.limits.turns`, per run, on the `claude-code` runtime only. The `codex` runtime enforces `wall` alone, and `lingtai doctor` fails a numeric `turns` there, so on Codex bound a run with `runtime.limits.wall` instead ([reference](reference.md)) |
| `agent.max_retry_backoff_ms` | `source.backoff`, `1h` by default and flat; `lingtai now <project> --issue <n>` takes one ticket ahead of the queue |
| `codex.command` | `runtime.agent: codex` |
| the prompt body (Liquid) | the `prompt:` beside an `agent:` at `implement:` — **project guidance only**, see below ([`agent:`](plugins/agent.md)) |
| reloading `WORKFLOW.md` without a restart | the recipe is resolved again on each pass |

## What Lingtai does not have yet

- **Linear as a source** (#340). Symphony's reference tracker is Linear; Lingtai
  reads GitHub issues.
- **Several agents at once** (#341). Lingtai conducts one ticket at a time.

## Why there is no importer

Most of a `WORKFLOW.md` body is pipeline instruction — move the ticket to this
state, open the PR, answer review comments, land it. None of that may reach
Lingtai's brief. The agent has no tracker to move, and Lingtai does not open
pull requests or answer review comments at all: it runs the checks, has a cold
reviewer read the diff, and the merge lane merges into the base branch locally
and pushes. A branch that only accepts pull requests cannot be landed that way. And since the reference tracker differs, almost no real
`WORKFLOW.md` could be imported today anyway. So moving a project is three steps
done by hand.

## Moving a project

1. **Initialize, then add the repository.** Run `lingtai init --project github`,
   then `lingtai add <owner>/<repo> --base main`. `init` asks nothing about the
   recipe on a GitHub project; `add` does, and writes it — pass your install and
   build commands there as `--install` and `--build`, as the tutorial's
   [GitHub part](tutorial.md) does. Label the issues you want taken with one of
   the recipe's kinds.
2. **Paste your project guidance into the `prompt:` beside an `agent:` at
   `implement:`** — the conventions, and how to validate a change. Leave out every
   instruction about states, PRs, review comments and landing, and every
   `{{ }}` and `{% %}`.
3. **Run it** and read the board.

**Watch out for the placeholders.** Lingtai fills `{{issue}}`, `{{title}}`,
`{{body}}`, `{{checks}}` and `{{failure}}` in its own ticket template, not in a
recipe's `prompt:`. Written there, `{{issue}}` reaches the model as five literal
characters and nothing warns you ([placeholders](reference.md#prompt-placeholder--6)).
You do not need them: the ticket, the checks and the last refusal are already in
the brief.
