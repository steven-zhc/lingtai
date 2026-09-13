# The `tamper` watch — the gate cannot edit the gate

A `watch:` action at `proposed` that holds a diff for a person when it touches
the machinery that judges diffs. Built by `#31`, live in
`packages/actions/src/watch-gate.ts`, and **off in this repository's own recipe**
— see *Why it is off here* below.

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

## Why this is not circular

The watch list lives in `.lingtai/config.yaml`, inside the repository the agent
is editing — which looks like leaving the key under the doormat.

What makes it sound is [0005](decisions/0005-config-in-target-repo.md): **the
recipe governing a run is read from `origin/<base>`, never from the agent's
branch.** An agent that deletes the watch changes nothing about the run in
flight. The deletion appears in the diff; the deletion is itself a change to a
watched file; the diff is held. The attack — *disarm the watch and edit the
conductor under it, in one merge* — cannot be written down.

That the conductor reads the recipe from the base and not from the branch it is
judging is asserted in `packages/conductor/pure/run-once.test.ts`, *judges a
change by the recipe on its base*.

## The list is kept correct by something other than the list

`packages/actions/test/tamper-watch.test.ts` walks the workspace: every package
`conductor`, `hook` and `apps/cli` load — however indirectly — plus every
workspace that depends on `@lingtai/conductor`, which is how `apps/board` is
found. Each one must be covered, or the test fails.

So a new dependency, or a renamed package, breaks the build until the watch
covers it. **`apps/board` is in there for a specific reason**: a hold is only as
sound as the thing that records the decision lifting it.

## Why it is off here

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
