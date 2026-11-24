# Recipe

*Reading and changing your recipe*

The tutorial's `lingtai init` wrote one file, the project's **recipe**. It is
the only place that says what an attempt does for this project: which agent writes
the change, what checks it, and whether a person approves before it lands.

## Where it is

`$LINGTAI_HOME/<project>/recipe.yml`, and `LINGTAI_HOME` defaults to
`~/.lingtai`, so Chapter Garden's is `~/.lingtai/chapter-garden/recipe.yml`.

It is **outside your repository**, so a change to it never appears in a diff.
That is not a sandbox: an agent runs with your user's file access, so keep
tickets from asking one to edit it. You may edit it by hand. The project's log
(`prj-{project}`) records each version Lingtai reads, and who made it; a hand
edit is recorded the next time anything reads the file, so two saves between
reads leave only the second, and text the schema refuses is recorded nowhere.
**Nothing writes the file from the log**: if it is missing, attempts stop until
you put one back.

## What a choice becomes

An attempt has ten fixed steps: `claim`, `admit`, `prepared`, `design`,
`implement`, `build`, `review`, `proposed`, `merge`, `end`. The steps are one block.

| You chose | Where it is written | Step it acts at |
|---|---|---|
| Solo or team, and which branches | `mode`, `branch.main`, `branch.personal` | `admit` cuts from the landing branch, `merge` lands on it |
| Whose tickets are taken | `take` under `source.assignee` | `claim` |
| Which agent, and how much it may spend | `agent:` on the `implement` entry; `runtime.limits` | `implement` |
| How a worktree is made ready | `steps.prepared` | `prepared` |
| What must pass before review | `steps.build` | `build` |
| Who reads the diff cold | `steps.review` | `review` |
| Whether a person approves a landing | `steps.proposed` | `proposed` |

`mode` is `solo` or `team`, and a recipe that names none is solo; [team.md](team.md)
says what team changes.

## An excerpt

This is the recipe `init` wrote in [Going further](tutorial-more.md), trimmed to
the keys discussed here. It is a whole recipe:

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

To switch the implementer, change the `agent:` on the `implement` entry. An
`agent:` written there wins; `runtime.agent` is only what the built-in implementer
uses when `implement` is empty.

`runtime.limits` is absent, and that is fine: a key you leave out takes its
default, and `lingtai doctor` prints each value with `← default` or its file. The numbers are in [the reference](reference.md).

## Declared, or the default

A step you do not write is not skipped. `[]` and leaving the key out mean the
same thing, and a step with nothing declared runs its built-in default:

| Step | When nothing is declared |
|---|---|
| `claim` | the queue takes a ticket |
| `admit` | cuts the branch and worktree from the landing branch |
| `implement` | one agent, on `runtime.agent` |
| `merge` | lands the branch on the landing branch |
| the other six | nothing runs |

- **Writing anything at a step replaces its default; it does not add to it.**
  A `run:` under `merge:` meant as an extra check also means the landing is no
  longer there.
- **`merge: []` does not stop landing.** What holds an attempt for a person is a
  `human:` at `proposed:`, the step before the landing.

So the file answers two questions. Does anything check a diff before review?
Read `steps.build`. Does a person approve a landing? Read `steps.proposed`; with
no `human:` there, an attempt that gets past review lands unattended.

## Make one change: add a hold

Say your recipe has no `human:` at `proposed:` and you want to approve each
landing. Add one entry there:

```yaml
  proposed:
    - name: approve before landing
      human: Land this?
```

Then ask [`lingtai doctor`](cli.md) whether the file still resolves:

```sh
lingtai doctor
```

The project's row reads `✓ recipe: chapter-garden`, followed by a short hash of
the resolved recipe. The hash changes when the file does, so a different one
confirms the edit was read. Doctor proves the file is legal, not that a landing is held; read
`steps.proposed` again.

The mistake to expect is putting the same `human:` under `merge:`. Doctor
refuses it, in the same row:

```text
✗     recipe: chapter-garden
      …/chapter-garden/recipe.yml is not valid: steps.merge.0: the "ask first"
      action is a "human" at the "merge" step, and `human:` does not implement
      `merge` — it serves `proposed`: `merge` may not reach a person, …
```

`human:` serves `proposed` and nothing else. A running daemon reads the file again
at the next attempt, so an edit applies without a restart, both ways: delete a hold
and the next attempt can land unattended.

### Using your own repository?

Setup suggests install and build commands for the stack at the repository root:
Node, Python, Go, Java or Rust. A Python project with only `requirements.txt`
gets a note asking you to type the install command, not a suggestion.

## Every other key

[Plugins](plugins/index.md) has every key and where it may be written; `sandbox:`
is not a plugin, see [safety](safety.md).

## Next

[Checks and spend](checks-and-spend.md)
