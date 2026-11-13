import { Sandbox, SandboxUnavailable, type SandboxApi } from '@lingtai/sandbox'
import { Context, Effect, Layer, Scope, Semaphore } from 'effect'

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

const lazy: SandboxApi = {
  hostCanSandbox: load.pipe(Effect.flatMap((api) => api.hostCanSandbox)),
  wrap: (input) => load.pipe(Effect.flatMap((api) => api.wrap(input))),
}

/** Provided beside `tracedPorts` at every site that runs a pass. */
export const sandboxService: Layer.Layer<Sandbox> = Layer.succeed(Sandbox, lazy)
