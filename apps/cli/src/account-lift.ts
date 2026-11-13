/**
 * `lingtai account lift <runtime>` (#1008, 0126 §7): a person says a runtime's
 * usage limit is over. An Effect over a store and a `log`, so the suite drives
 * it against a memory store and reads the appends back.
 */
import { liftAccountLimit } from '@lingtai/conductor'
import { RuntimeId } from '@lingtai/domain'
import { type EventStore, eventStore } from '@lingtai/event-store'
import { Effect } from 'effect'

import type { Outcome } from './project-pause.ts'

export interface AccountLiftOptions {
  /** The suite passes a memory store and a collector; nothing else should set them. */
  store?: EventStore
  log?: (line: string) => void
}

const RUNTIMES = RuntimeId.options.join(', ')

export const liftAccount = (runtime: string | undefined, by: string, options: AccountLiftOptions = {}) =>
  Effect.gen(function* () {
    const log = options.log ?? console.log
    const parsed = RuntimeId.safeParse(runtime)
    if (!parsed.success) {
      log(
        runtime === undefined
          ? `no runtime named — runtimes: ${RUNTIMES}`
          : `unknown runtime "${runtime}" — runtimes: ${RUNTIMES}`,
      )
      return 2 as Outcome
    }
    const answer = yield* liftAccountLimit(options.store ?? eventStore, parsed.data, by).pipe(
      Effect.mapError((e) => new Error(`could not lift ${parsed.data}'s usage limit — ${e.message}`)),
    )
    if (answer.kind === 'not-limited') {
      log(`${parsed.data} is not at its usage limit — nothing to lift`)
    } else {
      log(`${parsed.data}'s usage limit lifted by ${by} — projects that use it take work again at the next look`)
    }
    return 0 as Outcome
  })
