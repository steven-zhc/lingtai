# Safety

*What an agent can read, write and reach*

**From v0.14.0, an agent Lingtai launches can run inside one sandbox boundary,
and a v0.13.0 install has none of what this page describes.** The sandbox is
[`srt`](https://github.com/anthropic-experimental/sandbox-runtime) pinned at
`0.0.83` (`SRT_VERSION`, `packages/sandbox/src/policy.ts:186`), with a policy
Lingtai writes ([ADR 0127](decisions/0127-what-an-agent-can-reach.md)). A new
project is sandboxed by default; an existing project is unchanged until its
recipe has a `sandbox:` block, and an absent block is off.

**This page says "measured" only with its source.** Every other line says what
the code does, and names the file so a reader can check it: the lists below are
quoted from `packages/sandbox/src/policy.ts` and `refusals.ts`, and go stale if
those change. The sandbox measurements are
[experiment 017](milestone/0.14.0/017-srt-under-lingtai.md)'s.

![Every agent run sits inside one srt sandbox: it reads and writes its worktree and temp directories, reaches only allowlisted hosts, and is refused your keys, logins and Lingtai's own state. Refused connections are recorded and shown on the board's Sandbox tab, except telemetry hosts; a refused file read is not reported.](img/sandbox.svg)

[Open the diagram at full size](img/sandbox.svg).

## What the sandbox refuses and allows

**Reads.** A sandboxed run may read everything except the built-in deny list
(`denyRead`, `policy.ts:89-102`) and the project's own `deny`:

- `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.gnupg`, `~/.netrc`,
  `~/.docker/config.json`, `~/.kube`, `~/.npmrc`
- the state directory, `~/.lingtai`, whole: it holds `config.yml`, every other
  project's recipe and run logs
- `~/.claude/.credentials.json`
- on macOS `~/Library/Keychains`; on Linux `/var/run/docker.sock`

The run's own worktree, the mirror and `~/.lingtai/cache/<project>/` are allowed
back inside the denied state directory (`allowRead`, `policy.ts:127`). That the
denied whole and the allowed back hold, and that a git commit in the worktree
works, is measured in 017.

**Writes are an allowlist** (`filesystemFor`, `policy.ts:120-146`): the
worktree, the mirror, the temp directories (`/tmp`, `/private/tmp` on macOS, and
`$TMPDIR`), the project's cache directory, and the project's `write`. Anywhere
else is not writable, which is why the deny list above is unwritable too. Never
writable even inside those: the mirror's `config`, `hooks/` and `info/`, and the
directory of hook sockets.

**Each runtime adds one writable directory of its own** (`caller_additions`):
a Claude Code run gets the run's own configuration directory
(`packages/agent/src/claude-sandbox.ts:205`), and a Codex run gets the whole
Codex home, `~/.codex`, except its `config.toml`, `AGENTS.md` and `rules`, which
stay read-only (`packages/agent/src/codex-sandbox.ts:157-161`). So a Codex run
can change `~/.codex/auth.json` and the rest of that directory without any
`write` in the recipe.

**Network.** A run may connect to the built-in hosts and the project's
`network.allow`, and to nothing else (`BUILT_IN_DOMAINS`, `policy.ts:59-73`):

`api.anthropic.com`, `*.anthropic.com`, `claude.ai`, `*.claude.ai`,
`api.openai.com`, `*.openai.com`, `chatgpt.com`, `*.chatgpt.com`,
`registry.npmjs.org`, `*.npmjs.org`, `github.com`, `*.github.com`,
`*.githubusercontent.com`.

**Telemetry.** `sentry.io` and `*.sentry.io` (`TELEMETRY_HOSTS`,
`packages/sandbox/src/refusals.ts:7`) are not on the list. They are refused like
any other host, recorded on the run, and left out of what a person is shown and
out of the rule below that sends a refusal to a person.

**Unix sockets.** On Linux every Unix socket is reachable
(`allowAllUnixSockets`, `policy.ts:160-162`); on macOS only the hook-socket
directory is allowed, and every run has `enableWeakerNetworkIsolation`.

**What is wrapped:** Claude Code, Codex and every `run:` command, and the base
check. Not wrapped: a subscriber, and the merge lane's own `git`, which runs
outside the sandbox and is how Lingtai pushes and merges, so `gh` stays closed
to the agent.

## Turning it on

Setup asks whether to sandbox the project and writes the answer: `sandbox: {
enabled: true }`, with `network.allow` only where hosts were added, or `{
enabled: false }`. Setup never writes `required`
(`packages/setup/src/setup-answers.ts:106,140`), and it does not touch an
existing project's recipe. To turn it on by hand, add the block to
`~/.lingtai/<project>/recipe.yml`. One complete block:

```yaml
sandbox:
  enabled: true # default true inside a present block; false is the explicit off
  required: true # default false; true refuses the project on a host that cannot sandbox
  network:
    allow: [pypi.org, files.pythonhosted.org] # added to the built-in hosts, never removing one
  write: [~/work/fixtures] # added to the writable paths
  deny: [~/secrets] # added to the unreadable paths
```

The rules (ADR 0127 §13, checked in `packages/recipe/src/sandbox.ts` and
`sandbox-block.ts`):

- `network.allow`, `write` and `deny` only add: none removes a built-in entry.
  A network entry is a hostname or `*.` and a hostname, with no scheme, port or
  path.
- A path is `~/…` or absolute. A relative path is refused.
- `enabled: false` with `required: true` is refused: a project cannot need a
  sandbox and not have one.
- A `write` that is, lies inside or contains a protected path is refused when
  the recipe resolves: the deny list, `~/.lingtai`, the mirror, the runtimes'
  configuration directories (`~/.claude`, `~/.claude.json`, `~/.codex`) and the
  host's tool and cache directories. A `write` that is `$HOME` or contains it
  is refused; `~/work/fixtures` is not.
- A `deny` is held to the same protected-path check as a `write`
  (`checkSandboxBlock` runs `refuseProtected` on both lists): one that is, lies
  inside or contains a protected path is refused too, such as the runtimes'
  configuration directories (`~/.codex/auth.json` is inside `~/.codex`), the
  host's tool and cache directories, or the deny list itself. It is also refused
  inside the worktree or the mirror, because the run's `allowRead` overrides
  `denyRead` there.

A recipe that still says `runtime.tier` is refused, with its replacement by
value (`packages/recipe/src/resolve.ts:295-305`): `tier: sandboxed` becomes
`sandbox: { enabled: true, required: true }`, and `tier: guarded` or
`tier: open` is deleted. Lingtai does not rewrite the file.

## The Claude token

A sandboxed Claude Code run cannot use your login: `~/.claude/.credentials.json`
is denied to it. It uses a long-lived token you make once:

    lingtai token claude

This runs `claude setup-token` and saves the result as `claude.oauth_token` in
`~/.lingtai/config.yml` (`apps/cli/src/claude-token.ts`). The variable
`LINGTAI_CLAUDE_OAUTH_TOKEN` is read first, and a terminal is needed to run the
command: without one it tells you to set the key in the file by hand. The run
gets the token as `CLAUDE_CODE_OAUTH_TOKEN`, and a configuration directory of its
own with the hook settings and copies of your user-level `CLAUDE.md`, `skills/`
and `agents/`, but no MCP servers, plugins, `settings.json` or login.

## The Copilot token

A sandboxed Copilot run is handed a token you make once: a fine-grained personal
access token (`github_pat_…`) with the *Copilot Requests* account permission. A
classic `ghp_` token is silently ignored by Copilot, so the command refuses it by
name:

    lingtai token copilot

This asks for the token at a hidden prompt and saves it as `copilot.github_token`
in `~/.lingtai/config.yml` (`apps/cli/src/copilot-token.ts`). The variable
`LINGTAI_COPILOT_GITHUB_TOKEN` is read first, and wins over the file. Only the
token's shape is checked, not its permission or expiry.

## Checking the host

`lingtai doctor` reports two kinds of sandbox row (`apps/cli/src/doctor.ts`):

- `sandbox: host`: whether this host can run the sandbox, and if not, srt's own
  sentences and the install command for the platform.
- `sandbox: <project>`: one of *sandboxed*, *off by choice*, *degraded* or
  *stopped*, from the recipe's block and the host.

It also runs a live canary (`apps/cli/src/sandbox-canary.ts`): four commands
through the same wrapper a run gets. Two must fail, a planted file under a denied
path and a host off the allowlist, and two must succeed as controls. So the
policy is known to hold by running it, not by reading its configuration. The
canary runs only where the host can sandbox and some project asks for it.

## On the board

The task page has a Sandbox tab (#1161) and the recipe page a sandbox section
(#1162). A shield sits before health's dot (#1183), and a banner says when a
project is *degraded* or *stopped* (#1183, #1167). A refused connection is an
event on the attempt's stream. A step whose run failed with a refused connection
stops for a person, with no fix round bought (ADR 0127 §14); telemetry hosts do
not count.

## When the host cannot sandbox

- `required: false` (the default): runs go ahead **unsandboxed**, and each is
  marked. The project is *degraded*. Doctor says so and gives the fix.
- `required: true`: the project is refused when its recipe resolves, and it is
  *stopped* until the host can sandbox. Setup never writes this, so you choose
  it.

If a host loses the sandbox in the middle of an attempt under `required: true`,
the attempt fails with no fix round.

## What the sandbox does not cover

Do not read the sandbox as more than this (ADR 0127 §18):

- **The run's own token is readable inside it.** A sandboxed Claude Code run
  holds a long-lived token. It can reach only allowlisted hosts, and revoking it
  is yours to do.
- **Codex's login is readable to a Codex run** (`~/.codex/auth.json`).
- **A refused file read is not reported.** `srt` reports a refused connection and
  does not report a refused file access, so the run sees an error and you see
  nothing.
- **`srt` is a research preview**, pinned to one version and recorded on every
  run. The pin is raised only after the canary passes on both platforms.
- **On macOS a run can read other processes' command lines**, and so for a
  moment another run's network id, which gives that project's allowlist and
  nothing more.
- **On Linux every Unix socket is reachable**, except the ones read-denied by
  name, such as `/var/run/docker.sock`.

`gh` is closed to a sandboxed agent: `~/.config/gh` is denied, so it cannot act
as you on GitHub. Lingtai pushes and merges itself, outside the sandbox.

## Without the sandbox

For a project whose sandbox is off, or degraded, nothing above applies and the
agent runs as your user. The table below is what each runtime does then. Its
cells are a measured or documented fact with its source, or say *not measured*,
which is not a promise in either direction.

Measurements: **Claude Code** — darwin, Claude Code 2.1.310, 2026-10-27.
**Codex** — a profile's `deny` entries: darwin, codex-cli 0.164.0, 2026-11-01;
the `workspace-write` write boundary: codex-cli 0.155.1, 2026-09-29 (#313),
not re-measured on 0.164.0. The measurements are in
[what your own runtime configuration can narrow](operating.md#what-your-own-runtime-configuration-can-narrow);
they landed in #664, #667 and #800. A later version of either runtime is not
covered by them.

| | Claude Code, sandbox off | Claude Code with your own sandbox | Codex |
| --- | --- | --- | --- |
| **Which files can the agent read?** | Any file you can, including `~/.lingtai/config.yml` and `~/.ssh`. With the sandbox off, Lingtai gives it no filesystem sandbox. | The paths in `filesystem.denyRead` are refused. Measured on a throwaway directory, not on `~/.ssh` (darwin, Claude Code 2.1.310, 2026-10-27). Any path you do not list: *not measured*. | *Not measured* without a profile. A profile's `deny` entries are refused. Measured on a throwaway directory, not on `~/.ssh` (darwin, codex-cli 0.164.0, 2026-11-01, #800). |
| **Which directories can it write?** | Anywhere you can. With the sandbox off, Lingtai gives it no filesystem sandbox. | *Not measured* over a whole attempt. | The worktree, `$TMPDIR`, `/tmp` and the git directories Lingtai adds for committing. `workspace-write` refuses `$HOME` and `~/.lingtai` (#313; codex-cli 0.155.1, 2026-09-29; not measured on 0.164.0). |
| **Can it reach the network?** | Yes. | Not limited by this setting: `denyRead` says nothing about the network. | *Not measured*. |
| **What protects the run?** | Nothing beyond what Lingtai does at every tier (below). | Claude Code's sandbox, with `allowUnsandboxedCommands: false`. | `--sandbox workspace-write`. |
| **What is still a risk by default?** | All of the above. Your `gh` login is on the machine, so an agent without a sandbox can run `gh` as you; Lingtai does not hand it a token. `permissions.deny` alone covers only Claude Code's own Read tool, not a subprocess. | Without `allowUnsandboxedCommands: false` the sandbox can be escaped under Lingtai: `bypassPermissions` approves the unsandboxed retry without asking. Linux without bubblewrap has no sandbox (*not measured*). An agent run drops `CLAUDE_CONFIG_DIR`, so Claude Code reads `~/.claude`: settings kept under a custom config directory do not apply. `gh`: *not measured*. | A `sandbox_mode` in your `~/.codex/config.toml` keeps the old behaviour: the profile does not apply and reads succeed. `gh`: *not measured*. |

**Can the agent read my `~/.ssh`?**

- Claude Code with the sandbox off: **yes**.
- Claude Code with your sandbox: if you list `~/.ssh` in `denyRead`, the one path
  measured, a throwaway directory, was refused. `~/.ssh` itself was not measured.
- Codex: if your profile denies `~/.ssh`, the one path measured, a throwaway
  directory, was refused. `~/.ssh` itself was not measured. Without a profile,
  *not measured*.

Linux is not measured for either runtime, except for the bubblewrap line in the
table.

## What Lingtai does at every tier

Containment is the worktree and the filtered environment, whether or not the
sandbox is on (`packages/agent/src/runtime.ts`).

- The agent works in its own git worktree, not in your checkout.
- Its environment is filtered to `PATH`, `HOME`, `TMPDIR`, `LANG`, `USER` and
  `LOGNAME`, plus the variables your project declares. Lingtai's `LINGTAI_*`
  credentials and database URL are not in it, though with the sandbox off the
  agent can read the file they are kept in, where its runtime lets it.
- The recipe that sets its gates is outside the worktree, so a change it commits
  cannot weaken its own checks.

## What to do

- Run Lingtai under a user or machine whose files you are willing to expose to
  the agent.
- To report a vulnerability, open an issue titled "security" with no details
  and we will reach you privately. See [SECURITY.md](../SECURITY.md).

The `settings.json` that closes a path for Claude Code is in the
[operating guide](operating.md#what-your-own-runtime-configuration-can-narrow).
