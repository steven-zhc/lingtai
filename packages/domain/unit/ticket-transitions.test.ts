/** The Ticket's claim, continue and release as pure transitions: what each refuses, and the one event each makes. */
import { describe, expect, it } from 'vitest'

import { type WaitId } from '../src/action.ts'
import {
  askTransition,
  claimTransition,
  closeChecks,
  closeTransition,
  continueTransition,
  finishTriageTransition,
  startTriageTransition,
  releaseTransition,
  reduceTicket,
  resolvedEvents,
  resolveWaitTransition,
} from '../src/ticket.ts'
import type { Resolution } from '../src/wait.ts'
import { aClaim, anAttemptRef, aResolution, aSplit, aTriageStart, aWait } from '../test/events.ts'
import { makeStream } from '../test/support.ts'

const WAIT = '11111111-1111-4111-8111-111111111111' as WaitId
const item = () => makeStream('ticket-lingtai-7')
const backlog = () => reduceTicket([])
const claimed = (worker = 'host:1') => reduceTicket(aClaim(item(), 'run-1', worker))
const split = () => reduceTicket(aSplit(item(), WAIT, [161, 162]))
const base = { runId: 'run-2', worker: 'host:2', children: null } as const

describe('claimTransition', () => {
  it('claims a backlog ticket with the one event', () => {
    const d = claimTransition(backlog(), { ...base, title: 't', kind: 'bug', body: 'b' })
    expect(d).toMatchObject({ ok: true })
    if (d.ok) {
      expect(d.events).toHaveLength(1)
      expect(d.events[0]).toMatchObject({
        type: 'TicketClaimed',
        data: { runId: 'run-2', worker: 'host:2', title: 't', kind: 'bug', body: 'b' },
      })
    }
  })

  it('refuses a held ticket', () => {
    expect(claimTransition(claimed(), base)).toEqual({
      ok: false,
      refusal: { reason: 'held', by: 'host:1', runId: 'run-1' },
    })
  })

  it('refuses a ticket in a state that cannot be claimed', () => {
    const closed = reduceTicket([item()('TicketClosed', { by: 'steven', reason: 'no' })])
    expect(claimTransition(closed, base)).toMatchObject({ ok: false, refusal: { reason: 'not-claimable' } })
  })

  it('refuses a split whose children could not be read', () => {
    expect(claimTransition(split(), { ...base, children: { unreadable: 'boom' } })).toEqual({
      ok: false,
      refusal: { reason: 'split-unreadable', detail: 'boom' },
    })
  })

  it('refuses a split with an open child', () => {
    const children = {
      read: [
        { number: 161, state: 'closed' },
        { number: 162, state: 'open' },
      ],
    }
    expect(claimTransition(split(), { ...base, children })).toEqual({
      ok: false,
      refusal: { reason: 'split-open', open: [162] },
    })
  })

  it('answers split-done, at the version read, when every child is closed', () => {
    const children = {
      read: [
        { number: 161, state: 'closed', stateReason: 'completed' as const },
        { number: 162, state: 'closed' },
      ],
    }
    const state = split()
    expect(claimTransition(state, { ...base, children })).toEqual({
      ok: false,
      refusal: {
        reason: 'split-done',
        version: state.version,
        waitId: WAIT,
        children: [
          { number: 161, stateReason: 'completed' },
          { number: 162, stateReason: null },
        ],
      },
    })
  })

  it('claims a split whose children were not asked about', () => {
    expect(claimTransition(split(), base)).toMatchObject({ ok: true })
  })
})

describe('continueTransition', () => {
  it('refuses a ticket that is not approved', () => {
    expect(continueTransition(claimed(), { runId: 'run-1', worker: 'w' })).toEqual({
      ok: false,
      refusal: { reason: 'not-approved', status: 'claimed' },
    })
  })
})

