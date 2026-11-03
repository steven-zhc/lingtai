import { describe, expect, it } from 'vitest'

import type { WaitId } from '../src/action.ts'
import { reduceTicket } from '../src/ticket.ts'
import { lateHistories } from '../test/histories.ts'

const w1 = 'wait-ledger-1' as WaitId

describe('the GitHub ledger (#832)', () => {
  const ledger = reduceTicket(lateHistories.ticket.githubLedger).github
  const before = reduceTicket(lateHistories.ticket.bodyBeforeAnotherWait).github

  it('D9: the last word per change', () => {
    expect(ledger.last.labels?.outcome).toBe('failed')
    expect(ledger.labels).toEqual(['lingtai:waiting'])
    expect(ledger.last.closed?.outcome).toBe('failed')
  })

  it('D9: a waiting comment and its edit', () => {
    expect(ledger.comments).toEqual([{ waitId: w1, commentId: 101, question: 'ship it?' }])
    expect(ledger.edited).toEqual([w1])
  })

  it('D9: a body write belongs to the wait it followed', () => {
    expect(ledger.bodyAfterWait).not.toBeNull()
    expect(ledger.bodyAfterWait).toBe(ledger.lastWait)
    expect(before.bodyAfterWait).not.toBe(before.lastWait)
  })
})
