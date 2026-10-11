/**
 * `lingtai projection rebuild <name>`'s body, once a known projection is
 * resolved — pulled out of `lingtai.ts` so a `unit/` test can reach it
 * without importing that file, which calls `main()` on import (#435, the
 * same reason `addFlow` lives in `add.ts`).
 */
import { logPredatesHold } from '@lingtai/event-store'
import type { LogQueries } from '@lingtai/event-store/queries'
import type { ProjectionRunner } from '@lingtai/projector'

export interface RebuildProjectionOptions {
  name: string
  queries: Pick<LogQueries, 'rowsOfType'>
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
    error(predates.message)
    return 1
  }

  const runner = options.runnerFor()
  try {
    await runner.rebuild()
    const lag = await runner.lag()
    log(`${options.name} rebuilt — at ${lag.lastSeq}/${lag.headSeq}, ${lag.lag} behind`)
    return lag.lag === 0n ? 0 : 1
  } finally {
    await runner.close()
  }
}
