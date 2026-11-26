import { spawnSync } from 'node:child_process'

import { Effect } from 'effect'

/** What `bun --version` said, or why nothing was heard. Never throws: an unknown version is the row's `fail`. */
export type BunAnswer = { readonly answered: string } | { readonly failed: string }

/**
 * Runs `bun --version` — the one command, never the compiled hook (#1479). A stale binary is caught by the smoke
 * test before every dispatch, not here.
 */
export const probeBunVersion = (): Effect.Effect<BunAnswer> =>
  Effect.sync(() => {
    const result = spawnSync('bun', ['--version'], { encoding: 'utf8', timeout: 15_000 })
    if (result.error) return { failed: result.error.message }
    if (result.status !== 0) {
      return { failed: `bun --version exited ${result.status}: ${(result.stderr ?? '').trim()}` }
    }
    return { answered: result.stdout ?? '' }
  })
