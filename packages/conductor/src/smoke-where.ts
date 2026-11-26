import type { SmokeWhere } from '@lingtai/agent'
import { runnableEnv } from '@lingtai/agent-env'
import { invocationDecision, type SandboxDecision } from '@lingtai/recipe'
import type { SandboxApi } from '@lingtai/sandbox'
import { Effect } from 'effect'

/**
 * Where the hook's smoke test runs (#1479): in the worktree, and through the run's sandbox when the agent's own
 * invocation is sandboxed — the failure it exists to catch (a hook that reads an empty environment) only appears
 * there. **Calls `api.wrap` directly, never `recordingWrap`**: the smoke appends nothing, so it is not a second
 * boundary on the attempt's stream. The operator's carried denies are left out: one that contains the worktree is
 * refused by the agent's own wrap already, and the base policy is what produces the failure.
 */
export function smokeWhere(
  passDecision: SandboxDecision,
  runtime: string,
  worktree: string,
  from: {
    readonly project: string
    readonly mirror: string
    readonly hookBinary: string
    readonly service:
      | Effect.Effect<SandboxApi, { readonly reason: string; readonly sentences: readonly string[] }>
      | undefined
  },
): SmokeWhere {
  const decision = invocationDecision(passDecision, runtime)
  if (decision.kind !== 'sandboxed') return { cwd: worktree }
  const { service } = from
  return {
    cwd: worktree,
    wrap: (input) =>
      service === undefined
        ? Effect.fail({ message: 'no sandbox service in this process' })
        : service.pipe(
            Effect.mapError((e) => ({ message: [e.reason, ...e.sentences].join('; ') })),
            Effect.flatMap((api) =>
              api
                .wrap({
                  project: from.project,
                  mirror: from.mirror,
                  worktree,
                  command: input.command,
                  // The agent's own launch environment: PATH, HOME, … as `runnableEnv` gives it, since the wrap does
                  // not restore PATH and the Linux wrapper finds `bwrap` by name.
                  env: runnableEnv(input.env),
                  project_additions: decision.project_additions,
                  caller_additions: { read: [from.hookBinary] },
                })
                .pipe(
                  Effect.mapError((e) => ({
                    message:
                      e._tag === 'SandboxUnavailable'
                        ? [e.reason, ...e.sentences].join('; ')
                        : e._tag === 'SandboxPolicyRefused'
                          ? `the sandbox policy refused ${e.refusals.map((r) => r.path).join(', ')}`
                          : `srt could not wrap the command: ${e.cause instanceof Error ? e.cause.message : String(e.cause)}`,
                  })),
                ),
            ),
          ),
  }
}
