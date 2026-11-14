/**
 * The pass's sandbox decision and the wrap its `run:` commands go through (#1152).
 *
 * Decided **once per pass, before the claim**, so every action of the pass sees one answer. Provisioning
 * writes srt's stand-in names into the mirror's `info/exclude` under a *sandboxed* decision.
 *
 * Nothing here loads srt. The service is `RunOnceOptions.sandbox`, a lazy Effect a host hands in at its edge, and it
 * is run only when the block is enabled: a recipe with no `sandbox:` block, or `enabled: false`, asks the host nothing
 * at all. A service that cannot be built is a `can: false` verdict carrying its reason and sentences.
 */
import type { RunSandbox } from '@lingtai/actions'
import { sandboxDecision, verdictOf, type HostVerdict, type SandboxBlock, type SandboxDecision } from '@lingtai/recipe'
import type { ProjectAdditions, SandboxApi } from '@lingtai/sandbox'
import { readHost } from '@lingtai/sandbox/host'
import { Effect, Result } from 'effect'

export interface PassSandbox {
  readonly decision: SandboxDecision
  /** The provided `Sandbox` service, when the host gave one. A *sandboxed* decision with none is refused by the pass. */
  readonly service: SandboxApi | undefined
}

export type SandboxService = Effect.Effect<
  SandboxApi,
  { readonly reason: string; readonly sentences: readonly string[] }
>

export const decidePassSandbox = (
  block: SandboxBlock | undefined,
  sandbox: SandboxService | undefined,
): Effect.Effect<PassSandbox> =>
  Effect.gen(function* () {
    if (block === undefined || !block.enabled) {
      // The answer is never evaluated: `sandboxDecision` returns before it reads one.
      return { decision: sandboxDecision(block, { can: true }, ''), service: undefined }
    }
    // `HOME`, never the state directory: `expandHome` turns `~/…` into the user's own paths. A host that cannot be read cannot sandbox.
    const facts = yield* Effect.result(readHost)
    const home = Result.isSuccess(facts) ? facts.success.home : ''
    if (Result.isFailure(facts)) {
      const verdict: HostVerdict = { can: false, reason: facts.failure.reason, sentences: facts.failure.sentences }
      return { decision: sandboxDecision(block, verdict, home), service: undefined }
    }
    if (sandbox === undefined) {
      return { decision: { kind: 'refused', why: 'no sandbox service in this process' }, service: undefined }
    }
    const built = yield* Effect.result(sandbox)
    if (Result.isFailure(built)) {
      const verdict: HostVerdict = { can: false, reason: built.failure.reason, sentences: built.failure.sentences }
      return { decision: sandboxDecision(block, verdict, home), service: undefined }
    }
    const verdict = yield* verdictOf(built.success.hostCanSandbox)
    return { decision: sandboxDecision(block, verdict, home), service: built.success }
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
      env,
      project_additions: pass.additions,
    }),
})
