import { PortsLive } from '@lingtai/conductor'
import type { Tracing } from '@lingtai/conductor/telemetry'
import { Effect, Layer } from 'effect'

/**
 * Tracing for the two hosts that conduct a pass, `lingtai run` and the daemon
 * (#791). Installed once per process at the command's entry — the provider lives
 * as long as the process — and the layer every host provides beside `PortsLive`
 * only points at it.
 *
 * `@lingtai/conductor/telemetry` is imported here, behind the call, and the SDK
 * and the exporter are imported inside it only once `telemetry.otlp_endpoint` is
 * set: with the key unset nothing is loaded and nothing leaves the machine.
 */
let installed: Tracing | undefined
let started = false

/** Installs once per process and never fails: a trace is never worth a pass. */
export const startTracing = (from: NodeJS.ProcessEnv = process.env): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (started) return Effect.void
    started = true
    return Effect.tryPromise(() => import('@lingtai/conductor/telemetry')).pipe(
      Effect.flatMap((telemetry) => telemetry.installTracingEffect(from)),
      Effect.map((tracing) => {
        installed = tracing
      }),
      // An SDK that would not load installs nothing.
      Effect.catchCause(() =>
        Effect.sync(() => {
          installed = undefined
        }),
      ),
    )
  })

/** `PortsLive`, and the tracer where one was installed — read when the layer is built. */
export const tracedPorts: typeof PortsLive = Layer.suspend(() =>
  installed === undefined ? PortsLive : Layer.merge(PortsLive, installed.layer),
) as typeof PortsLive

/** Bounded; a flush that times out is dropped and never holds an exit. */
export const flushTracing: Effect.Effect<void> = Effect.suspend(() => {
  const tracing = installed
  if (tracing === undefined) return Effect.void
  return Effect.promise(() => tracing.flush()).pipe(Effect.andThen(Effect.promise(() => tracing.shutdown())))
})
