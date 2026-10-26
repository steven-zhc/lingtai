/**
 * `lingtai projection rebuild <name>`'s body, once a known projection is
 * resolved — pulled out of `lingtai.ts` so a `unit/` test can reach it
 * without importing that file, which calls `main()` on import (#435, the
 * same reason `addFlow` lives in `add.ts`).
 */
import { logPredatesHold } from '@lingtai/event-store'
import type { LogQueries } from '@lingtai/event-store/queries'
import {
  backlogProjection,
  spendProjection,
  taskViewProjection,
  type ProjectionLag,
  type ProjectionRunner,
} from '@lingtai/projector'

import { heading, symbol, table } from './output.ts'

/**
 * Every projection this system runs, named here in the open.
 *
 * A second one exists now (`finding_backlog`, `#137`), and a third (`spend`,
 * `#497`), and `projection rebuild` below says where it has to be added: here,
 * visibly, or it does not exist. It lives in this file and not `lingtai.ts`
 * because `cli.ts` needs it and cannot import a file that calls `main()` on
 * import; the daemon imports it from here.
 */
export const PROJECTIONS = [taskViewProjection, backlogProjection, spendProjection] as const

/** `projection lag`, laid out: a heading and a table, or the one line for a log with no checkpoint. */
export function renderProjectionLag(
  lags: readonly ProjectionLag[],
  options: { columns?: number | undefined } = {},
): string[] {
  if (lags.length === 0) return ['no projection has a checkpoint yet']
  return [
    heading('projections'),
    ...table(
      ['NAME', 'AT', 'BEHIND', 'UPDATED'],
      lags.map((l) => [l.name, `${l.lastSeq}/${l.headSeq}`, `${l.lag}`, l.updatedAt?.toISOString() ?? 'never']),
      options,
    ),
  ]
}

/** `--json`: the three sequence numbers are `bigint`s, so they are decimal strings (`JSON.stringify` throws on one). */
export function projectionLagJson(lags: readonly ProjectionLag[]): Record<string, unknown> {
  return {
    projections: lags.map((l) => ({
      name: l.name,
      lastSeq: String(l.lastSeq),
      headSeq: String(l.headSeq),
      lag: String(l.lag),
      updatedAt: l.updatedAt?.toISOString() ?? null,
    })),
  }
}

export interface RebuildProjectionOptions {
  name: string
  queries: Pick<LogQueries, 'rowsOfType' | 'typeCounts'>
  /** Builds the runner. A seam so a test can hand in a fake and assert `rebuild` was never called (#451). */
  runnerFor: () => ProjectionRunner
  log?: (line: string) => void
  error?: (line: string) => void
}

/**
 * The guard runs **before** `runnerFor` builds anything (#451): `rebuild`
 * drops the table and resets the checkpoint before it replays, and a refusal
 * partway through that leaves a person with no board rather than a stale one.
 */
export async function rebuildProjection(options: RebuildProjectionOptions): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line))
  const error = options.error ?? ((line: string) => console.error(line))

  const predates = await logPredatesHold(options.queries)
  if (predates) {
    error(`${symbol.fail()} ${predates.message}`)
    return 1
  }

  const runner = options.runnerFor()
  try {
    await runner.rebuild()
    const lag = await runner.lag()
    const behind = lag.lag !== 0n
    log(
      `${behind ? symbol.fail() : symbol.pass()} ${options.name} rebuilt — at ${lag.lastSeq}/${lag.headSeq}, ${lag.lag} behind`,
    )
    return behind ? 1 : 0
  } finally {
    await runner.close()
  }
}
