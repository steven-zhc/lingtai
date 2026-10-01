# Lingtai is open source — draft launch post

Drafts, not published. Three cuts of one story: a blog post, a Hacker News
submission, and a short thread. Numbers are from `doc/experiments/`; check each
against the current log before posting.

**Before posting, see the checklist at the end. There is no `LICENSE` file in
the repository yet.**

---

## 1. Blog post

### Lingtai: an event-sourced scheduler for coding agents, which builds itself

Coding agents can write a good commit. Leaving one running is harder, because
three questions start piling up:

- *What state is this ticket in?*
- *Why did this not merge?*
- *What is waiting on me?*

Usually the answers are scattered. State lives in labels, history in PR
comments, and cost in a terminal nobody saved. You can only answer them if you
already know where to look.

**Lingtai** makes all three the same query against the same table. It is an
append-only event log with one agent loop driving it. Everything else, the
board and the CLI included, is a projection of that log or a subscriber to it.
Nothing keeps private state, so the board and the CLI cannot disagree, and
every table can be dropped and rebuilt from the log.

Today we're open-sourcing it: **github.com/steven-zhc/lingtai**

#### What it does

You point Lingtai at a GitHub repository. It takes labelled issues one at a
time and walks each through ten fixed steps:

```
claim → admit → prepared → design → implement → build → review → proposed → merge → end
```

- **One worktree is the whole of a pass.** A branch is cut from your base, and
  the install, the agent, the build, the review and the merge all happen in it.
- **A refusal is answered by the agent still standing in the worktree.** A red
  build or a refused review sends the work back with the reason attached, up to
  `rounds` times. When the reviewer is objecting to the approach, the ticket
  starts over from the base and carries every finding forward (`restarts`).
- **Only one place waits on a person.** When every ceiling is spent, or a step
  asks a question only you can answer, the ticket lands in *waiting on you*.
  Nothing else stops for a human unless you declare it.
- **The steps are fixed; what runs at each is yours.** That is decided by one
  file on your machine, `~/.lingtai/<project>/recipe.yml`:

```yaml
steps:
  prepared:
    - run: pnpm install
  implement:
    - agent: claude-code
      turns: 150
      rounds: 3
  build:
    - run: pnpm typecheck && pnpm test
  review:
    - agent: claude-code      # a cold reviewer, in its own context
```

Adding a security scan or a second reviewer is one more line in the recipe, with
no change to the core.

#### What it deliberately doesn't do

- **It commits nothing to your repository.** No config file, no bot account, no
  CI job, no label state machine. If you delete Lingtai tomorrow, the repository
  has nothing to clean up.
- **It sends nothing anywhere.** No telemetry, no analytics, no account. Cost and
  duration are recorded on *your* log, in a Postgres you choose.
- **It doesn't hide a check that didn't run.** A step with nothing configured is
  drawn as skipped rather than left out, because "absent" and "silently not run"
  have to look different.
- **It refuses cheaply and early.** A missing environment value refuses the
  whole project before an issue is claimed: no worktree, no agent, no money
  spent.

#### It builds itself

Since Phase 4, agents dispatched by Lingtai have worked the tickets in Lingtai's
own repository: a bug, a feature, a doc fix, through the same build and cold
review, merged unattended. The repository is full of what that taught us,
written down as experiments rather than impressions:

- **Patching vs. starting over** ([011](../experiments/011-patching-versus-starting-over.md)).
  On one ticket, patching in place spent ~$12 over three refused reviews, and
  each refusal was about a defect the previous fix had introduced. Starting
  fresh with those findings handed to the new agent cost $6.56, passed review
  first time, and landed. That result is why `restarts` exists beside `rounds`.
- **Where the turns go** ([012](../experiments/012-where-the-turns-go.md)).
  Over two weeks of its own log, cost was linear in turns at about $0.10 each,
  and half the turns were spent in the fix loop.
- **The loop closes unattended** ([006](../experiments/006-the-loop-closes-unattended.md)).
  The first fully hands-off run took an issue, did 15 turns for $0.83, landed six
  files, and closed the issue itself. The completion event then triggered the
  next pass, which found the queue empty and stopped.