describe('releaseTransition', () => {
  it('a run releases with what it was handed, whatever the state', () => {
    const d = releaseTransition(backlog(), { by: 'run', runId: 'r', reason: 'x', cause: null })
    expect(d).toMatchObject({
      ok: true,
      events: [{ type: 'TicketReleased', data: { runId: 'r', reason: 'x', cause: null } }],
    })
  })

  it('a dead worker is released with the lock named in the reason', () => {
    const d = releaseTransition(claimed(), { by: 'dead-worker', mine: 'host:2', lock: 'lingtai:daemon' })
    expect(d).toMatchObject({
      ok: true,
      events: [
        {
          type: 'TicketReleased',
          data: { runId: 'run-1', reason: 'host:2 holds lingtai:daemon, so host:1 was not coming back', cause: null },
        },
      ],
    })
  })

  it('refuses a claim that is no longer a dead worker’s', () => {
    expect(releaseTransition(claimed('host:2'), { by: 'dead-worker', mine: 'host:2', lock: 'l' })).toEqual({
      ok: false,
      refusal: { reason: 'moved-on', status: 'claimed', worker: 'host:2' },
    })
    expect(releaseTransition(backlog(), { by: 'dead-worker', mine: 'host:2', lock: 'l' })).toEqual({
      ok: false,
      refusal: { reason: 'moved-on', status: 'backlog' },
    })
  })
})

describe('the person decides a wait', () => {
  const W = '22222222-2222-4222-8222-222222222222' as WaitId
  const question = {
    _tag: 'AgentQuestion',
    run: anAttemptRef('run-1'),
    step: 'implement',
    questions: [] as never[],
    said: 'which?',
  } as const
  const blocked = () => reduceTicket([...aClaim(item(), 'run-1'), ...aWait(item(), question, W)])
  const own = () =>
    reduceTicket([item()('WaitStarted', { waitId: W, reason: { _tag: 'OwnQuestion', question: 'q', by: 'steven' } })])
  const block = () => {
    const life = blocked().lifecycle
    if (life.status !== 'blocked') throw new Error('not blocked')
    return life
  }

  it('refuses a wait the ticket is not on', () => {
    const other = '33333333-3333-4333-8333-333333333333' as WaitId
    expect(resolveWaitTransition(blocked(), { waitId: other, resolution: { _tag: 'Close' } })).toEqual({
      ok: false,
      refusal: { reason: 'not-blocked', waitId: other },
    })
    expect(resolveWaitTransition(backlog(), { waitId: W, resolution: { _tag: 'Close' } })).toMatchObject({
      ok: false,
      refusal: { reason: 'not-blocked' },
    })
  })

  it('refuses a resolution the wait does not offer', () => {
    expect(
      resolveWaitTransition(own(), { waitId: W, resolution: { _tag: 'Approve', onSha: 'a'.repeat(40) } }),
    ).toMatchObject({
      ok: false,
      refusal: { reason: 'not-offered', resolution: 'Approve' },
    })
  })

  it('goes ahead with the block it resolves', () => {
    expect(resolveWaitTransition(blocked(), { waitId: W, resolution: { _tag: 'Close' } })).toMatchObject({
      ok: true,
      kind: 'proceed',
      block: { waitId: W, runId: 'run-1' },
    })
  })

  it('answers an approval that already landed with a repeat, and no events', () => {
    const sha = 'a'.repeat(40)
    const approved = reduceTicket([
      ...aClaim(item(), 'run-1'),
      ...aWait(item(), question, W),
      ...aResolution(item(), W, { _tag: 'Approve', onSha: sha }),
    ])
    expect(approved.lifecycle.status).toBe('approved')
    expect(resolveWaitTransition(approved, { waitId: W, resolution: { _tag: 'Approve', onSha: sha } })).toEqual({
      ok: true,
      kind: 'repeat',
      runId: 'run-1',
    })
    expect(
      resolveWaitTransition(approved, { waitId: W, resolution: { _tag: 'Approve', onSha: 'b'.repeat(40) } }),
    ).toMatchObject({ ok: false, refusal: { reason: 'not-blocked' } })
  })

  it("a requeue records the resolution and the person's release, acting as the person", () => {
    const d = resolvedEvents(blocked(), block(), {
      waitId: W,
      by: 'steven',
      resolution: { _tag: 'StartNewAttempt' },
      note: 'n',
    })
    if (!d.ok) throw new Error('refused')
    expect(d.events.map((e) => e.type)).toEqual(['WaitResolved', 'TicketReleased'])
    expect(d.events[1]).toMatchObject({
      actor: 'steven',
      data: { runId: 'run-1', reason: 'Requeued by steven.', cause: { _tag: 'ByPerson', waitId: W } },
    })
  })

  it('a wait no run holds has no release, and a close never releases', () => {
    const q = own()
    const life = q.lifecycle
    if (life.status !== 'blocked') throw new Error('not blocked')
    const d = resolvedEvents(q, life, {
      waitId: W,
      by: 'steven',
      resolution: { _tag: 'AnswerQuestion', choice: 'x' },
      note: 'x',
    })
    expect(d.ok && d.events.map((e) => e.type)).toEqual(['WaitResolved'])
    const c = resolvedEvents(blocked(), block(), { waitId: W, by: 'steven', resolution: { _tag: 'Close' }, note: '' })
    expect(c.ok && c.events.map((e) => e.type)).toEqual(['WaitResolved'])
  })

  it('refuses a split whose children were not written for this wait', () => {
    const resolution: Resolution = { _tag: 'Split', children: [], blockedBy: [] }
    expect(resolvedEvents(blocked(), block(), { waitId: W, by: 'steven', resolution, note: '' })).toEqual({
      ok: false,
      refusal: { reason: 'split-not-written' },
    })
    expect(
      resolvedEvents(blocked(), block(), {
        waitId: W,
        by: 'steven',
        resolution,
        note: '',
        split: { waitId: '44444444-4444-4444-8444-444444444444', children: [], blockedBy: [] },
      }),
    ).toEqual({ ok: false, refusal: { reason: 'split-not-written' } })
  })
})

