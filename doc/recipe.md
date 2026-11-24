# Recipe

*Reading and changing your recipe*

The tutorial's `lingtai init` wrote one file, the project's **recipe**. It is
the only place that says what an attempt does for this project: which agent writes
the change, what checks it, and whether a person approves before it lands. This
page is for the first time you open it.

## Where it is

`$LINGTAI_HOME/<project>/recipe.yml`, and `LINGTAI_HOME` defaults to
`~/.lingtai`, so Chapter Garden's is `~/.lingtai/chapter-garden/recipe.yml`.
The tutorial's Part 2 sets a different `LINGTAI_HOME`; that file is under that
directory instead.

It is **outside your repository**. It is not committed with the code, so a
change to it never appears in a diff or a pull request, and a change an agent
makes inside its worktree cannot alter it. That is not a sandbox: an agent runs
with your user's file access, and Claude Code in particular is not stopped from
writing outside its worktree. Treat the file as configuration you own, keep
tickets from asking an agent to edit it, and read `steps.proposed` again if you
doubt it.

You may still edit it by hand, and the project's log (`prj-{project}`) keeps
every version of it and who made it. A change made through Lingtai (the board's
save, setup, `lingtai add`) writes the file and then appends the version to the
log; a hand edit is recorded the next time anything reads the file. Text that
does not parse, or that the schema refuses, is recorded nowhere and the project
is refused, naming the file. **Nothing writes the file from the log**: if it is
missing, the project's attempts stop until you put one back, and the board still
shows the project from its log. A project added before this gets its first
recorded recipe the first time anything reads it, with nothing for you to do. A
run's own `StepsResolved` holds the recipe it ran under.

## What a choice becomes

An attempt has ten fixed steps: `claim`, `admit`, `prepared`, `design`,
`implement`, `build`, `review`, `proposed`, `merge`, `end`. The file has a few
top-level blocks, and the steps are one of them.

| You chose | Where it is written | Step it acts at |
|---|---|---|
| Whether this project is solo or team, and which branches | `mode`, `branch.main`, `branch.personal`; `repo.remote` for where it is pushed | `admit` cuts from the landing branch, `merge` lands on it |
| Whose tickets are taken | `take` under `source.assignee` (or the `queue:` entry at `claim`) | `claim` |
| Which agent, and how much it may spend | `agent:` on the `implement` entry (`runtime.agent` when `implement` is empty); `runtime.limits` | `implement` |
| How a worktree is made ready | `steps.prepared` | `prepared` |
| What must pass before review | `steps.build` | `build` |
| Who reads the diff cold | `steps.review` | `review` |
| Whether a person approves a landing | `steps.proposed` | `proposed` |
| Where tickets come from, and which labels count | `source.tickets`, `source.kinds` | `claim` |

## An excerpt

This is the recipe the full `init` command in [Going further](tutorial-more.md) wrote, run against
a scratch home, trimmed to the keys this page discusses (the remote is a
placeholder). It is a whole recipe, and you can paste it:

```yaml
version: 2

branch:
  main: main

repo:
  remote: git@github.com:you/chapter-garden.git

env:
  plantAt: .env.local

runtime:
  agent: claude-code

steps:
  implement:
    - name: write the change
      agent: claude-code
      prompt: ''
  review:
    - name: review
      agent: claude-code
      prompt: ''
  prepared:
    - name: install
      run: npm ci
  build:
    - name: check
      run: npm run check
    - name: build
      run: npm run build
  proposed:
    - name: hold every attempt
      human: Land this? The setup was answered 'hold'.

source:
  tickets: db
  kinds:
    - bug
    - feature
    - documentation
```

To switch the implementer, change the `agent:` on the `implement` entry as
well as `runtime.agent`. An `agent:` written on the entry wins; `runtime.agent`
is only what the built-in implementer uses when `implement` is empty or left out.
Every entry still needs its own plugin key, so deleting `agent:` from the entry
does not select the fallback; it makes the recipe invalid.
Change only `runtime.agent` in this excerpt and the next attempt still runs
`claude-code`.

`runtime.limits` is absent from the file, and that is fine: a key you leave out
takes its default, and `lingtai doctor` prints each value with `← default` or
the file it came from. The numbers are in [the reference](reference.md).

## Declared, or the default

A step you do not write is not skipped. `[]` and leaving the key out mean the
same thing, and a step with nothing declared runs its built-in default:

| Step | When nothing is declared |
|---|---|
| `claim` | the queue takes a ticket |
| `admit` | cuts the branch and worktree from the landing branch (`branch.personal` in team mode, else `branch.main`) |
| `implement` | one agent, on `runtime.agent` |
| `merge` | lands the branch on the landing branch |
| the other six | nothing runs |

Two things follow, and each has cost somebody an attempt.

- **Writing anything at a step replaces its default; it does not add to it.**
  A `run:` under `merge:` meant as an extra check also means the landing is no
  longer there.
- **`merge: []` does not stop landing.** What holds an attempt for a person is a
  `human:` at `proposed:`, which is the step before the landing.

So the file, not Lingtai's defaults, answers two questions about your project:

- **Does anything check a diff before review?** Read `steps.build`. If it is
  empty, nothing does.
- **Does a person approve a landing?** Read `steps.proposed`. If no `human:` is
  there, an attempt that gets past review lands unattended. `--land hold` writes
  one; `--land <branch>` removes them.

`init` run without `--build` or `--land` can leave you with either, so look
before you trust it. (This page describes what is built: the older design notes
say an empty step runs nothing, and the engine does not do that.)

## Make one change: add a hold

Say your recipe has no `human:` at `proposed:` and you want to approve each
landing. Add one entry there:

