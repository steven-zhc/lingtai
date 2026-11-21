import type { Report } from '@lingtai/conductor/report'

import { handledRow } from './handled'

/** The Waiting column's empty card (#1286), reduced from `report().handled`. */
export interface HandledToday {
  solved: number
  needed: number
  /** Whole percent solved without the person; 100 when nothing needed them. */
  percent: number
  /** At most four kinds that happened today, most first. */
  kinds: { kind: string; count: number }[]
  more: { kinds: number; problems: number; hint: string } | null
  /** One group per kind, in the page's order, `count` marks each: solved ones first, then the ones that needed the person. */
  marks: { kind: string; count: number; you: boolean }[]
}

const SHOWN = 4

/** Null when no problem was raised today — the column then says what it always said. */
export function handledToday(handled: Report['handled']): HandledToday | null {
  const solved = handled.kinds.reduce((n, k) => n + k.system, 0)
  const needed = handled.kinds.reduce((n, k) => n + k.you, 0)
  if (solved + needed === 0) return null
  // `kinds` arrives in PROBLEM_KINDS order and Array#sort is stable, so ties keep it.
  const happened = handled.kinds
    .filter((k) => k.system > 0)
    .map((k) => ({ kind: k.kind, count: k.system }))
    .sort((a, b) => b.count - a.count)
  const rest = happened.slice(SHOWN)
  return {
    solved,
    needed,
    percent: Math.round((100 * solved) / (solved + needed)),
    kinds: happened.slice(0, SHOWN),
    more:
      rest.length === 0
        ? null
        : {
            kinds: rest.length,
            problems: rest.reduce((n, k) => n + k.count, 0),
            hint: rest
              .map((k) => {
                const r = handledRow(k.kind)
                return r.did === undefined ? r.wrong : `${r.wrong} → ${r.did}`
              })
              .join(' · '),
          },
    marks: [
      ...handled.kinds.filter((k) => k.system > 0).map((k) => ({ kind: k.kind, count: k.system, you: false })),
      ...handled.kinds.filter((k) => k.you > 0).map((k) => ({ kind: k.kind, count: k.you, you: true })),
    ],
  }
}

/**
 * `handledToday`, but only for a read that was made and is current: a failed or
 * lagging `ticket_report` is null — never a zero (#1286, #1345).
 */
export function handledIfCurrent(
  currency: { error?: unknown; lag: number | null },
  handled: Report['handled'],
): HandledToday | null {
  if (currency.error !== undefined || currency.lag !== 0) return null
  return handledToday(handled)
}
