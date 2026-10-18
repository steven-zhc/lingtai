/**
 * `heldUntil`, pure and copied here from `integration/queue.test.ts:250-278`
 * so it runs under `pnpm test` — `selectRunnable` itself reads `task_view`
 * through `readTasks`, which makes the rest of that file integration-only.
 *
 * This is #488's pin on `queue.ts`: a comment-only diff there is checked by
 * `git diff` touching nothing outside a doc comment, and by these four cases
 * staying green.
 */
import { describe, expect, it } from 'vitest'

import { heldUntil } from '../src/queue.ts'

describe('heldUntil', () => {
  const at = new Date('2026-09-08T12:00:00Z')
  const now = at.getTime() + 10 * 60_000
  const HOUR = 60 * 60_000

  it('says when the window ends, while it is still open', () => {
    const until = heldUntil({ lastAttemptAt: at, repairPending: false }, HOUR, now)
    expect(until?.toISOString()).toBe('2026-09-08T13:00:00.000Z')
  })

  it('holds nothing once the window has passed', () => {
    expect(heldUntil({ lastAttemptAt: at, repairPending: false }, 5 * 60_000, now)).toBeNull()
  })

  it('holds nothing that has never been attempted', () => {
    expect(heldUntil({ lastAttemptAt: null, repairPending: false }, HOUR, now)).toBeNull()
  })

  /**
   * A pending repair jumps the backoff, and only a repair (0025 §3, 0028).
   *
   * Nothing buys one since `#143`, so the only row that carries one is an item
   * the old code released for a repair before a deploy — which is still owed
   * the run it was released for, and making it wait an hour would leave it
   * stuck an hour longer.
   */
  it('holds nothing with a repair pending', () => {
    expect(heldUntil({ lastAttemptAt: at, repairPending: true }, HOUR, now)).toBeNull()
  })
})
