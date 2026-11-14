import { Sandbox, SandboxUnavailable, type SandboxApi } from '@lingtai/sandbox'
import { Context, Effect, Layer, Scope } from 'effect'

/**
 * The one `Sandbox` service of this process (#1150), built on first ask and never closed.
 *
 * srt keeps one instance per process, and `makeSandbox` resets it when its scope closes, so a service built per
 * run would reset srt under every other live run (0122). A memo map and a scope of the module's own make the
 * build happen once however many passes ask at the same time; the process's exit is the only close, and srt
 * removes its Linux stand-ins then. srt is imported here and not before, so a process whose recipes have no
 * `sandbox:` block never loads it.
 *
 * The only place outside `@lingtai/sandbox` that names `/live` — and it is the conductor's, never `packages/agent`'s,
 * `packages/actions`' or the board's.
 */
const memo = Layer.makeMemoMapUnsafe()
const scope = Scope.makeUnsafe()

export const processSandbox: Effect.Effect<SandboxApi, SandboxUnavailable> = Effect.tryPromise({
  try: () => import('@lingtai/sandbox/live'),
  catch: () => new SandboxUnavailable({ reason: 'the sandbox runtime could not be loaded', sentences: [] }),
}).pipe(
  Effect.flatMap((live) => Layer.buildWithMemoMap(live.SandboxLive, memo, scope)),
  Effect.map((context) => Context.get(context, Sandbox)),
)
