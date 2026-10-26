/**
 * `lingtai pause <why>` — the append, and what it says about both conductors.
 *
 * Its own module so the suite can run it: the sentence about `lingtai run` is
 * the one `#159` got wrong, and `unit/run-pause.test.ts` holds what this prints
 * against what a paused `run` does.
 */
import { pauseConductor } from '@lingtai/daemon/control'
import { paint } from '@lingtai/env/colour'
import type { EventStore } from '@lingtai/event-store'

import { RUN_UNDER_A_PAUSE } from './run.ts'
import { renderVerdict } from './verdict.ts'

export async function pauseCommand(
  by: string,
  reason: string,
  /** The suite passes a memory store and a collector; nothing else should set them. */
  options: { store?: EventStore; log?: (line: string) => void } = {},
): Promise<void> {
  const log = options.log ?? console.log
  await pauseConductor(by, reason, options.store)
  // What is true about the other conductor, and the sentence `run` itself
  // prints when it refuses (#166). `#159` printed one here that was not.
  const detail = `${paint.held(`paused by ${by} — ${reason}`)}\n${RUN_UNDER_A_PAUSE}.`
  for (const line of renderVerdict('paused', { outcome: 'accepted', detail })) log(line)
}
