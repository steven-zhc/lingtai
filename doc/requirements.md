# What Lingtai needs outside itself

Everything Lingtai runs, reaches or asks you to sign in to, in one place. Read
it before [the tutorial](tutorial.md), or when `lingtai doctor` complains about
something you did not know you needed. Coming from Symphony and wondering about
Linear? See [coming from Symphony](from-symphony.md).

Two things are **not** on this page:

- **What your project needs.** Lingtai runs your recipe's `run:` commands and
  its environment script (`packages/actions/src/command.ts:403`,
  `packages/conductor/src/conduct.ts:490`), and whatever those call — `npm`,
  `pnpm`, a compiler — is the managed project's requirement, not Lingtai's. The
  tutorial's Node.js and npm are Chapter Garden's.
- **What building a release needs.** `bun` (also needed on a checkout, in the
  table below), `pnpm exec next build` and `node --build-sea` (`apps/release/src/build.ts`,
  `apps/release/src/binary.ts`) produce a release. Installing and running one
  needs none of them.

Where this page says "any recent", the code does not check a version.

## Programs on your machine

| What | Needed when | Minimum version | Why | `lingtai doctor` check | Where |
| --- | --- | --- | --- | --- | --- |
| `git` | Always | Any recent; 2.38 for conflict triage | Worktrees, branches, the clone Lingtai keeps of each repository, the merge lane | None. `lingtai init` runs `git --version` and stops if it fails | `packages/repo/src/git.ts:44`, `apps/cli/src/init.ts:1007`; the 2.38 check is `packages/repo/src/mirror.ts:158` |
| `claude` | Any role in the recipe runs `claude-code`. `discuss.agent` defaults to it, so leaving `discuss:` out needs it even when `runtime.agent` is `codex` | Any recent | The agent that does the work | `runtime: signed in` and `runtime: <project> signed in` report whether it is signed in; neither checks the binary on its own | `packages/agent/src/claude-code.ts:402`, `:431` |
| `codex` | Any role in the recipe runs `codex`: `runtime.agent`, `discuss.agent`, `triage`, a step's `agent:` or a `judge:` | Any recent | The agent that does the work | `runtime: signed in` and `runtime: <project> signed in` report whether it is signed in; neither checks the binary on its own | `packages/agent/src/codex.ts:1107`, `:1181` |
| Node.js | A source checkout only. An installed copy carries the Node it was built with | 26 or later | Runs the CLI, the conductor and the board from source | `node: at or above the floor` | `package.json:8`, `.node-version`, `apps/cli/src/doctor.ts:2489` |
| `bun` | A source checkout only, to build the hook binary a run refuses to start without (`pnpm --filter @lingtai/hook build`) | Any recent | Compiles `packages/hook/bin/lingtai-hook`, which is not committed | None | `apps/cli/src/run.ts:354`, `packages/hook/package.json:10` |
| `pnpm` | A source checkout only | The version `packageManager` pins, `11.9.0`; nothing checks it | Installs and runs the workspace | None | `package.json:7` |
| `ps` | Always | Any recent | Finds an agent left running by an earlier run, and checks whether a recorded process is still the one Lingtai started | None | `packages/agent/src/codex.ts:72`, `:118`, `packages/daemon/src/reconcile.ts:565` |
| `launchctl` (macOS) or `systemctl --user` (Linux) | You run `lingtai service`. Not needed for a daemon started in a terminal | Any recent | Keeps the conductor and the board running and restarts them | `daemon: liveness` reports whether the daemon is up, not whether the supervisor exists | `apps/cli/src/service.ts:430`, `:457`, `:467`, `:717` |
| `tar` | Installing, and `lingtai upgrade` on an installed copy | Any recent | Unpacks the release | None | `apps/site/public/install.sh:66`, `apps/cli/src/install.ts:404` |
| `shasum` or `sha256sum` | Installing | Any recent | Checks the download; the installer refuses if neither exists | None | `apps/site/public/install.sh:67-73` |
| `lsof` | An installed copy, on `lingtai upgrade` | Any recent | Finds processes still using the old version's directory | None | `apps/cli/src/install.ts:802` |
| `curl` and `sh` | Installing, once; `curl` is also checked by the installer before anything else | Any recent | The one-line installer in the tutorial | None | [tutorial.md](tutorial.md) |
| `open` (macOS) or `xdg-open` (Linux) | Optional | Any recent | Opens the board or the GitHub App page in your browser; without it Lingtai prints the address | None | `apps/cli/src/lingtai.ts:611`, `apps/cli/src/init.ts:1054` |
| `terminal-notifier` or `osascript` (macOS) | Optional, for desktop notifications | Any recent | Shows a notification when a question is waiting; `osascript` ships with macOS and is the fallback | None | `apps/cli/src/notify.ts:68`, `:124` |
| `$EDITOR` | Optional, for `lingtai ticket` | Any | Opens the ticket form | None | `apps/cli/src/ticket.ts:87` |

