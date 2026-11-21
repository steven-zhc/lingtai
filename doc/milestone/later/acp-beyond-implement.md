# An ACP agent beyond `implement`

Moved out of #1300 on 2026-11-21. In 0.16 an ACP agent (`copilot`) runs at
`implement` only, its fix rounds included (#1346). The recipe refuses it at
`review`, at a judge, as `runtime.agent`, and at triage.

## Review and judge: whose stream do their tool calls go on?

An ACP run refuses to start without the hook
(`packages/agent/src/acp.ts:398-411`: *"refusing to run unrecorded"*). The
reviewer and the judge run unhooked on purpose
(`packages/agent/src/hook-config.ts:140-145`): *"the hook carries the lifecycle
of a run, and a reviewer is not a run"*. Wiring the reviewer to the
implementer's socket would put its tool calls under the implementer's id. Giving
it an id of its own would open a stream nobody reads.

So before `copilot` can review or judge, one of these is decided:

- the hook gains a mode for a step inside a run, and records the step's tool calls under the run, tagged with the step;
- the reviewer and the judge get a run id of their own, and something reads it (the task page, the report);
- the ACP runtime gets a recorded-but-not-reported mode, used only for steps inside a run.

The other half lands with #1300 itself: when the runtime cannot enforce
`outputSchema`, the prompt asks for the answer's shape. Once #1300 lands, that
part needs no more work.

## Triage: may it run an agent that can use tools?

Triage runs with `tools: 'none'` (`packages/recipe/src/recipe.ts:3061-3064`,
`apps/cli/src/triage.ts:1344`). Copilot's ACP agent has no tool-free mode: it
throws `ToolsCannotBeDenied` (doc/design/1298.md §4, experiment 019 E2). That
is why `DiscussAgent` is `claude-code | codex` (`recipe.ts:2928`).

Allowing it means deciding that the agent which reads a failure and advises may
also act. That breaks triage's premise that it only reports (ADR 0108 §16). This
is a question for discussion first, not code.
