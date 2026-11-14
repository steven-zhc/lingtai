/**
 * The pass's sandbox decision and the wrap its `run:` commands go through (#1152).
 *
 * Decided **once per pass, before the claim**, so the provision (which writes srt's stand-in names into a side
 * file beside the mirror's `info/exclude`, which each wrapped command is pointed at) and the actions (which wrap) cannot see different answers a minute apart.
 *
 * Nothing here loads srt. The host answer is the provided `Sandbox` service's own where there is one, and
 * `hostHere` (which imports `@lingtai/sandbox/live` only when asked, as the resolver does) where there is not.
 * A recipe with no `sandbox:` block, or `enabled: false`, asks the host nothing at all.
 */
import type { RunSandbox } from '@lingtai/actions'
import { sandboxDecision, verdictOf, type HostVerdict, type SandboxBlock, type SandboxDecision } from '@lingtai/recipe'
import { excludeEnv } from '@lingtai/repo'
import { Sandbox, type ProjectAdditions, type SandboxApi } from '@lingtai/sandbox'
import { readHost } from '@lingtai/sandbox/host'
import { Effect, Option, Result } from 'effect'

import { hostHere } from './projects.ts'

export interface PassSandbox {
  readonly decision: SandboxDecision
  /** The provided `Sandbox` service, when the host gave one. A *sandboxed* decision with none is refused by the pass. */
  readonly service: SandboxApi | undefined
}

export const decidePassSandbox = (block: SandboxBlock | undefined): Effect.Effect<PassSandbox> =>
  Effect.gen(function* () {
    if (block === undefined || !block.enabled) {
      // The answer is never evaluated: `sandboxDecision` returns before it reads one.
      return { decision: sandboxDecision(block, { can: true }, ''), service: undefined }
    }
    const service = Option.getOrUndefined(yield* Effect.serviceOption(Sandbox))
    // `HOME`, never the state directory: `expandHome` turns `~/…` into the user's own paths. A host that cannot be read cannot sandbox.
    const facts = yield* Effect.result(readHost)
    const verdict: HostVerdict = Result.isFailure(facts)
      ? { can: false, reason: facts.failure.reason, sentences: facts.failure.sentences }
      : yield* verdictOf(service?.hostCanSandbox ?? hostHere)
    const home = Result.isSuccess(facts) ? facts.success.home : ''
    return { decision: sandboxDecision(block, verdict, home), service }
  })

/** `Sandbox.wrap`, closed over the pass's project, mirror and the decision's additions. */
export const makeRunSandbox = (
  service: SandboxApi,
  pass: { readonly project: string; readonly mirror: string; readonly additions: ProjectAdditions },
): RunSandbox => ({
  wrap: (command, worktree, env) =>
    service.wrap({
      project: pass.project,
      worktree,
      mirror: pass.mirror,
      command,
      // srt's stand-ins are excluded for this command alone, never in the mirror's shared `info/exclude`.
      env: excludeEnv(pass.mirror, env),
      project_additions: pass.additions,
    }),
})
