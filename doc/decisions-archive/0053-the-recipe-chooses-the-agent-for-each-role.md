# 0053 — The recipe chooses the agent for each role

**Status** accepted · 2026-09-17 · implementation pending · **supersedes
[0046 §3](0046-lingtai-is-personal.md)'s placement of agent selection and run
limits in the machine file**; keeps its personal topology and recipe location

The project recipe chooses the agent and model for development, discussion and
each agent gate. Its top-level `runtime` is the default for that project;
`development.runtime`, `discussion.runtime` and a gate's `runtime` override it.
The recipe stays at `~/.lingtai/<project>/recipe.yml`.

## Context

0046 correctly made Lingtai personal and removed the need to commit its
configuration to a team repository. It then placed `runtime.agent` and
`runtime.limits` in `~/.lingtai/config.yml`, with per-project overrides.

That describes a machine choosing one agent. The requirement now is a project
choosing different agents for different work: **Codex develops, Claude Code
reviews**, or the reverse; two review gates may use different agents. Discussion
is part of the same choice, while keeping [0033](0033-the-third-kind-of-agent.md)'s
prohibition on command execution and file modification.

Installed CLIs and their authentication are machine capabilities. Which of those
CLIs should do a project's work is a recipe decision. Keeping gate prompts in
one file and their agents in another would split one decision across two sources.

## Decision

```yaml
runtime:
  agent: codex
  limits:
    wall: 1h
    rounds: 2
    restarts: 0

development:
  runtime:
    agent: codex

discussion:
  runtime:
    agent: claude-code
    limits:
      wall: 5m

gates:
  proposed:
    - name: code-review
      agent: |
        Check correctness, failure paths and concurrency.
      runtime:
        agent: claude-code
        limits:
          turns: 150
          wall: 15m
```

- `agent` is `claude-code` or `codex`. `model` is optional within each runtime.
  New projects explicitly settle their default agent during onboarding.
- An absent role override inherits the project's runtime. An override that
  explicitly specifies `agent` does not inherit the project's `model`, even if
  it names the same agent. Without its own model it uses that agent's default.
  A model-only override inherits the agent.
- Fixes use the resolved development runtime. A review gate overrides only its
  own invocation, never development or another gate.
- Single-invocation limits belong beside the runtime they bound and inherit by
  field. `rounds` and `restarts` remain only in the top-level runtime: they bound
  the pass and ticket, not a reviewer or a discussion answer.
- The existing gate `agent:` string remains a review prompt. `runtime.agent`
  chooses who answers it. Development is a phase, not a sixth gate point;
  [0016](0016-the-settled-model.md)'s five points remain closed.
- Explicit selection never falls back to another agent. Unavailability is
  reported with the affected project and role.

## Consequences

The CLI, daemon host, doctor and project settings must resolve the same role
configuration. A single runtime injected for the entire conductor is no longer
enough. Each invocation records the agent, requested and observed model, limits
and session it actually used.

A pass fixes its recipe at entry; edits affect the next pass, including a later
restart. A discussion fixes its runtime when the conversation starts. Historical
recipe records remain records under [0047](0047-the-recipe-a-run-got-is-on-the-log.md),
not sources for a future pass.

Existing machine choices and limits migrate to the project's recipe with a
backup and conflict detection. Machine-wide defaults are materialised for each
registered project; the old fields stop being live configuration after migration.
Machine credentials, ports, storage and assignee selection remain machine concerns.

The full configuration rules, migration and development sequence are in
[the development document](../design/agent-runtimes.md).
