import { provideHostAnswer } from '@lingtai/conductor'
import { Sandbox, SandboxUnavailable, type SandboxApi } from '@lingtai/sandbox'
import { Context, Effect, Exit, Layer, Scope, Semaphore } from 'effect'

/**
 * The `Sandbox` service for the two hosts that conduct a pass, `lingtai run` and the daemon (#1152).
 *
 * **Built once per process, never per pass.** `SandboxLayer`'s finalizer resets srt, and srt has one instance
 * per process (`packages/sandbox/src/live.ts`): a layer provided per pass would reset it underneath any other
 * pass still wrapping (0122). So the layer is built into a scope this module holds until the process exits.
 *
 * **And built on first use.** `@lingtai/sandbox/live` is the only file that loads srt, and it is imported here,
 * behind the first `hostCanSandbox` or `wrap`, so a process whose projects have no `sandbox:` block (and
 * `lingtai status` and the like) never loads it. Only `apps/cli/src` may import it: the board imports the
 * actions barrel, and `SandboxLive` provided anywhere it can reach would reach the board.
 *
 * A build that fails fails the call that asked, as `SandboxUnavailable`: a project that requires the sandbox
 * is held by the pass's refusal, and one that does not is *degraded* with the sentence. Never unwrapped silently.
 */
let built: SandboxApi | undefined
const building = Semaphore.makeUnsafe(1)
const held = Scope.makeUnsafe()

const load: Effect.Effect<SandboxApi, SandboxUnavailable> = Effect.suspend(() => {
  if (built !== undefined) return Effect.succeed(built)
  return building.withPermits(1)(
    Effect.suspend(() => {
      if (built !== undefined) return Effect.succeed(built)
      return Effect.tryPromise(() => import('@lingtai/sandbox/live')).pipe(
        Effect.flatMap((live) => Layer.buildWithScope(live.SandboxLive, held)),
        Effect.map((context) => Context.get(context, Sandbox)),
        Effect.tap((api) =>
          Effect.sync(() => {
            built = api
          }),
        ),
        Effect.mapError(
          () => new SandboxUnavailable({ reason: 'the sandbox runtime could not be loaded', sentences: [] }),
        ),
      )
    }),
  )
})

/**
 * **srt installs its own `SIGINT`/`SIGTERM` handlers** when it initialises (`sandbox-manager.js`,
 * `process.once('SIGINT', cleanupHandler)`), and they reset its proxies and bridges at once: a first Ctrl+C
 * during a drain would break the command the drain is waiting for. The lifecycle is Lingtai's — the drain
 * finishes the pass, `releaseSandbox` resets after it — so the listeners srt added during its first
 * initialisation are taken off again. (`exit` stays: it is the backstop for a process that dies anyway.)
 */
/** The name srt gives its handler (`const cleanupHandler = …`, `sandbox-manager.js`). */
const SRT_HANDLER = 'cleanupHandler'
const SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
const signals = Semaphore.makeUnsafe(1)
let stripped = false

const withoutSrtSignals = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    if (stripped) return effect
    return signals.withPermits(1)(
      Effect.suspend(() => {
        if (stripped) return effect
        const before = SIGNALS.map((s) => new Set<unknown>(process.listeners(s)))
        return Effect.ensuring(
          effect,
          Effect.sync(() => {
            SIGNALS.forEach((signal, i) => {
              for (const listener of process.listeners(signal)) {
                // Ownership by name, not by timing: a daemon handler registered while the wrap was pending is not srt's.
                if (!before[i]!.has(listener) && (listener as { name?: string }).name === SRT_HANDLER) {
                  process.removeListener(signal, listener as NodeJS.SignalsListener)
                  stripped = true
                }
              }
            })
          }),
        )
      }),
    )
  })

const lazy: SandboxApi = {
  hostCanSandbox: load.pipe(Effect.flatMap((api) => withoutSrtSignals(api.hostCanSandbox))),
  wrap: (input) => load.pipe(Effect.flatMap((api) => withoutSrtSignals(api.wrap(input)))),
}

/**
 * Closes the process-wide scope, which resets srt (its proxies, and on Linux the socat bridges that would keep
 * the event loop alive). Called by the two hosts where they end, after the drain, beside `flushTracing`. A
 * process that never built it has nothing to close.
 */
export const releaseSandbox: Effect.Effect<void> = Effect.suspend(() => {
  if (built === undefined) return Effect.void
  built = undefined
  return Scope.close(held, Exit.void)
})

// The host answer the resolver and the pass fall back to where no service is provided: srt is loaded on the
// first ask only, and only from here (the board imports the conductor and must never reach `live`).
provideHostAnswer(
  Effect.tryPromise({
    try: () => import('@lingtai/sandbox/live'),
    catch: () => new SandboxUnavailable({ reason: 'the sandbox runtime could not be loaded', sentences: [] }),
  }).pipe(Effect.flatMap((live) => live.hostCanSandboxHere)),
)

/** Provided beside `tracedPorts` at every site that runs a pass. */
export const sandboxService: Layer.Layer<Sandbox> = Layer.succeed(Sandbox, lazy)