describe('askTransition', () => {
  const W = '55555555-5555-4555-8555-555555555555' as WaitId
  it('starts an own question on a backlog ticket', () => {
    expect(askTransition(backlog(), { waitId: W, question: 'which?', by: 'steven' })).toMatchObject({
      ok: true,
      events: [
        {
          type: 'WaitStarted',
          actor: 'steven',
          data: { waitId: W, reason: { _tag: 'OwnQuestion', question: 'which?', by: 'steven' } },
        },
      ],
    })
  })

  it('refuses a ticket something holds', () => {
    expect(askTransition(claimed(), { waitId: W, question: 'q', by: 'steven' })).toEqual({
      ok: false,
      refusal: { reason: 'not-backlog', status: 'claimed' },
    })
  })
})

describe('closeChecks and closeTransition', () => {
  const W = '66666666-6666-4666-8666-666666666666' as WaitId
  const blocked = () =>
    reduceTicket([
      ...aClaim(item(), 'run-1'),
      ...aWait(
        item(),
        { _tag: 'AgentQuestion', run: anAttemptRef('run-1'), step: 'implement', questions: [] as never[], said: 'q' },
        W,
      ),
    ])
  const closed = () => reduceTicket([item()('TicketClosed', { by: 'steven', reason: 'no' })])

  it('names each terminal and a moved stream', () => {
    expect(closeChecks(closed(), {})).toEqual({ reason: 'already-closed' })
    expect(closeChecks(backlog(), {})).toBeNull()
    expect(closeChecks(backlog(), { ifVersion: 3 })).toEqual({ reason: 'changed' })
    expect(closeChecks(claimed(), { ifVersion: claimed().version })).toBeNull()
  })

  it('closes a backlog ticket with TicketClosed and its plan only', () => {
    const d = closeTransition(backlog(), { by: 'steven', reason: 'r', waitId: undefined, ended: [] })
    expect(d).toMatchObject({ ok: true, blocked: false })
    if (d.ok) expect(d.events.map((e) => e.type)).toEqual(['TicketClosed'])
  })

  it('resolves the wait it closes in the same events, ahead of TicketClosed and the plan', () => {
    const ended = { type: 'StepsResolved', actor: 'conductor', data: {} }
    const d = closeTransition(blocked(), { by: 'steven', reason: 'r', waitId: undefined, ended: [ended] as never })
    expect(d).toMatchObject({ ok: true, blocked: true })
    if (d.ok) expect(d.events.map((e) => e.type)).toEqual(['WaitResolved', 'TicketClosed', 'StepsResolved'])
  })

  it('refuses a card that showed no wait when the ticket is blocked', () => {
    expect(closeTransition(blocked(), { by: 'steven', reason: 'r', waitId: null, ended: [] })).toEqual({
      ok: false,
      refusal: { reason: 'wait-moved', waitId: W },
    })
  })

  it('refuses a wait that is not the one open', () => {
    const other = '77777777-7777-4777-8777-777777777777' as WaitId
    expect(closeTransition(blocked(), { by: 'steven', reason: 'r', waitId: other, ended: [] })).toMatchObject({
      ok: false,
      refusal: { reason: 'not-blocked' },
    })
  })
})

