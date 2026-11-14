/**
 * The only file that imports `@anthropic-ai/sandbox-runtime`, and not re-exported from `.`: a host's edge
 * composes `SandboxLive` and a unit test never loads srt's module graph.
 *
 * srt keeps one instance per process, so this is a module-level object's methods behind Effects.
 * No `async` function and no `Effect.run*` here: the ratchet holds this package at 0 and 0.
 */
import { mkdir } from 'node:fs/promises'

import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { Duration, Effect, Layer } from 'effect'

import { readHost } from './host.ts'
import { Host, SandboxFs, SandboxUnavailable, Srt, type SrtPort } from './port.ts'
import { HOST_CHECK_TTL, SandboxLayer, checkHost } from './sandbox.ts'

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
  violationsFor: (id) =>
    Effect.try({
      try: () =>
        SandboxManager.getSandboxViolationStore()
          .getViolationsForCommand(id)
          .map((v) => ({ line: v.line, timestamp: v.timestamp })),
      catch: raw,
    }),
  violationTotal: Effect.try({ try: () => SandboxManager.getSandboxViolationStore().getTotalCount(), catch: raw }),
  cleanupAfterCommand: Effect.try({ try: () => SandboxManager.cleanupAfterCommand(), catch: raw }),
  reset: Effect.tryPromise({ try: () => SandboxManager.reset(), catch: raw }),
}

export { readHost }

export const HostLive = Layer.effect(Host, readHost)

export const SrtLive = Layer.succeed(Srt, srtPort)

export const SandboxFsLive = Layer.succeed(SandboxFs, {
  ensureDir: (path: string) =>
    Effect.tryPromise({ try: () => mkdir(path, { recursive: true }), catch: raw }).pipe(Effect.asVoid),
})

/** Everything, from the process outward. S4–S6 provide this at their host's edge. */
export const SandboxLive = SandboxLayer.pipe(Layer.provide(Layer.mergeAll(SrtLive, HostLive, SandboxFsLive)))

/**
 * Whether this process's host can sandbox, kept for `HOST_CHECK_TTL` the way `signedInProbe` keeps sign-in, and
 * **without building `SandboxLayer`**: its scope resets srt's one instance when it closes, which a resolver
 * asking per recipe read must never do under a run that is wrapping. Not `Effect.run*`: the ratchet holds 0.
 */
let kept: { readonly at: number; readonly failure: SandboxUnavailable | undefined } | undefined

export const hostCanSandboxHere: Effect.Effect<void, SandboxUnavailable> = Effect.gen(function* () {
  const now = yield* Effect.sync(() => Date.now())
  if (kept !== undefined && now - kept.at < Duration.toMillis(HOST_CHECK_TTL)) {
    return kept.failure === undefined ? undefined : yield* kept.failure
  }
  const failure = yield* readHost.pipe(
    Effect.flatMap((host) => checkHost(srtPort, host)),
    Effect.as(undefined),
    Effect.catchTag('SandboxUnavailable', (e) => Effect.succeed(e)),
  )
  kept = { at: now, failure }
  if (failure !== undefined) return yield* failure
})
