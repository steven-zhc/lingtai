import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * The pass's sandbox decision and the wrap its `run:` commands go through (#1152).
 *
 * Decided **once per pass, before the claim**, so every action of the pass sees one answer. Provisioning
 * writes nothing for it: each wrapped command prepares its own exclude file (`makeRunSandbox`).
 *
 * Nothing here loads srt. The host answer is the provided `Sandbox` service's own where there is one, and
 * `hostHere` (which imports `@lingtai/sandbox/live` only when asked, as the resolver does) where there is not.
 * A recipe with no `sandbox:` block, or `enabled: false`, asks the host nothing at all.
 */
import type { RunSandbox } from '@lingtai/actions'
import { sandboxDecision, verdictOf, type HostVerdict, type SandboxBlock, type SandboxDecision } from '@lingtai/recipe'
import { excludeEnv, excludeFileText, gitEffect, sandboxExcludePath } from '@lingtai/repo'
import { Sandbox, SandboxWrapFailed, standInExcludes, type ProjectAdditions, type SandboxApi } from '@lingtai/sandbox'
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

/**
 * The command's own exclude file: srt's stand-in names, then the global ignore rules **the command's own
 * environment** resolves (`core.excludesFile` under its `GIT_CONFIG_GLOBAL`, `HOME` and `XDG_CONFIG_HOME`, not
 * the daemon's) **read in the action's worktree**, so a conditional include that matches it applies and a relative
 * path means what it means to the command, because pointing a command at this file replaces them. A new file per command, written whole
 * and removed with the wrap's scope, so no running command ever reads a file that is being rewritten.
 */
const commandExclude = (mirror: string, worktree: string, env: Readonly<Record<string, string>>) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const configured = yield* gitEffect(['config', '--get', '--type=path', 'core.excludesFile'], {
        cwd: worktree,
        env: env as NodeJS.ProcessEnv,
      }).pipe(Effect.orElseSucceed(() => ''))
      const inheritedFrom =
        configured !== ''
          ? resolve(worktree, configured)
          : join(env['XDG_CONFIG_HOME'] || join(env['HOME'] ?? '', '.config'), 'git', 'ignore')
      const file = sandboxExcludePath(mirror, randomUUID())
      yield* Effect.tryPromise({
        try: () =>
          readFile(inheritedFrom, 'utf8')
            .catch((err: NodeJS.ErrnoException) => {
              if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return ''
              throw err
            })
            .then((inherited) =>
              mkdir(dirname(file), { recursive: true }).then(() =>
                writeFile(file, excludeFileText(standInExcludes, inherited)),
              ),
            ),
        catch: (cause) => new SandboxWrapFailed({ cause }),
      })
      return file
    }),
    (file) => Effect.promise(() => rm(file, { force: true })),
  )

/** `Sandbox.wrap`, closed over the pass's project, mirror and the decision's additions. */
export const makeRunSandbox = (
  service: SandboxApi,
  pass: { readonly project: string; readonly mirror: string; readonly additions: ProjectAdditions },
): RunSandbox => ({
  wrap: (command, worktree, env) =>
    Effect.flatMap(commandExclude(pass.mirror, worktree, env), (file) =>
      service.wrap({
        project: pass.project,
        worktree,
        mirror: pass.mirror,
        command,
        // srt's stand-ins are excluded for this command alone, never in the mirror's shared `info/exclude`.
        env: excludeEnv(file, env),
        project_additions: pass.additions,
      }),
    ),
})
