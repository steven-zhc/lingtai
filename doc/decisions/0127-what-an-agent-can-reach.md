# 0127 — What an agent can reach is decided by one boundary, and the recipe has no tier

**Status** accepted · 2026-11-13 · not yet built

An agent runs inside one boundary, `srt`, with a policy Lingtai writes: which
files it may read and write, which hosts it may connect to, and what it is
given of the operator's own accounts. The `sandbox` block of the recipe owns
containment and there is no tier. This ADR is the decision;
[the 0.14 plan](../milestone/0.14.0/0.14.md) holds what a person sees and sets
on the board. Measurements are
[experiment 017](../experiments/017-srt-under-lingtai.md)'s.

Not built: the code still carries the tier, and removing it is what makes §10
true.

## Decision

1. **`srt` (`@anthropic-ai/sandbox-runtime`) is the only boundary.** Claude
   Code's own sandbox and Codex's `workspace-write` are off inside it, because
   neither can run nested. Outside `srt`, Codex keeps `-s workspace-write` and
   the operator's permission profile.

2. **A refused connection is an event on the attempt's stream; a refused file
   access is not.** `srt` reports the first and does not report the second.

3. **One allowlist per project, added to a built-in default.** The default is
   the model APIs (Anthropic, Claude, OpenAI, ChatGPT), `registry.npmjs.org`
   and GitHub, the exact list being #1146's. Telemetry hosts such as
   `sentry.io` are not on it (§17). `srt` runs as one instance per process
   holding only the defaults; each run registers its project's list under a
   random id of at least 128 bits. The child is spawned with `shell: false` and
   Lingtai's filtered environment plus `srt`'s proxy variables, never the
   environment `srt` returns with its argv. `srt` puts the id briefly in a
   command line, and on macOS a run reads other processes' command lines, so
   another project's allowlist is an accepted residual (§18).

4. **New projects are sandboxed by default; an existing project is unchanged
   until its recipe says otherwise.** An absent `sandbox` block is off.

5. **`gh` is closed to the agent.** `~/.config/gh` is denied, and Lingtai
   pushes and merges outside the sandbox.

6. **The runtimes' config directories stay readable, except Claude Code's
   login.** `~/.claude/.credentials.json`, and on macOS `~/Library/Keychains`,
   are denied. Codex's `~/.codex/auth.json` stays readable to a Codex run
   (§18).

7. **On Linux the hook socket gets through with `allowAllUnixSockets`, and
   known dangerous sockets are read-denied**, `/var/run/docker.sock` first.

8. **Each Claude Code run gets its own `CLAUDE_CONFIG_DIR` holding only an
   access token.** Lingtai refreshes the operator's login outside the sandbox,
   reads it from the store that session's Claude Code uses (the Keychain in a
   macOS desktop session or LaunchAgent, the file otherwise), judges it by
   `expiresAt`, and refuses the run when it is still short. A run never holds
   the refresh token.

9. **On macOS every run has `enableWeakerNetworkIsolation`.** Codex needs
   `trustd` to verify TLS, and `srt` reads the option per process, not per
   command. Each run records it.

10. **The `sandbox` block owns containment; there is no tier.** Failing closed
    is required of every runtime that runs tools: the runtime stops the run
    when the hook refuses. A model-only runtime has nothing to fail. A recipe
    that still writes `runtime.tier` is refused, with its replacement by value.

11. **A run's caches are Lingtai's:** `~/.lingtai/cache/<project>/`, per
    project. The host's tool and cache directories (`~/.cache`, `~/.local`,
    `$PNPM_HOME`, `~/Library` on macOS, every directory on Lingtai's `PATH`)
    are read-only to a run.

12. **The deny list.** These paths are unreadable and unwritable: `~/.ssh`,
    `~/.aws`, `~/.config/gh`, `~/.gnupg`, `~/.netrc`, `~/.docker/config.json`,
    `~/.kube`, `~/.npmrc`, `~/.lingtai/config.yml` with every backup beside it,
    `~/.claude/.credentials.json`, and on macOS `~/Library/Keychains`. Inside
    writable directories these are write-denied: the mirror's `config`,
    `hooks/` and `info/`; `~/.claude`'s settings, hooks and plugins; and
    `<tmpdir>/lingtai`, where the hook sockets are. A run still connects to its
    socket and cannot remove or replace one.

13. **The `sandbox` block's rules.**
    - `enabled` defaults to true inside a present block; an absent block is
      off.
    - `required` says whether the project may run without the sandbox.
    - `network.allow`, `write` and `deny` are add-only: they extend the policy
      and never remove from it.
    - A `write` that is, lies inside, or contains a protected path is refused
      at resolve.
    - A `deny` inside `<stateDir>/worktrees/<project>/` or the mirror is
      refused at resolve, because `srt`'s `allowRead` overrides `denyRead`.
    - The fallback is decided once per run, before it starts.
      `required: true` refuses the project at resolve when the host cannot
      provide the sandbox ([0126](0126-a-stop-is-a-lock-and-an-unlock.md),
      *A required sandbox the host cannot provide*); `required: false` runs
      unsandboxed and says so.

14. **A refusal the sandbox caused goes to a person.** A step whose run failed
    with a refused connection, not counting §17's list, refuses with
    `sandbox-refused`, which only a person answers: no fix round, and a
    declared judge for it is refused at resolve. A host that loses the sandbox
    mid-attempt under `required: true` fails the attempt with no fix round;
    under `required: false` later runs go ahead unsandboxed, each marked.

15. **What is wrapped.** Claude Code, Codex and every `run:` at every step
    `runPlugin` serves, and the base check. Not wrapped: a subscriber, which
    runs in the daemon's own directory, and the merge lane's own `git`. A base
    check's answer is keyed by the boundary it ran under.

16. **The operator's own denies carry over.** The read and write denies in
    `~/.claude/settings.json` and in the operator's Codex permission profile go
    on the policy's deny lists for every run of the project. Settings or a
    profile Lingtai cannot read refuse the run.

17. **Known telemetry hosts** are a built-in list, refused like any other host,
    recorded on the run and left out of what a person is shown and of §14's
    rule.

18. **What is not covered.**
    - Codex's login is readable to a Codex run.
    - A refused file access is not reported (§2).
    - `srt` is a research preview pinned to one version, recorded on every run;
      the pin is raised only after the canary passes on both hosts. A host's
      policy is known to hold by the canary, never by reading its
      configuration.
    - On macOS, other processes' command lines are readable from inside, and
      with them, for a moment, another run's network id. That gives that
      project's allowlist and nothing more.
    - On Linux every Unix socket is reachable.

---
*Replaces the tier of [0106](0106-a-role-keeps-its-powers-across-runtimes.md) §4.*
