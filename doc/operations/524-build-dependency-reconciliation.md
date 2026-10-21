# Self-hosting build dependency reconciliation (#524)

The conducting machine reads `~/.lingtai/lingtai/recipe.yml`, outside the
managed worktree. The repository's `.lingtai/config.yaml` is an inert copy.
This repository commit records the following change for the operator to apply
to the machine recipe; it does not apply it to the running installation.

Insert this action as the **first** entry under `steps.build`, before the
existing `format`, `lint`, and `build` actions:

```yaml
    - name: install
      run: CI=true pnpm install --frozen-lockfile
      timeout: 10m
      env: []
```

Keep the existing `prepared` install. `build` runs again after each fix round,
so this action reconciles dependencies changed during implementation or a fix
before pnpm runs any check. `CI=true` belongs on this command alone; the
`run:` action has no TTY. The separate action name and bounded timeout make an
install refusal report `build:install` with its command output, while the later
format, lint, typecheck, and unit test actions remain unwaived.

After applying the change, inspect the active recipe's `steps.build` order and
run a disposable worktree reproduction: install at `prepared`, add a workspace
dependency and update `pnpm-lock.yaml` during implementation, then execute
the declared build actions with stdin closed and stdout/stderr piped. Confirm
that install and all checks pass. To check failure attribution, make the
lockfile inconsistent with a manifest in that disposable worktree and confirm
that `build:install` fails with pnpm's output before `build:format` starts.
