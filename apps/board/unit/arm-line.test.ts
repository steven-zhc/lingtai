/**
 * `lingtai status` and the board say a ticket's arm in the same words (#100,
 * #504).
 *
 * The board builds its line through `toCard`, which calls `describeArm` with
 * the recipe's own `limits.restarts` as the ceiling (`board.ts:536`).
 * `lingtai status` has to feed `describeArm` the same ceiling rather than the
 * row's own `restarts_of`, which has had no writer since `#502` and stays at
 * its DDL default of 0. This is the one test that renders both and checks
 * they agree, which is what stops #100 from reopening.
 */
import type { TaskCard } from '@lingtai/projector/task-view'
import { describe, expect, it } from 'vitest'

import { armLine } from '../../cli/src/status.ts'
import { toCard } from '../src/lib/board.ts'

/** A requeued ticket, in the shape the projection writes since #502 — `restartsOf` stays 0 regardless of `restarts`. */
function requeued(): TaskCard {
  return {
    taskId: 'ticket-lingtai-504',
    project: 'lingtai',
    issue: '504',
    title: 'lingtai status prints the restart count without its ceiling',
    kind: 'bug',
    state: 'queued',
    tier: 'guarded',
    runId: null,
    turns: null,
    costUsd: null,
    passed: 0,
    failed: 0,
    waived: 0,
    approved: 0,
    baseSha: null,
    headSha: null,
    files: null,
    insertions: null,
    deletions: null,
    note: null,
    updatedAt: new Date('2026-10-20T00:00:00Z'),
    closedAt: null,
    attempts: 1,
    restarts: 1,
    restartsOf: 0,
    lastAttemptAt: null,
    awaitingSha: null,
    awaitingApproval: false,
    waiting: false,
    needs: null,
    diagnosis: null,
    asked: false,
    answer: null,
    repairPending: false,
    repairCostUsd: null,
  }
}

describe('the arm line', () => {
  it('says the same thing on the board and in lingtai status, ceiling included', () => {
    const limits = { rounds: 3, restarts: 2 }
    const t = requeued()

    expect(toCard(t, null, null, null, limits).arm).toBe('restart 1 of 2')
    expect(armLine(t, limits.restarts)).toBe('restart 1 of 2')
  })

  it('says the same thing when the recipe could not be read, with no ceiling', () => {
    const t = requeued()

    expect(toCard(t, null, null, null, null).arm).toBe('restart 1')
    expect(armLine(t, null)).toBe('restart 1')
  })
})
