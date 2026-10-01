# 0054 — A role keeps its permissions when its agent changes

**Status** accepted · 2026-09-17 · implementation pending · extends
[0007](0007-dual-runtime.md)'s containment argument and
[0033](0033-the-third-kind-of-agent.md)'s discussion boundary; preserves
[0039](0039-the-worktree-is-the-whole-of-a-pass.md)'s development worktree

Choosing Codex or Claude Code changes the runtime, not the powers of the role.
A reviewer runs in a disposable checkout of the exact commit under review.
Discussion executes no commands and modifies no files. A configured limit or
containment requirement that cannot be enforced refuses the invocation.

## Context

The current reviewer shares the development worktree. That permits useful
verification, but also permits a reviewer or its tests to change the work it is
judging. Selecting a different agent does not solve that ambiguity.

The current runtime contract also assumes a shared hook vocabulary and numeric
turn count. Codex's old stub declares capabilities without implementing them.
The installed Codex 0.144.1 protocol and current documentation do not establish
an equivalent to Claude Code's enforced `--max-turns`: a Codex protocol turn can
contain an entire task. Counting those turns would make a plausible limit that
does not bound the work the operator meant to bound.

## Decision

| Role | May do |
|---|---|
| development and fix | read, edit, run commands and tests, create commits in the development worktree |
| review | read the ticket, source and diff, run verification in a separate disposable review worktree, report findings |
| discussion | analyse material Lingtai supplies; no command execution or file modification |

Push, integration and issue closure remain the conductor's effects. Agent
configuration does not grant those effects to an agent.

Each review checks out the exact `onSha`, independently of the development
checkout. Verification outputs are disposable. Changes to reviewed source or
HEAD invalidate that review; they are not incorporated into development. Every
review and re-review has a fresh session, without the implementer's transcript
or plan. Fixes retain the development worktree and receive the refusal's
evidence in their own sessions.

Discussion's boundary is enforced by runtime configuration and capability
verification, never by a prompt asking it to behave. If an adapter cannot uphold
that boundary, it cannot serve discussion. A read-only filesystem sandbox alone
does not prohibit command execution.

Capabilities describe what the adapter enforces **for this role and invocation**.
Codex's native filesystem sandbox and Claude Code's current guarded setup must
be reported accurately, not presented as equivalent containment. A required
tier is never silently downgraded. The historical hook lists in 0007 are not a
permanent capability contract.

Every invocation has an enforced wall timeout and process cleanup. Codex's first
implementation advertises wall enforcement, not a turn bound. An explicit or
inherited `turns` requirement it cannot enforce is a configuration error;
absence does not inject Claude Code's default turn limit into Codex.

An unavailable runtime or a review that could not execute is not a finding about
the code. Such failures spend no fix round or restart and never select another
agent. A missing price is unknown, not zero: record reported tokens and reported
cost, without estimating a bill from public prices.

## Consequences

The repository adapter acquires and cleans up review worktrees independently.
The agent adapter acquires role-specific settings and process resources.
Timeout and abort must leave neither agent descendants nor review checkouts
running unnoticed.

The role boundary and limit must pass real verification on supported platforms
before being advertised. In particular, a Codex discussion is not complete just
because it returns an answer: attempts to execute commands and modify files
must fail. No implementation or verification is claimed by accepting this ADR.

See [the development document](../design/agent-runtimes.md) for interfaces,
failure handling, accounting and the acceptance matrix.
