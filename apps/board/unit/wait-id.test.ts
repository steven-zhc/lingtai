/**
 * The home board's own `BoardCard.waitId` (#465). `task_view` carries no
 * `wait_id` column, so `toCard` takes it as an argument — `laneWaitIds`'s own
 * read of the item stream, never cut the way `laneProgress`'s rails are —
 * rather than reading it off the `TaskCard` the way every other field here
 * does.
 */
import { aWaitId } from '@lingtai/domain/test/events'
import type { TaskCard } from '@lingtai/projector/task-view'
import { describe, expect, it } from 'vitest'

import { toCard } from '../src/lib/board.ts'

function blocked(): TaskCard {
  return {
    taskId: 'ticket-lingtai-465',
    project: 'lingtai',
    issue: '465',
    title: 'a continuation never diffs against the sha it was approved at',
    kind: 'bug',
    state: 'waiting',
    tier: 'guarded',
    runId: 'pass-465',
    turns: 3,
    passed: 1,
    failed: 0,
    waived: 0,
    approved: 0,
    baseSha: null,
    headSha: 'b'.repeat(40),
    files: null,
    insertions: null,
    deletions: null,
    note: 'the `proposed` step held: land it?',
    updatedAt: new Date('2026-10-20T00:00:00Z'),
    closedAt: null,
    attempts: 1,
    restarts: 0,
    restartsOf: 0,
    lastAttemptAt: null,
    awaitingSha: 'b'.repeat(40),
    awaitingApproval: true,
    waiting: true,
    needs: 'judgement',
    diagnosis: null,
    asked: false,
    answer: null,
    repairPending: false,
  }
}

describe("a card's own wait id", () => {
  it('carries the waitId it was handed, for Decide/Requeue/Close to send back', () => {
    const t = blocked()
    const waitId = aWaitId()

    const card = toCard(t, null, null, null, null, undefined, undefined, waitId)

    expect(card.waitId).toBe(waitId)
  })

  it('is null when the caller gave none — a queued or landed card, or a waiting one `laneWaitIds` could not read', () => {
    const t = blocked()

    expect(toCard(t).waitId).toBeNull()
  })
})

/**
 * **A card must not show one wait's question beside a different wait's id**
 * (#465, round 3's own finding). `laneWaitIds` reads `note` off the same
 * fold as `waitId` — never off `task_view`'s own row, which can lag behind
 * a reclaim that already produced a new wait. `toCard`'s `freshNote`
 * argument is where that pairing is kept: it overrides `t.note` whenever
 * the caller has a fresher one to give.
 */
describe("a card's own question, paired with its wait id", () => {
  it("uses the fresh note handed in alongside the wait id, not task_view's own, lagging one", () => {
    const t = blocked()
    const waitId = aWaitId()

    const card = toCard(t, null, null, null, null, undefined, undefined, waitId, 'which helper — a or b?')

    expect(card.note).toBe('which helper — a or b?')
    expect(card.note).not.toBe(t.note)
  })

  it("falls back to task_view's own note when the caller has no fresher one", () => {
    const t = blocked()

    expect(toCard(t).note).toBe(t.note)
  })
})
