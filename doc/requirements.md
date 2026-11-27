# Requirements

*What Lingtai needs — the minimum is short; everything else is a choice you make*

Read this before [the tutorial](tutorial.md), or when `lingtai doctor`
complains about something you did not know you needed. Coming from Symphony and
wondering about Linear? See [coming from Symphony](from-symphony.md).

Not on this page: **what your project needs** (your recipe's `run:` commands
and whatever they call are the project's requirement, not Lingtai's;
`packages/actions/src/command.ts:403`, `packages/conductor/src/conduct.ts:490`),
and **what building a release needs** (`bun`, `next build` and
`node --build-sea`; installing and running one needs none of them).

## The minimum

A local repository and one agent, which is what the tutorial's Part 1 uses
(`--local`).

- macOS or Linux, with `git` and `ps`.
- **One** of Claude Code or Codex, installed and signed in (GitHub Copilot CLI
  and Antigravity are optional extras for `implement` alone; see
  [where each agent may be named](reference.md#where-each-agent-may-be-named)), and every role in
  the recipe set to it: `discuss.agent` defaults to `claude-code`, so a
  Codex-only setup must say so there or it ends up needing `claude`.
- The installer's own needs: `curl`, `sh`, `tar`, and `shasum` or `sha256sum`.
- No GitHub, no database server, no account with Lingtai. The log is a SQLite
  file at `~/.lingtai/lingtai.db`.

## Add only if you…

- **…keep tickets in GitHub issues.** One person: `gh` signed in with the
  `repo` and `workflow` scopes (`--github-auth gh`, the default). A team: a
  GitHub App you create and install ([github.md](github.md)). Lingtai's actions
  then appear as that account.
- **…use Codex for discussion or triage without tools.** A separately billed
  OpenAI API key (`codex_text`); the Codex login does not supply it.
- **…want it to keep running after you close the terminal.** `lingtai service`,
  using `launchctl` or `systemctl --user`, which the OS already has. It runs
  from a source checkout only; the installed binary does not support it yet.
- **…keep the log in Postgres.** A database you run, reached by the direct
  host, never a pooler.
- **…want notifications.** Desktop (`terminal-notifier`, or `osascript`, which
  macOS ships) or a Telegram bot.
- **…run from a source checkout.** Node.js 26 or later, `pnpm`, and `bun` to
  build the hook.
- **…upgrade an installed copy.** `lsof`, and GitHub release downloads
  reachable.

## Full reference

Every external program, service and account, with the code that touches it.
Where a table says "any recent", the code does not check a version.

## Programs on your machine

| What | Needed when | Minimum version | Why | `lingtai doctor` check | Where |
| --- | --- | --- | --- | --- | --- |
| `git` | Always | Any recent; 2.38 for conflict triage | Worktrees, branches, the clone Lingtai keeps of each repository, the merge lane | None. `lingtai init` runs `git --version` and stops if it fails | `packages/repo/src/git.ts:44`, `apps/cli/src/init.ts:1007`; the 2.38 check is `packages/repo/src/mirror.ts:158` |
| `gh` | The project is a GitHub one and `init` chose `--github-auth gh`, its default. A `--local` project does not use it | Any recent | Lingtai acts on GitHub as your login | `github: gh login` | `apps/cli/src/github-auth.ts:3`, `apps/cli/src/doctor.ts:957` |
| `claude` | Any role in the recipe runs `claude-code`. `discuss.agent` defaults to it, so leaving `discuss:` out needs it even when `runtime.agent` is `codex` | Any recent | The agent that does the work | `runtime: signed in` and `runtime: <project> signed in` report whether it is signed in; neither checks the binary on its own | `packages/agent/src/claude-code.ts:402`, `:431` |
| `codex` | Any role in the recipe runs `codex`: `runtime.agent`, `discuss.agent`, `triage`, a step's `agent:` or a `judge:` | Any recent | The agent that does the work | `runtime: signed in` and `runtime: <project> signed in` report whether it is signed in; neither checks the binary on its own | `packages/agent/src/codex.ts:1107`, `:1181` |
| `copilot` | Only when a step's `agent:` at `implement` names `copilot` | 1.0.112 (measured 2026-11-19) | The agent that does that step's work | `steps: <project> <agent> signed in` | `packages/agent/src/acp-session.ts`, `apps/cli/src/doctor.ts:3494` |
| `agy` | Only when a step's `agent:` at `implement` names `antigravity` | 1.5.9 (measured 2026-11-19) | The agent that does that step's work | `steps: <project> <agent> signed in` | `packages/agent/src/acp-session.ts`, `apps/cli/src/doctor.ts:3494` |
| Node.js | A source checkout only. An installed copy carries the Node it was built with | 26 or later | Runs the CLI, the conductor and the board from source | `node: at or above the floor` | `package.json:8`, `.node-version`, `apps/cli/src/doctor.ts:2489` |
| `bun` | A source checkout only, to build the hook binary a run refuses to start without (`pnpm --filter @lingtai/hook build`) | 1.3.6. A hook compiled by an older Bun looks for `.env` from its working directory upward, and where a sandbox refuses to list one of those directories (a worktree is under the read-denied `~/.lingtai`) it starts with an empty `process.env`, so every sandboxed run is blocked at `UserPromptSubmit`; `--no-compile-autoload-dotenv` does not fix 1.2.22 (`f2f91dbe8`) | Compiles `packages/hook/bin/lingtai-hook`, which is not committed | `bun: at or above 1.3.6` reads `bun --version`, not the binary; a hook built before an upgrade is caught by the smoke test before every dispatch | `apps/cli/src/run.ts:354`, `packages/hook/package.json:10`, `apps/cli/src/doctor.ts` (`bunRow`) |
| `pnpm` | A source checkout only | The version `packageManager` pins, `11.9.0`; nothing checks it | Installs and runs the workspace | None | `package.json:7` |
| `ps` | Always | Any recent | Finds an agent left running by an earlier run, and checks whether a recorded process is still the one Lingtai started | None | `packages/agent/src/codex.ts:72`, `:118`, `packages/daemon/src/reconcile.ts:565` |
| `launchctl` (macOS) or `systemctl --user` (Linux) | You run `lingtai service`, which runs from a source checkout you own; the installed binary does not support it yet. Not needed for a daemon started in a terminal | Any recent | Keeps the conductor and the board running and restarts them | `daemon: liveness` reports whether the daemon is up, not whether the supervisor exists | `apps/cli/src/service.ts:430`, `:457`, `:467`, `:717` |
| `tar` | Installing, and `lingtai upgrade` on an installed copy | Any recent | Unpacks the release | None | `apps/site/public/install.sh:66`, `apps/cli/src/install.ts:404` |
| `shasum` or `sha256sum` | Installing | Any recent | Checks the download; the installer refuses if neither exists | None | `apps/site/public/install.sh:67-73` |
| `lsof` | An installed copy, on `lingtai upgrade` | Any recent | Finds processes still using the old version's directory | None | `apps/cli/src/install.ts:802` |
| `curl` and `sh` | Installing, once; `curl` is also checked by the installer before anything else | Any recent | The one-line installer in the tutorial | None | [tutorial.md](tutorial.md) |
| `open` (macOS) or `xdg-open` (Linux) | Optional | Any recent | Opens the board or the GitHub App page in your browser; without it Lingtai prints the address | None | `apps/cli/src/board-world.ts:56`, `apps/cli/src/init.ts:1054` |
| `terminal-notifier` or `osascript` (macOS) | Optional, for desktop notifications | Any recent | Shows a notification when a question is waiting; `osascript` ships with macOS and is the fallback | None | `apps/cli/src/notify.ts:68`, `:124` |
| `$EDITOR` | Optional, for `lingtai ticket` | Any | Opens the ticket form | None | `apps/cli/src/ticket.ts:87` |
| `srt` sandbox, on a host that can run it | A project's recipe has `sandbox.enabled` ([safety](safety.md#turning-it-on)) | Pinned by Lingtai | Wraps every agent run | `sandbox: host` and `sandbox: <project>`; with a live canary of four commands through the run's own wrapper (a planted file under a denied path and a host off the allowlist must fail; two controls must succeed), run only where the host can sandbox and some project asks for it | `apps/cli/src/doctor.ts`, `apps/cli/src/sandbox-canary.ts` |

## Services Lingtai reaches

| What | Needed when | Why | `lingtai doctor` check | Where |
| --- | --- | --- | --- | --- |
| GitHub API, for your repository | The project is a GitHub one, authenticated as your `gh` login or as the App. A `--local` project does not use it | Issues, labels and branches | `github: gh login` under `gh` auth. Under an App, `github: installation and labels` is listed by `doctor` as deferred and checks nothing; `lingtai add` checks the App's permissions before it records a repository | `apps/cli/src/doctor.ts:957`, `:1063` |
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
| A signed-in `gh` with the `repo` and `workflow` scopes (`gh auth login --scopes repo,workflow`) | The project is a GitHub one and `init` chose `--github-auth gh`, its default: one person lends Lingtai their own login. A `--local` project needs none | Lingtai acts on GitHub as you | `github: gh login` reports `ok` and names the account |
| A GitHub App you create and install on the repository | The project is a GitHub one run by a team ([0114](https://github.com/steven-zhc/lingtai/blob/main/doc/decisions/0114-a-github-app-not-a-token.md)). A `--local` project needs none | Lingtai acts on GitHub as the App, not as you | `github: app credentials` (`skip` under `gh`). `lingtai add` checks the App's permissions before it records a repository |
| GitHub access for `git` | You run `git` against the repository yourself, and for a remote that is not served by the App | A run's own push and fetch use an installation token of the App in App mode, and the token `gh auth token` prints in `gh` mode (`packages/repo/src/git.ts:47`, `packages/github/src/client.ts:382`), so they need no personal key; your own clone and any push you make use your SSH key or credentials, which Lingtai does not store | None |
| A separately billed OpenAI API key (`codex_text`) | The runtime is `codex` and discussion or triage is model-only | The Responses API is called directly, and the Codex login does not supply the key. Put the `codex_text` block from `config.example.yml` in `~/.lingtai/config.yml` (the example file itself is never read), or export it as `LINGTAI_CODEX_TEXT_*` variables (`packages/env/src/index.ts:187`) | `discuss: <project> codex ready` and `triage: <project> codex ready` |
| A Claude token, for a sandboxed run | A project is sandboxed and a role runs `claude-code`: the login in `~/.claude/.credentials.json` is denied to the run | The run uses a long-lived token instead ([below](#tokens-for-a-sandboxed-run)) | None |
| A Copilot token, for a sandboxed run | A project is sandboxed and a step names `copilot` | The run is handed a fine-grained token instead of `gh`'s login ([below](#tokens-for-a-sandboxed-run)) | None |
| Copilot's own login, for an unsandboxed run | A step names `copilot` and the project is not sandboxed | The agent runs as you | `copilot login`, or `gh`'s own login |
| An Antigravity login | A step names `antigravity` | The sign-in lives in the keychain, so run `agy acp --login` in your GUI login session, not over ssh | None |
| Postgres credentials | `database.url` is set | Part of the URL | `postgres: pooled connection` |
| A Telegram bot | A `telegram` subscriber is in your recipe | To post as | None |

### Tokens for a sandboxed run

`lingtai token claude` and `lingtai token copilot` make them ([`cli.md`](cli.md#lingtai-token)). Revoking either is yours to do.

- **Claude.** `claude setup-token`'s result is saved as `claude.oauth_token` in
  `~/.lingtai/config.yml`; `LINGTAI_CLAUDE_OAUTH_TOKEN` is read first. The run
  gets it as `CLAUDE_CODE_OAUTH_TOKEN`, and a configuration directory of its own
  with the hook settings and copies of your user-level `CLAUDE.md`, `skills/` and
  `agents/`, but no MCP servers, plugins, `settings.json` or login
  (`apps/cli/src/claude-token.ts`).
- **Copilot.** A fine-grained personal access token (`github_pat_…`), owned by
  your own account, with only the *Copilot Requests* account permission. It is
  not `gh`'s login: that can reach your repositories, and this token cannot. A
  classic `ghp_` token is silently ignored by Copilot, so the command refuses it
  by name. It is saved as `copilot.github_token`;
  `LINGTAI_COPILOT_GITHUB_TOKEN` is read first and wins over the file. Only the
  token's shape is checked, not its permission or expiry
  (`apps/cli/src/copilot-token.ts`).

`lingtai doctor` reports sign-in through `runtime: signed in` (any runtime) and
`runtime: <project> signed in` (the runtime that project dispatches), both off
the probes in `packages/agent/src/auth.ts:31` and `:95`
(`apps/cli/src/doctor.ts:788`, `:2080`). The `codex_text` block is checked per role by
`discuss: <project> codex ready` and `triage: <project> codex ready`
(`apps/cli/src/doctor.ts:2102`), which report a missing block or a `model`
that differs from `codex_text.model`.