## Services Lingtai reaches

| What | Needed when | Why | `lingtai doctor` check | Where |
| --- | --- | --- | --- | --- |
| GitHub API, for your repository | The project is a GitHub one. A `--local` project does not use it | Issues, labels and branches | None. `github: installation and labels` is listed by `doctor` as deferred and checks nothing; `lingtai add` checks the App's permissions before it records a repository | `apps/cli/src/doctor.ts:883` |
| GitHub Releases API and release downloads | `lingtai upgrade`, and the version question `doctor` asks | Which release is newest, and the artifacts of the one you ask for. An allowlist naming only the API is not enough | `release: newest`, for an installed copy only | `apps/cli/src/install.ts:59`, `:326`, `:735` |
| Your agent's provider | Always, through `claude` or `codex` | The work itself | None | The README row on [what is sent](../README.md) |
| `api.openai.com`, directly | The runtime is `codex` and discussion or triage is model-only (no `tools: full`) | The Responses call that `codex` the CLI is not used for; billed separately from the Codex login | None | `packages/agent/src/codex-text.ts:65`, `packages/agent/src/runtimes.ts:116`, `config.example.yml` |
| Postgres | `database.url` is set. The default is a SQLite file at `~/.lingtai/lingtai.db`, which needs nothing | The log, if you chose to keep it there | `postgres: pooled connection`, `postgres: direct connection is session mode`, and the `schema:` checks. Use the direct host, never a pooler | `apps/cli/src/doctor.ts:317`, `:322`, `config.example.yml` |
| Telegram | A `telegram` subscriber is in your recipe | Posts the notification you asked for | None | The README row on [what is sent](../README.md) |

The README's [*Nothing is sent anywhere*](../README.md) row is the complete
list of what leaves the machine, with the reasons. This page does not repeat
it.

## Accounts you must sign in to

| What | Needed when | Why | `lingtai doctor` check |
| --- | --- | --- | --- |
| Claude Code | Any role runs `claude-code`, including the `discuss` default | The agent runs as you. Lingtai probes `claude auth status` before it starts one | `runtime: signed in` and `runtime: <project> signed in` |
| Codex | Any role runs `codex` | Same, with `codex login status` | `runtime: signed in` and `runtime: <project> signed in` |
| A GitHub App you create and install on the repository | The project is a GitHub one. A `--local` project needs none | Lingtai acts on GitHub as the App, not as you | None. `lingtai add` checks the App's permissions before it records a repository |
| GitHub access for `git` | You run `git` against the repository yourself, and for a remote that is not served by the App | A run's own push and fetch use an installation token of the App (`packages/repo/src/git.ts:47`), so they need no personal key; your own clone and any push you make use your SSH key or credentials, which Lingtai does not store | None |
| A separately billed OpenAI API key (`codex_text`) | The runtime is `codex` and discussion or triage is model-only | The Responses API is called directly, and the Codex login does not supply the key. Put the `codex_text` block from `config.example.yml` in `~/.lingtai/config.yml` (the example file itself is never read), or export it as `LINGTAI_CODEX_TEXT_*` variables (`packages/env/src/index.ts:187`) | `discuss: <project> codex ready` and `triage: <project> codex ready` |
| Postgres credentials | `database.url` is set | Part of the URL | `postgres: pooled connection` |
| A Telegram bot | A `telegram` subscriber is in your recipe | To post as | None |

`lingtai doctor` reports sign-in through `runtime: signed in` (any runtime) and
`runtime: <project> signed in` (the runtime that project dispatches), both off
the probes in `packages/agent/src/auth.ts:31` and `:95`
(`apps/cli/src/doctor.ts:788`, `:2080`). The `codex_text` block is checked per role by
`discuss: <project> codex ready` and `triage: <project> codex ready`
(`apps/cli/src/doctor.ts:2102`), which report a missing block or a `model`
that differs from `codex_text.model`.

## Which choices decide what you need

- **`--local` or GitHub.** `--local` needs no GitHub App and no GitHub API. It
  still needs `git` and one agent runtime.
- **SQLite or Postgres.** SQLite needs nothing. Postgres needs a database you
  run and a direct connection string.
- **`claude-code` or `codex`.** Every runtime any role uses has to be installed
  and signed in. `runtime.agent` is only one role: `discuss.agent` defaults to
  `claude-code`, and triage, steps and judges can each name a runtime. Set them
  all to one runtime if you want to install only one.
- **Installed copy or source checkout.** An installed copy needs no Node and no
  `pnpm`. A checkout needs both, and `bun` to build the hook.
