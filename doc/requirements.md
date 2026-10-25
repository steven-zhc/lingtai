# What Lingtai needs outside itself

Everything Lingtai runs, reaches or asks you to sign in to, in one place. Read
it before [the tutorial](tutorial.md), or when `lingtai doctor` complains about
something you did not know you needed.

Two things are **not** on this page:

- **What your project needs.** Lingtai runs your recipe's `run:` commands and
  its environment script (`packages/actions/src/command.ts:403`,
  `packages/conductor/src/conduct.ts:490`), and whatever those call — `npm`,
  `pnpm`, a compiler — is the managed project's requirement, not Lingtai's. The
  tutorial's Node.js and npm are Chapter Garden's.
- **What building Lingtai needs.** `bun`, `pnpm exec next build` and
  `node --build-sea` (`apps/release/src/build.ts`,
  `apps/release/src/binary.ts`) produce a release. Installing and running one
  needs none of them.

Where this page says "any recent", the code does not check a version.

## Programs on your machine

| What | Needed when | Minimum version | Why | `lingtai doctor` check | Where |
| --- | --- | --- | --- | --- | --- |
| `git` | Always | Any recent; 2.38 for conflict triage | Worktrees, branches, the clone Lingtai keeps of each repository, the merge lane | None. `lingtai init` runs `git --version` and stops if it fails | `packages/repo/src/git.ts:44`, `apps/cli/src/init.ts:1007`; the 2.38 check is `packages/repo/src/mirror.ts:158` |
| `claude` | The runtime is `claude-code` | Any recent | The agent that does the work | None | `packages/agent/src/claude-code.ts:402`, `:431` |
| `codex` | The runtime is `codex` | Any recent | The agent that does the work | None | `packages/agent/src/codex.ts:1107`, `:1181` |
| Node.js | A source checkout only. An installed copy carries the Node it was built with | 26 or later | Runs the CLI, the conductor and the board from source | `node: at or above the floor` | `package.json:8`, `.node-version`, `apps/cli/src/doctor.ts:2489` |
| `pnpm` | A source checkout only | The version `packageManager` pins, `11.9.0`; nothing checks it | Installs and runs the workspace | None | `package.json:7` |
| `ps` | Always | Any recent | Finds an agent left running by an earlier run, and checks whether a recorded process is still the one Lingtai started | None | `packages/agent/src/codex.ts:72`, `:118`, `packages/daemon/src/reconcile.ts:565` |
| `launchctl` (macOS) or `systemctl --user` (Linux) | You run `lingtai service`. Not needed for a daemon started in a terminal | Any recent | Keeps the conductor and the board running and restarts them | `daemon: liveness` reports whether the daemon is up, not whether the supervisor exists | `apps/cli/src/service.ts:430`, `:457`, `:467`, `:717` |
| `tar` and `lsof` | An installed copy, on `lingtai upgrade` | Any recent | Unpacks the release and finds processes still using the old version's directory | None | `apps/cli/src/install.ts:404`, `:802` |
| `curl` and `sh` | Installing, once | Any recent | The one-line installer in the tutorial | None | [tutorial.md](tutorial.md) |
| `open` (macOS) or `xdg-open` (Linux) | Optional | Any recent | Opens the board or the GitHub App page in your browser; without it Lingtai prints the address | None | `apps/cli/src/lingtai.ts:611`, `apps/cli/src/init.ts:1054` |
| `terminal-notifier` or `osascript` (macOS) | Optional, for desktop notifications | Any recent | Shows a notification when a question is waiting; `osascript` ships with macOS and is the fallback | None | `apps/cli/src/notify.ts:68`, `:124` |
| `$EDITOR` | Optional, for `lingtai ticket` | Any | Opens the ticket form | None | `apps/cli/src/ticket.ts:87` |

## Services Lingtai reaches

| What | Needed when | Why | `lingtai doctor` check | Where |
| --- | --- | --- | --- | --- |
| GitHub API, for your repository | The project is a GitHub one. A `--local` project does not use it | Issues, labels and branches | `github: installation and labels` | `apps/cli/src/doctor.ts:883` |
| GitHub Releases API and release downloads | `lingtai upgrade`, and the version question `doctor` asks | Which release is newest, and the artifacts of the one you ask for. An allowlist naming only the API is not enough | None found | `apps/cli/src/install.ts:59`, `:326` |
| Your agent's provider | Always, through `claude` or `codex` | The work itself | None | The README row on [what is sent](../README.md) |
| Postgres | `database.url` is set. The default is a SQLite file at `~/.lingtai/lingtai.db`, which needs nothing | The log, if you chose to keep it there | `postgres: pooled connection`, `postgres: direct connection is session mode`, and the `schema:` checks. Use the direct host, never a pooler | `apps/cli/src/doctor.ts:317`, `:322`, `config.example.yml` |
| Telegram | A `telegram` subscriber is in your recipe | Posts the notification you asked for | None | The README row on [what is sent](../README.md) |

The README's [*Nothing is sent anywhere*](../README.md) row is the complete
list of what leaves the machine, with the reasons. This page does not repeat
it.

## Accounts you must sign in to

| What | Needed when | Why | `lingtai doctor` check |
| --- | --- | --- | --- |
| Claude Code | The runtime is `claude-code` | The agent runs as you. Lingtai probes `claude auth status` before it starts one | None |
| Codex | The runtime is `codex` | Same, with `codex login status` | None |
| A GitHub App you create and install on the repository | The project is a GitHub one. A `--local` project needs none | Lingtai acts on GitHub as the App, not as you | `github: installation and labels` |
| GitHub access for `git` | The project is a GitHub one | Push and fetch use your own SSH key or credentials; Lingtai stores none | None |
| Postgres credentials | `database.url` is set | Part of the URL | `postgres: pooled connection` |
| A Telegram bot | A `telegram` subscriber is in your recipe | To post as | None |

The probes in `packages/agent/src/auth.ts:31` and `:95` run when an agent is
about to start. They are not `doctor` checks, so a missing sign-in shows up
there rather than in `lingtai doctor`.

## Which choices decide what you need

- **`--local` or GitHub.** `--local` needs no GitHub App and no GitHub API. It
  still needs `git` and one agent runtime.
- **SQLite or Postgres.** SQLite needs nothing. Postgres needs a database you
  run and a direct connection string.
- **`claude-code` or `codex`.** Only the one you choose has to be installed and
  signed in.
- **Installed copy or source checkout.** An installed copy needs no Node and no
  `pnpm`. A checkout needs both.
