import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runnableEnv } from '@lingtai/agent-env'
import { stateDir } from '@lingtai/env'
import { gitEffect, mirrorPathFor } from '@lingtai/repo'
import { Effect } from 'effect'

/**
 * The environment a triage run gets: the filtered one, a private `HOME`, and
 * the user's real `CODEX_HOME`.
 *
 * **`CODEX_HOME` is not private on purpose, and it is not a daemon credential.**
 * It holds the user's own Codex CLI login. Codex rotates its refresh token in
 * place, so a copy discarded at cleanup would leave `~/.codex/auth.json` holding
 * a token the server has already spent, and every Codex `review` step would
 * lose its sign-in with it. `codex.ts`'s pass runtime keeps the user's
 * `CODEX_HOME` for the same reason: *a per-run `CODEX_HOME` holding only our
 * hooks is a run that is not signed in*. Nothing copies `auth.json`. No
 * `LINGTAI_*` value (daemon config, GitHub token, database URL) survives
 * `runnableEnv`, and the real home is read from `processEnv`, never from here.
 */
export function triageCheckoutEnv(
  processEnv: Readonly<Record<string, string | undefined>>,
  privateHome: string,
): Record<string, string> {
  const realHome = processEnv['HOME']
  const codexHome = processEnv['CODEX_HOME'] ?? (realHome ? join(realHome, '.codex') : join(privateHome, '.codex'))
  return { ...runnableEnv({}), HOME: privateHome, CODEX_HOME: codexHome, GIT_CONFIG_NOSYSTEM: '1' }
}

export interface Checkout {
  cwd: string
  settingsPath: string
  env: Record<string, string>
  /** Removes the private directory. Not run by the port itself: the caller knows whether a tool may remain. */
  cleanup: Effect.Effect<void, Error>
}

const io = <A>(f: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({ try: () => f(), catch: (e) => (e instanceof Error ? e : new Error(String(e))) })

/** A private copy: Codex may commit here without writing to the managed mirror. */
export const prepareTriageCheckout = (
  project: string,
  sha: string,
  mirrorHome = stateDir(),
  signal?: AbortSignal,
): Effect.Effect<Checkout, Error> =>
  Effect.gen(function* () {
    if (!/^[0-9a-f]{40}$/.test(sha)) return yield* Effect.fail(new Error(`invalid triage commit SHA: ${sha}`))
    const root = yield* io(() => mkdtemp(join(tmpdir(), 'lingtai-triage-')))
    const cleanup = io(() => rm(root, { recursive: true, force: true }))
    // A failed preparation cleans up after itself, and says so if the cleanup failed too.
    return yield* Effect.gen(function* () {
      const cwd = join(root, 'checkout')
      const home = join(root, 'home')
      yield* io(() => mkdir(home, { recursive: true, mode: 0o700 }))
      const env = triageCheckoutEnv(process.env, home)
      yield* gitEffect(
        ['clone', '--no-hardlinks', '--dissociate', '--no-checkout', mirrorPathFor(project, mirrorHome), cwd],
        {
          env,
          signal,
        },
      )
      yield* gitEffect(['remote', 'remove', 'origin'], { cwd, env, signal })
      yield* gitEffect(['config', 'core.hooksPath', '/dev/null'], { cwd, env, signal })
      yield* gitEffect(['checkout', '--detach', sha], { cwd, env, signal })
      const actual = yield* gitEffect(['rev-parse', 'HEAD'], { cwd, env, signal })
      if (actual !== sha) return yield* Effect.fail(new Error(`triage checkout resolved ${actual}, expected ${sha}`))
      const settingsPath = join(root, 'settings.json')
      yield* io(() => writeFile(settingsPath, '{}\n', { mode: 0o600 }))
      return { cwd, settingsPath, env, cleanup } satisfies Checkout
    }).pipe(
      Effect.catch((error: Error) =>
        cleanup.pipe(
          Effect.matchEffect({
            onSuccess: () => Effect.fail(error),
            onFailure: (cleanupError) =>
              Effect.fail(
                new AggregateError([error, cleanupError], 'triage checkout preparation and cleanup failed') as Error,
              ),
          }),
        ),
      ),
    )
  })
