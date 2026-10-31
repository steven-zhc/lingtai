import { PortsLive } from '@lingtai/conductor'
import type { Tracing } from '@lingtai/conductor/telemetry'
import { Layer } from 'effect'

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
// Promise chains and not `async`: 0101 §6's ratchet (#792) counts the keyword.

export function startTracing(from: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (started) return Promise.resolve()
  started = true
  return import('@lingtai/conductor/telemetry')
    .then((telemetry) => telemetry.installTracing(from))
    .then(
      (tracing) => {
        installed = tracing
      },
      // A trace is never worth a pass: an SDK that would not load installs nothing.
      () => {
        installed = undefined
      },
    )
}

/** `PortsLive`, and the tracer where one was installed — read when the layer is built. */
export const tracedPorts: typeof PortsLive = Layer.suspend(() =>
  installed === undefined ? PortsLive : Layer.merge(PortsLive, installed.layer),
) as typeof PortsLive

/** Bounded; a flush that times out is dropped and never holds an exit. */
export function flushTracing(): Promise<void> {
  return installed === undefined ? Promise.resolve() : installed.flush().then(() => installed!.shutdown())
}
