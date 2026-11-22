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

**Decided (operator, 2026-11-21): one ACP client with an explicit switch.**
Lingtai already knows which step it starts each Copilot process for, so
nothing has to be told apart from the messages. The ACP client gains a mode
the dispatcher names: *recorded* (implement, its fix rounds) or *not
reported* (review, a judge). In *recorded*, missing hook wiring is still an
error, so a wiring bug like #1346's never turns silently into an unrecorded
run. In *not reported*, the tool calls are not sent to the run's socket — the
same as a Claude Code reviewer today — but are written to that step's own
run log, which a Claude Code reviewer does not even have. Not two clients:
the protocol, permission and reply code is the same, and only the forwarding
differs.

The other half lands with #1300 itself: when the runtime cannot enforce
`outputSchema`, the prompt asks for the answer's shape. Once #1300 lands, that
part needs no more work.

## Triage: an ACP agent may use tools, and only its advice is taken

**Leaning (operator, 2026-11-21).** With Claude Code and Codex, triage still
runs with no tools. With an ACP agent, which cannot be denied tools, it may
use them: Lingtai takes only the advice it answers, and never anything it
changed. There is a precedent: `triage.tools: full` already runs Codex in a
throwaway clone made for that one triage and deleted after it
(`apps/cli/src/triage.ts:1330`, `:1572-1595`;
`apps/cli/src/triage-checkout.ts:45-57`). An ACP triage agent would always
take that path.

**It runs inside the sandbox (0127), always** (operator, 2026-11-21), so it
reaches nothing outside the clone but the hosts its model needs. Copilot is
measured to work there: with `COPILOT_GITHUB_TOKEN` in place of `gh`'s login
it did a whole task inside srt with 0 violations, and a command the sandbox
blocks ends as a refused tool call, then `end_turn` with an error as text,
never a crash (doc/experiments/019 E10, finding 6). Its model's hosts are
already the runtime's own (`COPILOT_NETWORK`, `packages/agent/src/sandbox-facts.ts:9`).
Antigravity cannot run in the sandbox (019 E10: it must bind a local port and
read the keychain), so it stays refused at triage.

**ADR 0108 §16's wording** (operator, 2026-11-21): *"an agent names a cause
but never acts"* becomes *"an agent names a cause, and only its answer is
taken: an agent that can be denied tools runs with none, and one that cannot
(an ACP runtime) runs in a throwaway clone inside the sandbox, and nothing it
changed there is read"*. The triage ticket makes that edit.
019 measured an implement task in the sandbox, not a triage, so the ticket's
first check is a sandboxed Copilot triage that answers.

What follows is the question as first written.

Triage runs with `tools: 'none'` (`packages/recipe/src/recipe.ts:3061-3064`,
`apps/cli/src/triage.ts:1344`). Copilot's ACP agent has no tool-free mode: it
throws `ToolsCannotBeDenied` (doc/design/1298.md §4, experiment 019 E2). That
is why `DiscussAgent` is `claude-code | codex` (`recipe.ts:2928`).

Allowing it means deciding that the agent which reads a failure and advises may
also act. That breaks triage's premise that it only reports (ADR 0108 §16). This
is a question for discussion first, not code.
