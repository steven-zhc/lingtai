import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

/**
 * The pass's sandbox decision and the wrap its `run:` commands go through (#1152).
 *
 * Decided **once per pass, before the claim**, so every action of the pass sees one answer. Provisioning
 * writes nothing for it: each wrapped command prepares its own exclude file (`makeRunSandbox`).
 *
 * Nothing here loads srt. The service is `RunOnceOptions.sandbox`, a lazy Effect a host hands in at its edge, and it
 * is run only when the block is enabled: a recipe with no `sandbox:` block, or `enabled: false`, asks the host nothing
 * at all. A service that cannot be built is a `can: false` verdict carrying its reason and sentences.
 */
import type { RunSandbox } from '@lingtai/actions'
import { sandboxDecision, verdictOf, type HostVerdict, type SandboxBlock, type SandboxDecision } from '@lingtai/recipe'
import { excludeConfigText, excludeEnv, excludeFileText, gitEffect, sandboxExcludePath } from '@lingtai/repo'
import {
  SandboxWrapFailed,
  filesystemFor,
  standInExcludes,
  staticPrefix,
  type ProjectAdditions,
  type SandboxApi,
} from '@lingtai/sandbox'
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

/**
 * The command's own exclude file: srt's stand-in names, then the global ignore rules **the command's own
 * environment** resolves (`core.excludesFile` under its `GIT_CONFIG_GLOBAL`, `HOME` and `XDG_CONFIG_HOME`, not
 * the daemon's) **read in the action's worktree**, so a conditional include that matches it applies and a relative
 * path means what it means to the command, because pointing a command at this file replaces them. A new file per command, written whole
 * and removed with the wrap's scope, so no running command ever reads a file that is being rewritten.
 */
const commandExclude = (
  pass: { readonly project: string; readonly mirror: string; readonly additions: ProjectAdditions },
  worktree: string,
  env: Readonly<Record<string, string>>,
) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const { mirror } = pass
      const host = yield* readHost.pipe(Effect.mapError((cause) => new SandboxWrapFailed({ cause })))
      const policy = filesystemFor(host, {
        project: pass.project,
        worktree,
        mirror,
        project_additions: pass.additions,
      })
      const configured = yield* gitEffect(['config', '--get', '--type=path', 'core.excludesFile'], {
        cwd: worktree,
        env: env as NodeJS.ProcessEnv,
      }).pipe(Effect.orElseSucceed(() => ''))
      const inheritedFrom =
        configured !== ''
          ? resolve(worktree, configured)
          : join(env['XDG_CONFIG_HOME'] || join(env['HOME'] ?? '', '.config'), 'git', 'ignore')
      const gitdir = yield* gitEffect(['rev-parse', '--absolute-git-dir'], {
        cwd: worktree,
        env: env as NodeJS.ProcessEnv,
      }).pipe(Effect.mapError((cause) => new SandboxWrapFailed({ cause })))
      const file = sandboxExcludePath(mirror, randomUUID())
      const config = `${file}.config`
      yield* Effect.tryPromise({
        try: () =>
          readInherited(inheritedFrom, policy)
            .then((inherited) => mkdir(dirname(file), { recursive: true }).then(() => inherited))
            .then((inherited) => writeFile(file, excludeFileText(standInExcludes, inherited)))
            .then(() => writeFile(config, excludeConfigText(file))),
        catch: (cause) => new SandboxWrapFailed({ cause }),
      })
      return { config, gitdir: gitdir.trim(), file }
    }),
    ({ file, config }) => Effect.promise(() => Promise.all([rm(file, { force: true }), rm(config, { force: true })])),
  )

/**
 * Reads the inherited ignore file from outside the sandbox, so it is read the way the sandbox's own read policy
 * would: whatever the file's real path (a symlink included, in the worktree or out of it) it is read only where the
 * command itself could read it — not under a `denyRead` entry unless an `allowRead` one covers it. Containment is
 * not the question: a shared ignore file outside the worktree is readable. A missing file is empty.
 */
function readInherited(
  path: string,
  policy: { readonly denyRead: readonly string[]; readonly allowRead: readonly string[] },
): Promise<string> {
  const inside = (p: string, r: string): boolean => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep)
  // A policy path is lexical and may itself sit behind a symlink (macOS `/var`): compare both spellings.
  const spellings = (entry: string): Promise<string[]> => {
    const prefix = staticPrefix(entry)
    return realpath(prefix)
      .catch(() => prefix)
      .then((real) => (real === prefix ? [prefix] : [prefix, real]))
  }
  const all = (entries: readonly string[]): Promise<string[]> =>
    Promise.all(entries.map(spellings)).then((lists) => lists.flat())
  return realpath(path)
    .then((real) =>
      Promise.all([all(policy.allowRead), all(policy.denyRead)]).then(([allowed, denied]) => {
        if (!allowed.some((r) => inside(real, r)) && denied.some((r) => inside(real, r))) {
          throw new Error(`the global ignore file ${path} resolves to ${real}, which the sandbox's read policy denies`)
        }
        return readFile(real, 'utf8')
      }),
    )
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return ''
      throw err
    })
}

/** `Sandbox.wrap`, closed over the pass's project, mirror and the decision's additions. */
export const makeRunSandbox = (
  service: SandboxApi,
  pass: { readonly project: string; readonly mirror: string; readonly additions: ProjectAdditions },
): RunSandbox => ({
  wrap: (command, worktree, env) =>
    Effect.flatMap(commandExclude(pass, worktree, env), ({ config, gitdir }) =>
      service.wrap({
        project: pass.project,
        worktree,
        mirror: pass.mirror,
        command,
        // srt's stand-ins are excluded for this command alone, never in the mirror's shared `info/exclude`.
        env: excludeEnv(config, gitdir, env),
        project_additions: pass.additions,
      }),
    ),
})
