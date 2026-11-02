/**
 * D1 (`doc/design/one-fold-per-stream.md` §5): one verdict ladder. Each cell is
 * folded over the fixed histories (#798) through all three readers — `RunState.steps`,
 * `cardFactOf` (task_view) and `boardFactOf` — and they must give one word.
 */
import { describe, expect, it } from 'vitest'

import type { Envelope } from '../src/index.ts'
import { boardFactOf, cardFactOf, reduceRun } from '../src/index.ts'
import { histories } from '../test/histories.ts'

const BOARD_ENDING = {
  passed: 'Passed',
  failed: 'Failed',
  'never-ran': 'NeverRan',
  'did-not-finish': 'DidNotFinish',
  asked: 'Asked',
  waived: 'Waived',
} as const

function readers(events: readonly Envelope[]) {
  const steps = Object.fromEntries(Object.entries(reduceRun(events).steps).map(([k, s]) => [k, s.verdict]))
  const cards = Object.fromEntries(
    events.flatMap(cardFactOf).flatMap((f) => (f._tag === 'Verdict' ? [[f.key, f.verdict] as const] : [])),
  )
  const board = Object.fromEntries(
    events.flatMap(boardFactOf).flatMap((f) => (f._tag === 'StepEnded' ? [[`${f.step}:${f.action}`, f] as const] : [])),
  )
  return { steps, cards, board }
}

function agree(events: readonly Envelope[], key: string, verdict: keyof typeof BOARD_ENDING) {
  const r = readers(events)
  expect(r.steps[key]).toBe(verdict)
  expect(r.cards[key]).toBe(verdict)
  expect(r.board[key]?.ending).toBe(BOARD_ENDING[verdict])
}

describe('the one verdict ladder', () => {
  it('D1: a commit that produced no head did not finish', () => {
    agree(histories.run.commitCompletedNoHead, 'implement:keep', 'did-not-finish')
  })

  it('D1: a worktree that was not done did not finish', () => {
    agree(histories.run.worktreeNotDone, 'prepared:cut', 'did-not-finish')
  })

  it('D1: a requested signoff is asked', () => {
    const events = histories.run.signoffRequestedThenLifecycle
    const r = readers(events)
    expect(r.steps['proposed:human']).toBe('asked')
    expect(r.cards['proposed:human']).toBe('asked')
    expect(events.flatMap(boardFactOf).some((f) => f._tag === 'SignoffRequested')).toBe(true)
  })

  it('D1: an unreadable design answer failed', () => {
    agree(histories.run.designAnswerUnreadable, 'design:draft', 'failed')
  })

  it('NotReached is skipped by every reader', () => {
    const r = readers(histories.run.laterActionNotReached)
    expect(Object.keys(r.steps)).toEqual(['build:test'])
    expect(Object.keys(r.cards)).toEqual(['build:test'])
    expect(Object.keys(r.board)).toEqual(['build:test'])
  })
})
