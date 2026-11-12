/**
 * `lingtai ceiling raise <usd>` (#1003, 0126 §7): a person raises today's
 * ceiling to a higher figure.
 *
 * An Effect over ports, so the suite drives it with a memory store and stubbed
 * spend. Today's spend is read first and by the same trust checks
 * the guard's ceiling port makes: a spend that cannot be read, or a `spend` projection
 * that is stalled or rebuilding, is a refusal by name and never a raise.
 */
import { raiseDayCeiling } from '@lingtai/daemon'
import { RAISE_REFUSALS } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store'
import { Effect } from 'effect'

import { readDaySpendTrusted, type TrustedDaySpendPorts } from './day-ceiling.ts'

export interface CeilingRaiseOptions extends TrustedDaySpendPorts {
  toUsd: number
  by: string
  store?: EventStore
  log: (line: string) => void
}

const usd = (n: number): string => `$${n.toFixed(2)}`

/** Exit code: 0 raised, 1 refused or unreadable. */
export const ceilingRaise = (o: CeilingRaiseOptions): Effect.Effect<0 | 1> =>
  Effect.gen(function* () {
    const spend = yield* readDaySpendTrusted(o).pipe(
      Effect.catch((err: Error) => Effect.succeed({ refused: `could not read today's spend: ${err.message}` })),
    )
    if ('refused' in spend) {
      o.log(spend.refused)
      return 1 as const
    }
    const spentCents = spend.reportedCents + spend.estimatedCents
    const result = yield* raiseDayCeiling({
      toUsd: o.toUsd,
      by: o.by,
      spentCents,
      store: o.store,
      now: (o.now ?? (() => new Date()))(),
    }).pipe(
      Effect.catch((err: unknown) => Effect.succeed({ failed: err instanceof Error ? err.message : String(err) })),
    )
    if ('failed' in result) {
      o.log(`could not raise today's ceiling: ${result.failed}`)
      return 1 as const
    }
    if (!result.raised) {
      o.log(RAISE_REFUSALS[result.refused])
      return 1 as const
    }
    const configured = spend.configuredUsd
    o.log(
      `today's ceiling raised to ${usd(o.toUsd)} by ${o.by} — until midnight; ` +
        (configured === undefined
          ? 'the configuration sets no figure'
          : `the configuration still says ${usd(configured)}`),
    )
    return 0 as const
  })

/** `<usd>` as a positive finite number of dollars, or undefined. */
export function parseUsd(arg: string | undefined): number | undefined {
  if (arg === undefined || arg.trim() === '') return undefined
  const n = Number(arg)
  return Number.isFinite(n) && n > 0 ? n : undefined
}
