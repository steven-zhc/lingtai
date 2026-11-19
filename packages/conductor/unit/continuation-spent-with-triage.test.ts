/**
 * #1258: a continuation is handed the larger of an attempt's counter and what a triage resolution spent — one spend
 * whether or not the continuation has recorded its own number, and none for a person's resolution.
 */
import { reduceAttempt, reduceTicket, type WaitId } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { continuationSpentWithTriage } from '../src/conduct.ts'

const ticketId = 'ticket-lingtai-7'
const waitId = '99999999-9999-4999-8999-999999999999' as WaitId
const crashed = { _tag: 'AgentCrashed', run: { runId: 'run-1' }, step: 'implement', cause: 'crash', detail: 'x' }

const resolvedBy = async (by: string, spentOf?: { bound: string; n: number }) => {
  const store = createMemoryEventStore()
  await store.append(ticketId, 0, [
    {
      type: 'TicketClaimed',
      actor: 'conductor',
      data: { runId: 'run-1', worker: 'host:1', title: 't', kind: 'bug', body: 'b' },
    },
    { type: 'WaitStarted', actor: 'conductor', data: { waitId, reason: crashed } },
    {
      type: 'WaitResolved',
      actor: by === 'triage' ? 'conductor' : by,
      data: {
        waitId,
        by,
        resolution: { _tag: 'RedoStep', onSha: 'abc', ref: 'agent/7' },
        note: '',
        ...(by === 'triage' ? { spent: spentOf ?? { bound: 'stepRedos', n: 1 } } : {}),
      },
    },
  ])
  return reduceTicket(await store.read(ticketId))
}

describe('continuationSpentWithTriage', () => {
  it('a triage RedoStep is one stepRedos before the continuation has recorded anything, and a restart reads the same', async () => {
    const ticket = await resolvedBy('triage')
    const run = reduceAttempt([])
    expect(continuationSpentWithTriage(run, ticket, 'run-1').stepRedos).toBe(1)
    expect(continuationSpentWithTriage(run, ticket, 'run-1').stepRedos).toBe(1)
  })

  it('a continuation that crashed once records `StepRedone{rerun: 2}`: two in all, never three', async () => {
    const ticket = await resolvedBy('triage')
    const run = { ...reduceAttempt([]), stepRedos: 2 }
    expect(continuationSpentWithTriage(run, ticket, 'run-1').stepRedos).toBe(2)
  })

  it("a person's RedoStep spends nothing", async () => {
    const ticket = await resolvedBy('human:steven')
    expect(continuationSpentWithTriage(reduceAttempt([]), ticket, 'run-1').stepRedos).toBe(0)
  })
})

describe('refusal fixes and conflict rounds are independent budgets (#1258)', () => {
  it('a triage conflict resolution spends conflictRounds and no refusal fix', async () => {
    const ticket = await resolvedBy('triage', { bound: 'conflictResolutions', n: 1 })
    const spent = continuationSpentWithTriage(reduceAttempt([]), ticket, 'run-1')
    expect(spent.conflictRounds).toBe(1)
    expect(spent.rounds).toBe(0)
  })

  it('three refusal fixes plus a mechanically routed conflict round still read three rounds', async () => {
    const ticket = await resolvedBy('human:steven')
    const run = { ...reduceAttempt([]), implementRound: 3, conflictRounds: 1 }
    const spent = continuationSpentWithTriage(run, ticket, 'run-1')
    expect(spent.rounds).toBe(3)
    expect(spent.conflictRounds).toBe(1)
  })
})

describe('actor-aware refusal fixes (#1258)', () => {
  const personFix = async () => {
    const store = createMemoryEventStore()
    await store.append(ticketId, 0, [
      {
        type: 'TicketClaimed',
        actor: 'conductor',
        data: { runId: 'run-1', worker: 'host:1', title: 't', kind: 'bug', body: 'b' },
      },
      { type: 'WaitStarted', actor: 'conductor', data: { waitId, reason: crashed } },
      {
        type: 'WaitResolved',
        actor: 'human:steven',
        data: {
          waitId,
          by: 'human:steven',
          resolution: { _tag: 'FixRefusal', onSha: 'abc', ref: 'agent/7' },
          note: '',
        },
      },
    ])
    return reduceTicket(await store.read(ticketId))
  }

  it("a person's FixRefusal continuation raising implementRound spends no refusalFix", async () => {
    const ticket = await personFix()
    const run = { ...reduceAttempt([]), implementRound: 1 }
    expect(continuationSpentWithTriage(run, ticket, 'run-1').refusalFixes).toBe(0)
    expect(continuationSpentWithTriage(run, ticket, 'run-1').rounds).toBe(1)
  })

  it('a triage conflict resolution leaves refusalFixes used at 0', async () => {
    const ticket = await resolvedBy('triage', { bound: 'conflictResolutions', n: 1 })
    const run = { ...reduceAttempt([]), implementRound: 0, conflictRounds: 1 }
    expect(continuationSpentWithTriage(run, ticket, 'run-1').refusalFixes).toBe(0)
  })

  it('a triage-only history names no person rounds, so the allowance keeps all of them', async () => {
    const ticket = await resolvedBy('triage', { bound: 'refusalFixes', n: 1 })
    const run = { ...reduceAttempt([]), implementRound: 3 }
    const spent = continuationSpentWithTriage(run, ticket, 'run-1')
    expect(spent.rounds).toBe(3)
    expect(spent.personRounds).toBe(0)
  })
})
