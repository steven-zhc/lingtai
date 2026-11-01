# What an agent can read, write and reach

An agent Lingtai launches runs on your machine, as your user. This page says
what it can touch, per runtime, for a reader deciding whether to run Lingtai.

**Every cell below is a measured or documented fact with its source, or says
*not measured*.** A *not measured* cell is not a promise in either direction.

Measurements: **Claude Code** — darwin, Claude Code 2.1.310, 2026-10-27.
**Codex** — a profile's `deny` entries: darwin, codex-cli 0.164.0, 2026-11-01;
the `workspace-write` write boundary: codex-cli 0.155.1, 2026-09-29 (#313),
not re-measured on 0.164.0. The measurements are in
[what your own runtime configuration can narrow](operating.md#what-your-own-runtime-configuration-can-narrow);
they landed in #664, #667 and #800. A later version of either runtime is not
covered by them.

## The runtime safety table

| | Claude Code, as Lingtai launches it | Claude Code with your own sandbox | Codex |
| --- | --- | --- | --- |
| **Which files can the agent read?** | Any file you can, including `~/.lingtai/config.yml` and `~/.ssh`. Lingtai gives it no filesystem sandbox (`README.md`, *Not contained*). | The paths in `filesystem.denyRead` are refused. Measured on a throwaway directory, not on `~/.ssh` (darwin, Claude Code 2.1.310, 2026-10-27). Any path you do not list: *not measured*. | *Not measured* without a profile. A profile's `deny` entries are refused. Measured on a throwaway directory, not on `~/.ssh` (darwin, codex-cli 0.164.0, 2026-11-01, #800). |
| **Which directories can it write?** | Anywhere you can. Lingtai gives it no filesystem sandbox. | *Not measured* over a whole pass. | The worktree, `$TMPDIR`, `/tmp` and the git directories Lingtai adds for committing. `workspace-write` refuses `$HOME` and `~/.lingtai` (#313; codex-cli 0.155.1, 2026-09-29; not measured on 0.164.0). |
| **Can it reach the network?** | Yes. | Not limited by this setting: `denyRead` says nothing about the network. | *Not measured*. |
| **What protects the run?** | Nothing beyond what Lingtai does at every tier (below). | Claude Code's sandbox, with `allowUnsandboxedCommands: false`. | `--sandbox workspace-write`. |
| **What is still a risk by default?** | All of the above. Your `gh` login is on the machine, so an agent without a sandbox can run `gh` as you; Lingtai does not hand it a token. `permissions.deny` alone covers only Claude Code's own Read tool, not a subprocess. | Without `allowUnsandboxedCommands: false` the sandbox can be escaped under Lingtai: `bypassPermissions` approves the unsandboxed retry without asking. Linux without bubblewrap has no sandbox (*not measured*). A pass drops `CLAUDE_CONFIG_DIR`, so Claude Code reads `~/.claude`: settings kept under a custom config directory do not apply. `gh`: *not measured*. | A `sandbox_mode` in your `~/.codex/config.toml` keeps the old behaviour: the profile does not apply and reads succeed. `gh`: *not measured*. |

**Can the agent read my `~/.ssh`?**

- Claude Code as launched: **yes**.
- Claude Code with your sandbox: if you list `~/.ssh` in `denyRead`, the one path
  measured, a throwaway directory, was refused. `~/.ssh` itself was not measured.
- Codex: if your profile denies `~/.ssh`, the one path measured, a throwaway
  directory, was refused. `~/.ssh` itself was not measured. Without a profile,
  *not measured*.

Linux is not measured for either runtime, except for the bubblewrap line in the
table.

## What Lingtai does at every tier

Containment is the worktree and the filtered environment, at every tier
(`packages/agent/src/runtime.ts`).

- The agent works in its own git worktree, not in your checkout.
- Its environment is filtered to `PATH`, `HOME`, `TMPDIR`, `LANG`, `USER` and
  `LOGNAME`, plus the variables your project declares. Lingtai's `LINGTAI_*`
  credentials and database URL are not in it, though the agent can read the file
  they are kept in, where its runtime lets it.
- The recipe that sets its gates is outside the worktree, so a change it commits
  cannot weaken its own checks.

A tier named `guarded` is not a protection of files or the network. It is a
runtime that stops the run when the `UserPromptSubmit` hook refuses the prompt.
`sandboxed` adds a filesystem boundary the runtime enforces itself; Codex
provides one and Claude Code does not.

This is the state before a sandbox the agent cannot leave (#339).

## What to do

- Run Lingtai under a user or machine whose files you are willing to expose to
  the agent.
- To report a vulnerability, open an issue titled "security" with no details
  and we will reach you privately. See [SECURITY.md](../SECURITY.md).

The `settings.json` that closes a path for Claude Code is in the
[README](../README.md#what-an-agent-can-reach).
