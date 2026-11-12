/**
 * What the footer on every page that reads the log needs (#906): today's spend
 * and the projections' lag, as JSON. Server only; `app/footer.tsx` and
 * `app/footer-fetched.tsx` take its types and nothing else.
 *
 * `ProjectionLag` carries bigints and a Date, which `Response.json` cannot
 * send, so the wire shape is `FooterLag`.
 */
import { projectionLag } from '@lingtai/projector'
import type { ProjectionLag } from '@lingtai/projector'

import { type DaySpendReading, readDayReading } from './day-spend.ts'
import { theHome } from './home.ts'
import { readControlOnce } from './locks.ts'
import { measure, timed } from './timing.ts'

/** The four projections. A copy of `PROJECTION_NAMES` in `apps/cli/src/commands.ts`, held equal by a test. */
export const FOOTER_PROJECTIONS = ['task_view', 'finding_backlog', 'spend', 'ticket_report'] as const

export interface FooterLag {
  name: string
  /** Events behind; null when the projection has no checkpoint row (never built). */
  lag: number | null
}

export interface FooterReading {
  day: DaySpendReading
  /** null when the lag could not be read. */
  lags: FooterLag[] | null
  /** The Lingtai home this board reads (#947), drawn at the footer's right end. */
  home: { path: string; shown: string }
}

/** Every projection by name, so one that was never built is said rather than left out. */
export function footerLags(rows: readonly ProjectionLag[]): FooterLag[] {
  return FOOTER_PROJECTIONS.map((name) => {
    const row = rows.find((r) => r.name === name)
    return { name, lag: row === undefined ? null : Number(row.lag) }
  })
}

/** Never throws. */
export async function loadFooter(): Promise<FooterReading> {
  const [[day, lags]] = await measure(
    () =>
      Promise.all([
        timed('footer.day', async () =>
          readDayReading(
            undefined,
            await readControlOnce().then(
              (state) => state,
              (err: unknown) => ({ unread: err instanceof Error ? err.message : String(err) }),
            ),
          ),
        ),
        timed('footer.lags', () => projectionLag()).then(footerLags, () => null),
      ]),
    { label: '/api/footer' },
  )
  return { day, lags, home: theHome() }
}
