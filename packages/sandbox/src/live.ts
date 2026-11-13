/**
 * The only file that imports `@anthropic-ai/sandbox-runtime`, and not re-exported from `.`: a host's edge
 * composes `SandboxLive` and a unit test never loads srt's module graph.
 *
 * srt keeps one instance per process, so this is a module-level object's methods behind Effects.
 * No `async` function and no `Effect.run*` here: the ratchet holds this package at 0 and 0.
 */
import { mkdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter } from 'node:path'

import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { stateDir } from '@lingtai/env'
import { Effect, Layer } from 'effect'

import type { HostFacts } from './policy.ts'
import { Host, SandboxFs, SandboxUnavailable, Srt, type SrtPort } from './port.ts'
import { SandboxLayer } from './sandbox.ts'

type Manager = typeof SandboxManager

/** Keeps srt's own error: Effect's default wrapper would replace its message with a generic one. */
const raw = (e: unknown): unknown => e

export const srtPort: SrtPort = {
  initialize: (config) =>
    Effect.tryPromise({
      try: () => SandboxManager.initialize(config as Parameters<Manager['initialize']>[0]),
      catch: raw,
    }),
  isSupportedPlatform: Effect.try({ try: () => SandboxManager.isSupportedPlatform(), catch: raw }),
  checkDependencies: Effect.try({ try: () => SandboxManager.checkDependencies(), catch: raw }),
  registerCommandNetworkLists: (id, lists) =>
    Effect.try({ try: () => SandboxManager.registerCommandNetworkLists(id, lists), catch: raw }),
  unregisterCommandNetworkLists: (id) =>
    Effect.try({ try: () => SandboxManager.unregisterCommandNetworkLists(id), catch: raw }),
  wrapWithSandboxArgv: (command, customConfig, options) =>
    Effect.tryPromise({
      try: () =>
        SandboxManager.wrapWithSandboxArgv(
          command,
          undefined,
          customConfig as Parameters<Manager['wrapWithSandboxArgv']>[2],
          undefined,
          undefined,
          options,
        ),
      catch: raw,
      // Only `argv` leaves: the `env` srt returns is `process.env`.
    }).pipe(Effect.map(({ argv }) => ({ argv }))),
  cleanupAfterCommand: Effect.try({ try: () => SandboxManager.cleanupAfterCommand(), catch: raw }),
  reset: Effect.tryPromise({ try: () => SandboxManager.reset(), catch: raw }),
}

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
  const tmpdirReal = yield* Effect.tryPromise({ try: () => realpath(tmp), catch: raw }).pipe(
    Effect.orElseSucceed(() => tmp),
  )
  return {
    platform: process.platform,
    home,
    tmpdir: tmp,
    tmpdirReal: tmpdirReal === tmp ? undefined : tmpdirReal,
    stateDir: state,
    pnpmHome: env['PNPM_HOME'],
    path: (env['PATH'] ?? '').split(delimiter).filter((p) => p.startsWith('/')),
  }
})

export const HostLive = Layer.effect(Host, readHost)

export const SrtLive = Layer.succeed(Srt, srtPort)

export const SandboxFsLive = Layer.succeed(SandboxFs, {
  ensureDir: (path: string) =>
    Effect.tryPromise({ try: () => mkdir(path, { recursive: true }), catch: raw }).pipe(Effect.asVoid),
})

/** Everything, from the process outward. S4–S6 provide this at their host's edge. */
export const SandboxLive = SandboxLayer.pipe(Layer.provide(Layer.mergeAll(SrtLive, HostLive, SandboxFsLive)))
