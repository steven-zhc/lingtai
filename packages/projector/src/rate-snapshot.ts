/**
 * The read half of the fetched rate snapshot (#658), here and not in
 * `@lingtai/conductor` because the `spend` fold prices from it (#679) and the
 * conductor depends on this package, not the other way round.
 *
 * Reading only: the fetch and the write stay in `conductor/src/rate-snapshot.ts`,
 * which re-exports `readRateSnapshot`. Under a test with no `LINGTAI_HOME` of
 * its own the snapshot reads empty, so no test prices from the developer's real one.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { RateRow } from '@lingtai/domain/rate-card'
import { stateDir } from '@lingtai/env'

/** The directory the snapshot and its note live in, or null where a test has none of its own. */
export function rateDir(from: NodeJS.ProcessEnv): string | null {
  const ownHome = Boolean(from['LINGTAI_HOME'])
  if (!ownHome && (from['VITEST'] || from['LINGTAI_TEST'])) return null
  return stateDir(from)
}

export const snapshotPath = (from: NodeJS.ProcessEnv): string | null => {
  const dir = rateDir(from)
  return dir === null ? null : join(dir, 'rates.json')
}

export function readJson(path: string | null): unknown {
  if (path === null || !existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** The snapshot's rows. Absent or malformed reads as none, never a throw. */
export function readRateSnapshot(from: NodeJS.ProcessEnv = process.env): RateRow[] {
  const doc = readJson(snapshotPath(from)) as { rows?: unknown } | undefined
  return Array.isArray(doc?.rows) ? (doc.rows as RateRow[]) : []
}