```yaml
  proposed:
    - name: approve before landing
      human: Land this?
```

Then ask `lingtai doctor` whether the file still resolves:

```sh
lingtai doctor
```

The project's row reads `✓ recipe: chapter-garden`, followed by a short hash of
the resolved recipe. The hash changes when the file does, so a different one
confirms the edit was read. Doctor proves the file is legal and the agent can
run. It does not say whether a landing is held; for that, read
`steps.proposed` again.

The mistake to expect is putting the same `human:` under `merge:`. Doctor
refuses it, in the same row:

```text
✗     recipe: chapter-garden
      …/chapter-garden/recipe.yml is not valid: steps.merge.0: the "ask first"
      action is a "human" at the "merge" step, and `human:` does not implement
      `merge` — it serves `proposed`: `merge` may not reach a person, …
```

`human:` serves `proposed` and nothing else, so that is where it goes. A
running daemon reads the file again at the start of each attempt, so an edit
applies to the next attempt without a restart. That works both ways: delete a
hold and the next attempt can land unattended, so edit the file with that in mind.

### Using your own repository?

Setup suggests install and build commands from the stack it detects at the
repository root: Node (pnpm, yarn, npm) from a lockfile and `package.json`, and
Python (uv, poetry) from `uv.lock` or `poetry.lock` and the tools `pyproject.toml`
and its neighbours configure, and Go from `go.mod` (`go mod download`, then a
`gofmt`, `go vet` and `go test` check, plus `golangci-lint run` only with a
`.golangci.yml`, `.golangci.yaml` or `.golangci.toml` at the root), and Java from
`pom.xml` (Maven: `dependency:go-offline`, then `test`) or `build.gradle(.kts)` (Gradle: `test`,
no separate install), using `mvnw`/`gradlew` when it is at the root; Gradle wins when both
are present. Rust from `Cargo.toml` (`cargo fetch`, then `cargo fmt --check`, `cargo clippy` and
`cargo test`, with `--locked` when `Cargo.lock` is at the root). A Python project with only `requirements.txt` gets
a note asking you to type the install command, not a suggestion.

## Solo or team (0.16)

`mode` is `solo` or `team`. **A recipe that names no mode is solo**, so a project
made before 0.16 does what it did; `lingtai add` and `lingtai init` ask, and a new
project defaults to team. The mode decides four things:

| | `solo` | `team` |
|---|---|---|
| `take` | `all`, or as written | `mine`, and only `mine` |
| The branch a ticket is cut from and lands on | `branch.main` | `branch.personal` |
| A ticket ends | `landed` on `main`, and closed | `landed` on your branch, left open on the tracker until its PR merges |
| Reaching `main` | the landing itself | a PR ([A PR's life](team.md)) |

```yaml
mode: team

branch:
  main: main
  personal: steven-zhc/steven-s-macbook-pro

source:
  assignee:
    login: steven-zhc
    take: mine

runtime:
  agent: claude-code

pr:
  agent: claude-code
  ci:
    provider: github-actions
    required: [build]
    timeout: 60m
```

- **`branch.main`** is the trunk, and replaces `repo.base` and an `admit` entry's
  `worktree.base`. **`branch.personal`** is your branch, required in team mode and
  refused in solo. `lingtai add` suggests `<login>/<machine>` and you may change
  it. It is refused by name if git would not accept it as a branch name, or if it
  is `branch.main` ignoring case. The landing branch is one value, read from
  the mode alone: there is no key for the merge lane.
- **`take`** is `all`, `mine` or `unassigned`, written under `source.assignee`
  or, where the recipe declares a `queue:` at `claim`, under that entry's
  `assignee`. `both` is the old spelling of `all`. On GitHub, *mine* is an issue
  assigned to `login`, so a team recipe on GitHub needs the `login`; on the
  local ticket store every ticket is yours. Team mode refuses `take: all` and
  `take: unassigned`, saying to remove `take` or use `mode: solo`.
- **`pr:`** configures the agent that writes a PR's title and summary, and is
  refused in a solo recipe. Its keys are `agent` (one that can run with no
  tools; absent means `runtime.agent` where that one can), `model`, `prompt`
  and `limits` (`turns` 20 and `wall` `5m` by default). It has **no `usd`**: it
  spends outside any attempt, so each run counts against the day's ceiling
  instead.
- **`pr.ci`** says which CI a PR waits on. `provider` is `github-actions`,
  `none`, or absent to detect (a workflow on pull requests means
  `github-actions`). `required` names the checks that count; absent, every check
  on the PR's head counts, and an empty list is refused. `timeout` defaults to
  `60m`. `provider: jenkins` is refused in 0.16, saying the adapter is next
  release. If Jenkins is ever used its credentials are `jenkins.user` and
  `jenkins.token` in `~/.lingtai/config.yml`, never in a recipe, and a recipe
  that writes them is refused by name.

The old spellings `repo.base`, `steps.admit[*].worktree.base` and `take: both`
are refused by 0.16 when the recipe resolves, naming the key and the fix, so a
project made before 0.16 must have them rewritten before its daemon restarts.
[Upgrading to 0.16](upgrading-to-0.16.md) says how `lingtai doctor --fix`
rewrites them.

## Every other key

[Plugins](plugins/index.md) lists each key and the steps it may be written at,
and every key has a page of its own, such as [`run`](plugins/run.md),
[`agent`](plugins/agent.md) and [`human`](plugins/human.md). The commands
around the file are in [the CLI guide](cli.md); [the operating guide](operating.md)
is the long reference.

`sandbox:` is not a plugin. It sets what a run may read, write and reach
(`enabled`, `required`, `network.allow`, `write`, `deny`), from v0.14.0; see
[safety](safety.md).
