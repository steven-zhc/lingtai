/**
 * What this machine is, read once from the process. srt-free, so a recipe's resolver can read the facts it
 * checks a project's paths against without loading srt's module graph (`live.ts` is the only file that does).
 */
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter } from 'node:path'

import { stateDir } from '@lingtai/env'
import { Effect } from 'effect'

import type { HostFacts } from './policy.ts'
import { SandboxUnavailable } from './port.ts'

const unavailable = (reason: string) => new SandboxUnavailable({ reason, sentences: [] })

/** Reads `process.env`, the temp directory and its real path, once. Unset or relative `HOME`/`TMPDIR` is refused by name. */
export const readHost: Effect.Effect<HostFacts, SandboxUnavailable> = Effect.gen(function* () {
  const env = process.env
  const home = env['HOME']
  if (!home || !home.startsWith('/')) return yield* unavailable('HOME is unset or not absolute')
  const tmp = env['TMPDIR'] ?? tmpdir()
  if (!tmp.startsWith('/')) return yield* unavailable('TMPDIR is not absolute')
  // `stateDir(env)` only after HOME passed: bare `stateDir()` falls back to `os.homedir()`.
  const state = stateDir(env)
  if (!state.startsWith('/')) return yield* unavailable('the state directory is not absolute')
  const tmpdirReal = yield* Effect.tryPromise({ try: () => realpath(tmp), catch: (e: unknown) => e }).pipe(
    Effect.orElseSucceed(() => tmp),
  )
  return {
    platform: process.platform,
    home,
    tmpdir: tmp,
    tmpdirReal: tmpdirReal === tmp ? undefined : tmpdirReal,
    stateDir: state,
    pnpmHome: env['PNPM_HOME'],
    pathRaw: env['PATH'] ?? '',
    path: (env['PATH'] ?? '').split(delimiter).filter((p) => p.startsWith('/')),
  }
})
