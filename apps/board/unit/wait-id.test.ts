/** The wait id and question on a board card come from one projected row (#465). */
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
    wait: {
      waitId: aWaitId(),
      reason: {
        _tag: 'SignoffRequired',
        run: { runId: 'pass-465' },
        step: 'proposed',
        action: 'human',
        question: 'the `proposed` step held: land it?',
      },
    },
    answer: null,
    split: null,
    triage: { started: null, result: null },
    triageHeadSha: null,
    repairPending: false,
  }
}

describe("a card's own wait id", () => {
  it('carries the waitId on the row, for Decide/Requeue/Close to send back', () => {
    const t = blocked()
    expect(toCard(t).waitId).toBe(t.wait?.waitId)
  })

  it('is null off the waiting lane', () => {
    const t = blocked()
    expect(toCard({ ...t, state: 'landed', wait: null }).waitId).toBeNull()
  })
})

/**
 * **A card must not show one wait's question beside a different wait's id**
 * (#465, round 3's own finding). Both come from the row's `wait`, even if
 * its copied note is stale.
 */
describe("a card's own question, paired with its wait id", () => {
  it("uses the reason paired with the wait id, not task_view's copied note", () => {
    const t = blocked()
    const card = toCard({ ...t, note: 'stale question' })
    expect(card.note).toBe('the `proposed` step held: the `proposed` step held: land it?')
    expect(card.note).not.toBe('stale question')
  })

  it("uses the row's note when there is no wait", () => {
    const t = blocked()
    expect(toCard({ ...t, state: 'landed', wait: null }).note).toBe(t.note)
  })
})
