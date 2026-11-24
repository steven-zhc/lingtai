# Safety

*What an agent can read, write and reach*

**From v0.14.0, an agent Lingtai launches can run inside one sandbox boundary, and v0.13.0 has none of what this page describes.** The sandbox is [`srt`](https://github.com/anthropic-experimental/sandbox-runtime) with a policy Lingtai writes ([ADR 0127](decisions/0127-what-an-agent-can-reach.md)). A new project is sandboxed by default; an existing one is off until its recipe has a `sandbox:` block.

![Every agent run sits inside one srt sandbox: it reads and writes its worktree and temp directories, reaches only allowlisted hosts, and is refused your keys, logins and Lingtai's own state. Refused connections are recorded and shown on the board's Sandbox tab, except telemetry hosts; a refused file read is not reported.](img/sandbox.svg)

[Open the diagram at full size](img/sandbox.svg).

## What the sandbox refuses and allows

**Reads** are everything except `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.gnupg`, `~/.netrc`, `~/.docker/config.json`, `~/.kube`, `~/.npmrc`, `~/.claude/.credentials.json`, the whole of `~/.lingtai`, and the project's own `deny`. So are macOS `~/Library/Keychains` and Linux `/var/run/docker.sock`. The run's worktree, the repository mirror (`~/.lingtai/repos/<project>.git`) and cache are allowed back inside `~/.lingtai`; the mirror holds every commit and ref, not only the checkout.

**Writes** are an allowlist: the worktree, the mirror, the temp directories, the project's cache and its `write`. Each runtime adds one directory: Claude Code its own configuration directory, and Codex all of `~/.codex` except `config.toml`, `AGENTS.md` and `rules`, so a Codex run can change `~/.codex/auth.json` without any `write` in the recipe.

**Network** is the built-in hosts (Anthropic, OpenAI, `claude.ai`, npm, GitHub) plus the project's `network.allow`, and nothing else. A Copilot run, and no other, also reaches `*.githubcopilot.com` and writes `~/.copilot`. A refused connection shows on the task page's Sandbox tab, and if the run then fails the step stops for you with no fix round (a run that succeeds anyway goes on); telemetry hosts such as `sentry.io` are refused and not shown.

**Unix sockets.** On Linux every one is reachable; on macOS only the hook-socket directory.

**Wrapped:** Claude Code, Codex, every `run:` command and the base check. Not wrapped: a subscriber, and the merge lane's own `git`, which pushes and merges.

## Turning it on

Setup asks and writes the answer for a new project; it never writes `required` or touches an existing recipe. By hand, add the block to `~/.lingtai/<project>/recipe.yml`:

```yaml
sandbox:
  enabled: true # default true inside a present block; false is the explicit off
  required: true # default false; true refuses the project on a host that cannot sandbox
  network:
    allow: [pypi.org, files.pythonhosted.org] # added to the built-in hosts, never removing one
  write: [~/work/fixtures] # added to the writable paths
  deny: [~/secrets] # added to the unreadable paths
```

Entries only add, paths are `~/…` or absolute, and a protected path is refused; [the reference](reference.md#what-a-run-may-reach--sandbox-the-recipes) has every rule. A sandboxed Claude Code or Copilot run cannot use your login; the token it holds instead is made once: [requirements](requirements.md#tokens-for-a-sandboxed-run). `lingtai doctor` checks the host (also there).

## What the sandbox does not cover

Do not read the sandbox as more than this:

- **The run's own token is readable inside it.** A sandboxed Claude Code run holds a long-lived token. It can reach only allowlisted hosts, and revoking it is yours to do.
- **Codex's login is readable to a Codex run** (`~/.codex/auth.json`).
- **The Copilot token is readable to a Copilot run**, which reaches only `*.githubcopilot.com` beyond the allowlist. Revoking it is yours to do.
- **A refused file read is not reported.** `srt` reports a refused connection and does not report a refused file access, so the run sees an error and you see nothing.
- **`srt` is a research preview**, pinned to one version and recorded on every run. The pin is raised only after the canary passes on both platforms.
- **On macOS a run can read other processes' command lines**, and so for a moment another run's network id, which gives that project's allowlist and nothing more.
- **On Linux every Unix socket is reachable**, except the ones read-denied by name, such as `/var/run/docker.sock`.

`gh` is closed to a sandboxed agent: `~/.config/gh` is denied, so it cannot act as you on GitHub. Lingtai pushes and merges itself, outside the sandbox.

## When the host cannot sandbox

- `required: false` (the default): runs go ahead **unsandboxed**, and each is marked. The project is *degraded*; `lingtai doctor` says so.
- `required: true`: the project is refused when its recipe resolves, and *stopped* until the host can sandbox. If a host loses the sandbox in the middle of an attempt, the attempt fails with no fix round.

**Antigravity cannot run sandboxed on any host** in this release: it runs unsandboxed, and `required: true` refuses a recipe that names it.

Unsandboxed, the agent reads any file you can, including `~/.lingtai/config.yml` and `~/.ssh`. What a runtime's own settings can narrow is in [the operating guide](operating.md#what-your-own-runtime-configuration-can-narrow). At every tier the agent works in its own worktree, its environment is filtered to a few variables and those your project declares, and the recipe that sets its gates lives outside the worktree. With the sandbox off it can read the file Lingtai's credentials are kept in, where its runtime lets it.

Reference: [requirements](requirements.md), [CLI](cli.md), [reference](reference.md), [operating](operating.md), and [SECURITY.md](../SECURITY.md) to report a vulnerability.
