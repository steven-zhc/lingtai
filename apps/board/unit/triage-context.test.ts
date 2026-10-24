/**
 * #576. The card and the task page derive a wait's `TriageStatus` from the same
 * inputs, so a queued triage reads `Queued` on both and an interrupted one
 * reads `Interrupted` on both. Each was a literal on the card before.
 */
import type { WaitId } from '@lingtai/domain'
import { aRunRef } from '@lingtai/domain/test/events'
import type { TaskCard } from '@lingtai/projector/task-view'
import { describe, expect, it } from 'vitest'

import { cardTriageStatus, triageContextOf } from '../src/lib/board.ts'
import { currentTriageStatus } from '../src/lib/task.ts'

const waitId = 'wait-1' as WaitId
const reason = { _tag: 'NothingProduced', run: aRunRef('run-one'), said: null } as const

function waiting(triage: TaskCard['triage']): TaskCard {
  return {
    taskId: 'ticket-lingtai-576',
    project: 'lingtai',
    issue: '576',
    title: 'the card derives triage status',
    kind: 'bug',
    state: 'waiting',
    tier: 'guarded',
    runId: null,
    turns: null,
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
    restarts: 0,
    restartsOf: 0,
    lastAttemptAt: null,
    awaitingSha: null,
    awaitingApproval: false,
    wait: { waitId, reason },
    answer: null,
    triage,
    triageHeadSha: null,
    repairPending: false,
  }
}

const standing = { state: 'blocked', waitId, reason } as Parameters<typeof currentTriageStatus>[0]
const daemon = { startedAt: new Date('2026-10-20T12:00:00Z') }

function both(card: TaskCard, declared: boolean) {
  const context = triageContextOf(declared, daemon)
  return {
    card: cardTriageStatus(card, context),
    page: currentTriageStatus(standing, card, context)?.status,
  }
}

describe('a wait’s triage status', () => {
  it('reads Queued on the card as on the page, once triage is declared', () => {
    const { card, page } = both(waiting({ started: null, result: null }), true)
    expect(card).toEqual({ _tag: 'Queued' })
    expect(card).toEqual(page)
  })

  it('reads Interrupted on the card as on the page, for an attempt older than the daemon', () => {
    const started = { attempt: 1, at: new Date('2026-10-20T11:00:00Z') }
    const { card, page } = both(waiting({ started, result: null }), true)
    expect(card).toEqual({ _tag: 'Interrupted' })
    expect(card).toEqual(page)
  })
})
