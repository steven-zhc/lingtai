/**
 * `lingtai projection rebuild <name>`'s body, once a known projection is
 * resolved — pulled out of `lingtai.ts` so a `unit/` test can reach it
 * without importing that file, which calls `main()` on import (#435, the
 * same reason `addFlow` lives in `add.ts`).
 */
import {
  acquireDaemonLock,
  type AcquireDaemonLockOptions,
  createFileLocker,
  type Locker,
  type LockResult,
} from '@lingtai/daemon'
import { logPredatesHold } from '@lingtai/event-store'
import type { LogQueries } from '@lingtai/event-store/queries'
import {
  backlogProjection,
  spendProjection,
  taskViewProjection,
  ticketReportProjection,
  type ProjectionLag,
  type ProjectionRunner,
} from '@lingtai/projector'

import { heading, symbol, table } from './output.ts'

/**
 * Every projection this system runs, named here in the open.
 *
 * A second one exists now (`finding_backlog`, `#137`), and a third (`spend`,
 * `#497`), and a fourth (`ticket_report`, #687), and `projection rebuild` below says where it has to be added: here,
 * visibly, or it does not exist. It lives in this file and not `lingtai.ts`
 * because `cli.ts` needs it and cannot import a file that calls `main()` on
 * import; the daemon imports it from here.
 */
export const PROJECTIONS = [taskViewProjection, backlogProjection, spendProjection, ticketReportProjection] as const

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

/** Stands in for the real locker where `acquire` is replaced and never reads it. */
const NO_LOCKER: Locker = {
  tryLock: () => Promise.reject(new Error('no locker configured: acquire was replaced')),
}

export interface RebuildUnderLockOptions extends RebuildProjectionOptions {
  /** Takes the conductor lock. A seam so a test needs no real lock file; when replaced, no real locker is built either (#273). */
  acquire?: (options: AcquireDaemonLockOptions) => Promise<LockResult>
}

/**
 * `lingtai projection rebuild`'s body: `rebuildProjection` while holding the
 * conductor lock, or a refusal that names who does (0100 §13).
 *
 * **One writer per projection, and a rebuild is a writer.** It drops the table,
 * rewinds the checkpoint and replays, so a daemon reducing beside it would
 * race the replay. The lock is taken here, in the command's body, and **not
 * inside `rebuildProjection`**: `rates.ts` calls that from the daemon and from
 * `lingtai run`, which already hold the lock, and a second `tryLock` there
 * would be refused every time (the price-triggered rebuild, #680).
 *
 * The lock is released in a `finally`, and a lock that cannot be asked about
 * is a refusal that touches nothing.
 */
export async function rebuildUnderLock(options: RebuildUnderLockOptions): Promise<number> {
  const error = options.error ?? ((line: string) => console.error(line))
  let held: LockResult
  try {
    held = await (options.acquire ?? acquireDaemonLock)({
      name: 'lingtai projection rebuild',
      locker: options.acquire ? NO_LOCKER : createFileLocker(),
    })
  } catch (err) {
    error(
      `${symbol.fail()} could not take the conductor lock (${err instanceof Error ? err.message : String(err)}) — nothing was rebuilt; lingtai doctor says who holds it`,
    )
    return 1
  }
  if (!held.ok) {
    error(
      `${symbol.fail()} ${held.holder ?? 'another process'} holds the conductor lock and is the only writer of ${options.name} — lingtai shutdown "…" first (lingtai service shutdown where the supervisor keeps it), then rebuild`,
    )
    return 1
  }
  try {
    return await rebuildProjection(options)
  } finally {
    await held.lock.release()
  }
}
