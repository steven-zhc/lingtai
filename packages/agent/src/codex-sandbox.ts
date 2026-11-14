import { mkdir, rm, stat } from 'node:fs/promises'
import { posix } from 'node:path'

import type { CallerAdditions } from '@lingtai/sandbox'
import { Effect, type Scope } from 'effect'

import { collidingDenies, SandboxRunRefused, type RunSandbox, type SandboxedLaunch } from './claude-sandbox.ts'
import type { UserPermissions } from './codex.ts'

/**
 * A sandboxed Codex run (#1151, 0127 §1, §15 and §16): Codex's own sandbox is off (`--sandbox danger-full-access`)
 * and srt is the boundary. The Claude Code half is `claude-sandbox.ts`; the decision, the `wrap` and the refusal are shared.
 */

/** What the Codex home holds that the operator's own interactive Codex reads as configuration: write-denied always. */
export const CODEX_CONFIG_PATHS = ['config.toml', 'AGENTS.md', 'rules'] as const

/**
 * A `UserPermissions` verdict as absolute deny paths, for srt (0127 §16).
 *
 * `~` expands against `at.home`, a relative key resolves against `at.cwd`, a globbed key is anchored the same way
 * and goes to srt as written (srt reads globs). `unreadable` refuses, because its denies would be silently missing;
 * a `:special` key refuses, since srt has nothing to match it with. `none` and `kept` carry nothing.
 */
export const codexProfileDenies = (
  verdict: UserPermissions,
  at: { readonly home: string | undefined; readonly cwd: string },
): { readonly ok: true; readonly paths: string[] } | { readonly ok: false; readonly refusal: SandboxRunRefused } => {
  if (verdict.kind === 'none' || verdict.kind === 'kept') return { ok: true, paths: [] }
  if (verdict.kind === 'unreadable') {
    return {
      ok: false,
      refusal: new SandboxRunRefused(
        `the user's Codex permission profile could not be read, so its denies would be missing: ${verdict.why}`,
      ),
    }
  }
  const paths: string[] = []
  for (const key of verdict.paths) {
    if (key.startsWith(':')) {
      return {
        ok: false,
        refusal: new SandboxRunRefused(
          `the user's Codex permission profile denies ${key}, which the sandbox has no path for`,
        ),
      }
    }
    if (key === '~' || key.startsWith('~/')) {
      if (at.home === undefined || at.home === '') {
        return {
          ok: false,
          refusal: new SandboxRunRefused(
            `the user's Codex permission profile denies ${key}, and the run has no HOME to expand it against`,
          ),
        }
      }
      const home = posix.resolve(at.cwd, at.home)
      paths.push(key === '~' ? home : posix.join(home, key.slice(2)))
    } else if (posix.isAbsolute(key)) {
      paths.push(key)
    } else {
      paths.push(posix.resolve(at.cwd, key))
    }
  }
  return { ok: true, paths }
}

export interface CodexLaunchRun {
  /** `[binary, ...args]`, the args built with `--sandbox danger-full-access`. */
  readonly argv: readonly string[]
  /** The env handed to `wrap`: the filtered one, with the process marker already in it. */
  readonly env: Record<string, string>
  readonly cwd: string
  /** The Codex home whose `config.toml` was read: `$CODEX_HOME`, else `~/.codex`. */
  readonly codexHome: string | undefined
  readonly permissions: UserPermissions
  readonly outputSchemaPath?: string | undefined
}

/** Makes the run's own directory when it is the worktree and absent, and removes only what it made. */
const ensureRunDir = (path: string): Effect.Effect<void, SandboxRunRefused, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const exists = yield* Effect.tryPromise({ try: () => stat(path), catch: () => undefined }).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      )
      if (exists) return false
      yield* Effect.tryPromise({
        try: () => mkdir(path, { recursive: true }),
        catch: (e) => new SandboxRunRefused(`${path} could not be made: ${e instanceof Error ? e.message : String(e)}`),
      })
      return true
    }),
    (made) => (made ? Effect.promise(() => rm(path, { recursive: true, force: true })) : Effect.void),
  ).pipe(Effect.asVoid)

/** The prepared run: refusals decided, argv wrapped. Everything it makes lives in the caller's scope. */
export const codexSandboxedLaunch = (
  sandbox: RunSandbox,
  run: CodexLaunchRun,
  hostHome: string | undefined,
): Effect.Effect<SandboxedLaunch, SandboxRunRefused, Scope.Scope> =>
  Effect.gen(function* () {
    const decision = sandbox.decision
    if (decision.kind === 'refused') {
      return yield* Effect.fail(new SandboxRunRefused(`sandbox required and unavailable on this host: ${decision.why}`))
    }
    const codexHome = run.codexHome
    if (codexHome === undefined) {
      return yield* Effect.fail(
        new SandboxRunRefused('the run has neither CODEX_HOME nor HOME, so its Codex home cannot be named'),
      )
    }

    const profile = codexProfileDenies(run.permissions, { home: hostHome, cwd: run.cwd })
    if (!profile.ok) return yield* Effect.fail(profile.refusal)

    const needed = [
      sandbox.worktree,
      sandbox.mirror,
      sandbox.cache,
      codexHome,
      ...sandbox.read,
      ...(run.outputSchemaPath === undefined ? [] : [run.outputSchemaPath]),
    ]
    const colliding = collidingDenies(profile.paths, needed)
    if (colliding.length > 0) {
      return yield* Effect.fail(
        new SandboxRunRefused(
          `the user's Codex permission profile denies ${colliding[0]}, which covers a path the run needs, and would be voided by it`,
        ),
      )
    }

    if (sandbox.worktree === sandbox.runDir) yield* ensureRunDir(sandbox.runDir)

    const callerAdditions: CallerAdditions = {
      write: [codexHome],
      // Read and not writable: the answer schema lives in the temp roots, which are writable inside srt.
      read: [...sandbox.read, ...(run.outputSchemaPath === undefined ? [] : [run.outputSchemaPath])],
      // On `denyWrite` only: Codex has to read its own `config.toml`. A path that does not exist is still denied.
      denyWrite: CODEX_CONFIG_PATHS.map((name) => posix.join(codexHome, name)),
      deny: profile.paths,
    }
    const wrapped = yield* sandbox
      .wrap({
        project: sandbox.project,
        worktree: sandbox.worktree,
        mirror: sandbox.mirror,
        command: run.argv,
        env: run.env,
        project_additions: decision.project_additions,
        caller_additions: callerAdditions,
      })
      .pipe(Effect.mapError((e) => new SandboxRunRefused(e.message)))

    const [command, ...args] = wrapped.argv
    if (command === undefined) {
      return yield* Effect.fail(new SandboxRunRefused('the sandbox returned an empty command'))
    }
    return { command, args, env: { ...wrapped.env } }
  })
