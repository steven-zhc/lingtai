/**
 * #1014. One project's unreadable recipe is that project's problem: the
 * triage read answers `null` for it and the others stand.
 */
import type { WaitId } from '@lingtai/domain'
import { anAttemptRef } from '@lingtai/domain/test/events'
import type { TaskCard } from '@lingtai/projector/task-view'
import { describe, expect, it } from 'vitest'

import { declaredTriage, recipeUnreadContext, toCard, triageContextOf } from '../src/lib/board.ts'

const project = (name: string) => ({ project: name }) as unknown as Parameters<typeof declaredTriage>[0][number]
const recipe = (triage: boolean) =>
  Promise.resolve({ recipe: { triage: triage ? {} : undefined } }) as ReturnType<
    Parameters<typeof declaredTriage>[1] & {}
  >

function waiting(reason: NonNullable<TaskCard['wait']>['reason']): TaskCard {
  return {
    taskId: 'ticket-b-1',
    project: 'b',
    issue: '1',
    title: 't',
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
    updatedAt: new Date('2026-11-01T00:00:00Z'),
    closedAt: null,
    attempts: 1,
    restarts: 0,
    restartsOf: 0,
    lastAttemptAt: null,
    awaitingSha: null,
    awaitingApproval: false,
    wait: { waitId: 'wait-1' as WaitId, reason },
    answer: null,
    split: null,
    triage: { started: null, result: null },
    triageHeadSha: null,
    repairPending: false,
  }
}

const nothing = { _tag: 'NothingProduced', run: anAttemptRef('run-one'), said: null } as const

describe('an unreadable recipe (#1014)', () => {
  it('maps to null for that project alone, and does not reject', async () => {
    const declared = await declaredTriage([project('a'), project('b'), project('c')], (p) =>
      (p as unknown as { project: string }).project === 'b' ? Promise.reject(new Error('bad')) : recipe(true),
    )
    expect(Object.fromEntries(declared)).toEqual({ a: true, b: null, c: true })
  })

  it('makes a recipe-dependent waiting card say so, with no button', () => {
    const read = toCard(waiting(nothing), null, null, null, null, undefined, undefined, recipeUnreadContext(null))
    expect(read.triage).toBe('RecipeUnreadable')
    expect(read.move).toBeNull()
  })

  it('leaves the registry’s unknown as Unknown', () => {
    const read = toCard(waiting(nothing), null, null, null, null, undefined, undefined, triageContextOf(null, null))
    expect(read.triage).toBe('Unknown')
  })

  it('shows the status itself where both answers agree', () => {
    const done = {
      _tag: 'TriageAdvised',
      summary: 's',
      cause: { _tag: 'Unknown' },
    } as unknown as NonNullable<TaskCard['triage']['result']>
    const card = { ...waiting(nothing), triage: { started: null, result: done } }
    const read = toCard(card, null, null, null, null, undefined, undefined, recipeUnreadContext(null))
    expect(read.triage).toBeNull()
  })
})
