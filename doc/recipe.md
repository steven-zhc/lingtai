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

## What a choice becomes

An attempt has ten fixed steps: `claim`, `admit`, `prepared`, `design`,
`implement`, `build`, `review`, `proposed`, `merge`, `end`. The file has a few
top-level blocks, and the steps are one of them.

| You chose | Where it is written | Step it acts at |
|---|---|---|
| Which branch changes land on, and where it is pushed | `repo.base`, `repo.remote` | `admit` cuts from it, `merge` lands on it |
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

repo:
  base: main
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
| `admit` | cuts the branch and worktree from the base |
| `implement` | one agent, on `runtime.agent` |
| `merge` | lands the branch on the base |
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

## Every other key

[Plugins](plugins/index.md) lists each key and the steps it may be written at,
and every key has a page of its own, such as [`run`](plugins/run.md),
[`agent`](plugins/agent.md) and [`human`](plugins/human.md). The commands
around the file are in [the CLI guide](cli.md); [the operating guide](operating.md)
is the long reference.