describe('startTriageTransition and finishTriageTransition', () => {
  const W = '66666666-6666-4666-8666-666666666666' as WaitId
  const question = {
    _tag: 'AgentQuestion',
    run: anAttemptRef('run-1'),
    step: 'implement',
    questions: [] as never[],
    said: 'q',
  } as const
  const by = { _tag: 'Mechanical' } as const
  const blocked = (...more: ReturnType<typeof aTriageStart>) =>
    reduceTicket([...aClaim(item(), 'run-1'), ...aWait(item(), question, W), ...more])
  const failed = { _tag: 'TriageFailed', why: 'x' } as const
  const done = { waitId: W, attempt: 1, headSha: 'sha', result: failed, by } as const

  it('starts attempt 1 of a wait with none started', () => {
    expect(startTriageTransition(blocked(), { waitId: W, attempt: 1, by })).toMatchObject({
      ok: true,
      events: [{ type: 'TriageStarted', data: { waitId: W, attempt: 1 } }],
    })
  })

  it('refuses a wait that is not current', () => {
    expect(startTriageTransition(backlog(), { waitId: aWaitIdOther(), attempt: 1, by })).toMatchObject({ ok: true })
    const resolved = reduceTicket([
      ...aClaim(item(), 'run-1'),
      ...aWait(item(), question, W),
      ...aResolution(item(), W, { _tag: 'Close' }),
      item()('TicketClosed', { by: 'steven', reason: 'x' }),
    ])
    expect(startTriageTransition(resolved, { waitId: W, attempt: 1, by })).toEqual({
      ok: false,
      refusal: { reason: 'wait-not-current' },
    })
  })

  it('refuses when this attempt already started', () => {
    const state = blocked(...aTriageStart(item(), W, 1))
    expect(startTriageTransition(state, { waitId: W, attempt: 1, by })).toEqual({
      ok: false,
      refusal: { reason: 'already-started', attempt: 1 },
    })
  })

  it('refuses when a later attempt already started', () => {
    const state = blocked(...aTriageStart(item(), W, 2))
    expect(startTriageTransition(state, { waitId: W, attempt: 1, by })).toMatchObject({
      ok: false,
      refusal: { reason: 'already-started', attempt: 2 },
    })
  })

  it('refuses on a started attempt the caller read off the stream for a wait the reduce never saw', () => {
    expect(startTriageTransition(backlog(), { waitId: W, attempt: 1, by, startedUnseen: 1 })).toEqual({
      ok: false,
      refusal: { reason: 'already-started', attempt: 1 },
    })
  })

  it('starts the next attempt after an earlier one', () => {
    const state = blocked(...aTriageStart(item(), W, 1))
    expect(startTriageTransition(state, { waitId: W, attempt: 2, by })).toMatchObject({ ok: true })
  })

  it('finishes a current wait and refuses one that is not', () => {
    expect(finishTriageTransition(blocked(), done)).toMatchObject({ ok: true, events: [{ type: 'WaitTriaged' }] })
    const resolved = reduceTicket([
      ...aClaim(item(), 'run-1'),
      ...aWait(item(), question, W),
      ...aResolution(item(), W, { _tag: 'Close' }),
      item()('TicketClosed', { by: 'steven', reason: 'x' }),
    ])
    expect(finishTriageTransition(resolved, done)).toEqual({ ok: false, refusal: { reason: 'wait-not-current' } })
  })

  it('refuses a finish when the stream moved past the version the caller decided on', () => {
    const state = blocked()
    expect(finishTriageTransition(state, { ...done, ifVersion: state.version })).toMatchObject({ ok: true })
    expect(finishTriageTransition(state, { ...done, ifVersion: state.version - 1 })).toEqual({
      ok: false,
      refusal: { reason: 'changed' },
    })
  })
})

function aWaitIdOther(): WaitId {
  return '77777777-7777-4777-8777-777777777777' as WaitId
}