Every decision is an ADR in `doc/decisions/`, and every claim about behaviour
is checked against the event log rather than argued from the code.

#### Try it

```bash
curl -fsSL https://lingtai.hczhang.com/install.sh | sh
lingtai init        # Postgres, an agent runtime (Claude Code or Codex), a GitHub App
lingtai add         # point it at a repository
```

Then label one small issue and watch it move across the board. The
[tutorial](../tutorial.md) goes from a new machine to one merged issue.

#### Honest status

It's pre-1.0 (0.9.0). Nothing has run unattended long enough to have earned
blind trust, and `lingtai pause` exists because watching it is the right way to
use it today. One machine, one conductor at a time, GitHub only, Postgres only.

If you run coding agents and keep wondering *why didn't that merge*, we'd love
for you to try it, break it, and open an issue. An agent may well pick it up.

---

## 2. Hacker News

**Title** (≤80 chars):

> Show HN: Lingtai – an event-sourced scheduler for coding agents that builds itself

**First comment:**

> I built Lingtai because I kept leaving coding agents running and then couldn't
> answer three questions: what state is this ticket in, why didn't it merge, and
> what's waiting on me. So everything is one append-only Postgres log, and the
> board and the CLI are just folds over it.
>
> It takes GitHub issues one at a time through a fixed pipeline (claim, worktree,
> install, implement, build, cold review, merge). A failed step sends the work
> back to the same agent with the reason, and after enough failures on the
> approach itself it starts over from the base. It only stops for a person when
> every retry ceiling is spent. What runs at each step is a YAML recipe on your
> machine, and nothing is committed to the managed repo.
>
> It has worked its own tickets for the last few weeks, and the repo keeps
> what that taught us as experiments with numbers. My favourite: on one ticket,
> patching after a refused review cost $12 and never landed, while starting over
> with the findings cost $6.56 and landed first time.
>
> It's pre-1.0 and I'd treat it as something to watch, not something to forget
> about. Happy to answer anything.

---

## 3. Short thread (X / Bluesky / LinkedIn)

1. Lingtai is open source. It's a scheduler for coding agents built on one
   append-only event log: issues go in, merged commits come out, and every
   "why didn't this merge?" has an answer in the log.
   github.com/steven-zhc/lingtai
2. Ten fixed steps: claim → worktree → install → implement → build → cold
   review → merge. What runs at each step is one YAML file on your machine.
   Nothing gets committed to your repo, and nothing is sent anywhere.
3. A failed step goes back to the same agent with the reason attached. If the
   approach itself is wrong, it starts over from the base and carries the
   findings. It only stops for you when every ceiling is spent.
4. It builds itself: Lingtai's own tickets are worked by agents Lingtai
   dispatched. One lesson, with numbers: patching after a refused review cost $12
   and didn't land, while a fresh start with the findings cost $6.56 and did.
5. Pre-1.0, so watch it rather than trust it. `curl -fsSL
   https://lingtai.hczhang.com/install.sh | sh`, then label one small issue.

---

## Before posting — checklist

- [ ] **Add a `LICENSE`.** There is none in the repository and no `license`
      field in any `package.json`. Without one the code is not legally open
      source, whatever the post says. Pick one (MIT or Apache-2.0 are usual), add
      it at the root, and set `"license"` in the package manifests.
- [ ] **Bring the README in line with `doc/the-pass.html`.** The README still
      describes "the five places it stops" (`admit · prepared · proposed · merge
      · end`) and "one projection". The current model is ten steps, and there
      are two projections (`task_view`, `finding_backlog`). The README is the
      first thing a visitor from the post reads.
- [ ] Make the repository public, and check its history for secrets
      (`.env*`, connection strings, tokens in experiment logs).
- [ ] Confirm `https://lingtai.hczhang.com/install.sh` and the
      `releases/latest` installer work from a clean machine.
- [ ] Re-check every number quoted above against `doc/experiments/` on the day
      of posting.
- [ ] Add a screenshot or short recording of the board, since a post is far
      stronger with one. `doc/img/` is a starting point.
