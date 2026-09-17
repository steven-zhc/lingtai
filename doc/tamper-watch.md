# The `tamper` watch — the gate cannot edit the gate

A `watch:` action at `proposed` that holds a diff for a person when it touches
the machinery that judges diffs. Built by `#31`, live in
`packages/actions/src/watch-gate.ts`, and **not in this repository's recipe —
because it has lost its subject, not because it was switched off.** See *It lost
its subject* below.

## What it does

```yaml
gates:
  proposed:
    # ... build, review ...
    - name: tamper
      watch:
        - ".lingtai/config.yaml"
        - "packages/conductor/**"
        - "packages/event-store/**"
        - "packages/hook/**"
        - "packages/actions/**"
        - "packages/recipe/**"
        - "packages/domain/**"
        - "packages/github/**"
        - "packages/agent/**"
        - "packages/agent-env/**"
        - "packages/env/**"
        - "packages/repo/**"
        - "packages/projector/**"
        - "packages/daemon/**"
        # `extension` because the CLI loads it by relative path, which the
        # dependency walk cannot see. `telegram` is loaded by nothing — it is
        # spawned — but it is the code the bot token is handed to.
        - "packages/extension/**"
        - "packages/telegram/**"
        - "apps/cli/**"
        - "apps/board/**"
        - "package.json"
        - "**/package.json"
        - "pnpm-lock.yaml"
        - "pnpm-workspace.yaml"
        - "**/.npmrc"
        - "**/tsconfig*.json"
        - "**/vitest*.config.*"
      then: request-approval
```

`then:` takes `request-approval` — the diff is *held*, and a person answers on
the board — or `fail`, which refuses it outright. There is no third value, and in
particular no *report but do not hold*: a watch that does not stop anything is
the kind of check this project names as its own bug.

Put it **last** at `proposed`, so a person is only ever asked about a change that
everything else already passed.

## It lost its subject

This watch existed to stop an agent weakening its own gates in one merge, and
its central path was `.lingtai/config.yaml` — the recipe, inside the repository
the agent was editing. 0005 made that sound by reading the recipe from
`origin/<base>`, so the deletion showed up in the diff and was itself held.

**Since [0046](decisions/0046-lingtai-is-personal.md) §4 and #180 the recipe is
not in the repository.** It is `~/.lingtai/<project>/recipe.yml`, with the
agent and the limits in `~/.lingtai/config.yml`, and nothing reads a recipe
from the repository at all. An agent's blast radius is its worktree, and
`~/.lingtai/` is not in it — so the attack this watch guarded, *disarm the gate
and edit under it in one merge*, has nothing to be written against. A
`.lingtai/config.yaml` in a repository is now an ordinary file.

That is a different fact from *switched off*, and the difference is why the
capability and its list stay: a managed repository may still hold things worth
watching — the packages that load the gates, the lockfile, a `tsconfig` — and
deleting a control is a different decision from removing what it guarded.

That the run obeys the machine's recipe and not any copy in the repository is
asserted in `packages/conductor/pure/run-once.test.ts`, *judges a change by the
machine's recipe, not by any file in the repository*.

## The list is kept correct by something other than the list

`packages/actions/test/tamper-watch.test.ts` walks the workspace: every package
`conductor`, `hook` and `apps/cli` load — however indirectly — plus every
workspace that depends on `@lingtai/conductor`, which is how `apps/board` is
found. Each one must be covered, or the test fails.

So a new dependency, or a renamed package, breaks the build until the watch
covers it. **`apps/board` is in there for a specific reason**: a hold is only as
sound as the thing that records the decision lifting it.

## Why it was off here, before it lost its subject

`#31` landed on 2026-09-12 and within one night held six consecutive items at
`proposed`, every one of them with `build=passed review=passed`. Nothing was
wrong with any of them. That is the control working exactly as designed.

The trouble is what this repository *is*. Every ticket in its queue is about
Lingtai's own machinery, so nearly every diff touches a watched path, and the
effect of turning this on was to make self-hosting supervised-by-default —
one person reading every diff, or nothing moves.

That is a real trade and it was taken deliberately: **machine time over review
time, while the loop is still being learned.** It is recorded here rather than
in a commit message because the next person to consider turning it on deserves
the reason it went off.

**A managed repository that is not Lingtai should almost certainly have this
on.** There, a watched path is rare, and a hold means something.

## Turning it on

Paste the block above as the last action at `proposed`, and restore the wiring
half of `tamper-watch.test.ts` — while the watch is off, the test judges the
block as documented here rather than as configured, and the case it cannot make
is *cannot be weakened by the change it is judging*, which needs the watch to
actually be at `proposed`. That case is in this file's history.

Expect the first week to be mostly holds.
