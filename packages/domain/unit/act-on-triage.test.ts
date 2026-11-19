/**
 * #1258: a triage answer the system can act on resolves its own wait, bound to the wait, the head and the version it
 * read; its own run facts between `TriageStarted` and the answer are not a change; and `WaitResolved{by: 'triage'}` is
 * what spends a bound — one spend whether or not the continuation has run, never a person's.
 */
import { describe, expect, it } from 'vitest'

import type { WaitId } from '../src/action.ts'
import { BOUNDS, type CauseBound, type CauseCounter } from '../src/failure/respond.ts'
import { triageSpentOf } from '../src/read-model.ts'
import {
  actOnTriageTransition,
  reduceTicket,
  unchangedSince,
  type ActContext,
  type TicketState,
} from '../src/ticket.ts'
import type { TriageResult } from '../src/wait.ts'
import { aClaim, anAttemptRef, aResolution, aTriageStart, aWait } from '../test/events.ts'
import { makeStream } from '../test/support.ts'

const W = '99999999-9999-4999-8999-999999999999' as WaitId
const item = () => makeStream('ticket-lingtai-7')
const crashed = {
  _tag: 'AgentCrashed',
  run: anAttemptRef('run-1'),
  step: 'implement',
  cause: 'crash',
  detail: 'x',
} as const
const by = { _tag: 'Mechanical' } as const
const room: Record<CauseBound, CauseCounter> = {
  refusalFixes: { used: 0, allowed: 3 },
  newAttempts: { used: 0, allowed: 2 },
  ticketSplits: { used: 0, allowed: 1 },
  stepRedos: { used: 0, allowed: BOUNDS.stepRedos },
  conflictResolutions: { used: 0, allowed: 5 },
  personAsks: { used: 0, allowed: 5 },
}
type Answered = Extract<TriageResult, { _tag: 'TriageAnswered' }>
const unfinished: Answered = {
  _tag: 'TriageAnswered',
  cause: { _tag: 'Unfinished', addToBody: null },
  summary: 'ran out before it finished',
  want: null,
}
const wrong: Answered = {
  _tag: 'TriageAnswered',
  cause: { _tag: 'WrongApproach', why: 'no' },
  summary: 'start over',
  want: null,
}
const fixable: Answered = {
  _tag: 'TriageAnswered',
  cause: { _tag: 'FixableLines', fixes: [] },
  summary: 'a line',
  want: null,
}

const refused = {
  _tag: 'CheckRefused',
  run: anAttemptRef('run-1'),
  step: 'proposed',
  action: 'watch:ci',
  evidence: 'the check failed',
  findings: [],
} as const

const waiting = (reason: typeof crashed | typeof refused = crashed) => {
  const e = item()
  const events = [...aClaim(e, 'run-1'), ...aWait(e, reason, W), ...aTriageStart(e, W, 1)]
  return { e, state: reduceTicket(events), events }
}
const context = (over: Partial<ActContext> = {}): ActContext => ({
  origin: 'other',
  counters: room,
  boundHead: 'abc',
  headNow: 'abc',
  fix: { onSha: 'abc', ref: 'agent/7' },
  redo: { onSha: 'abc', ref: 'agent/7' },
  ...over,
})
const input = (state: TicketState, over: Record<string, unknown> = {}, ctx: Partial<ActContext> = {}) => ({
  waitId: W,
  attempt: 1,
  headSha: 'abc',
  by,
  result: unfinished,
  ifVersion: state.version,
  since: [],
  context: context(ctx),
  ...over,
})

describe('actOnTriageTransition', () => {
  it('records WaitTriaged and a triage WaitResolved in one append, and that is the spend', () => {
    const { state } = waiting()
    const d = actOnTriageTransition(state, input(state))
    expect(d).toMatchObject({ ok: true, action: { _tag: 'redoStep' } })
    if (!d.ok) throw new Error('unreachable')
    expect(d.events.map((x) => x.type)).toEqual(['WaitTriaged', 'WaitResolved'])
    expect(d.events[1]).toMatchObject({
      data: {
        by: 'triage',
        resolution: { _tag: 'RedoStep', onSha: 'abc' },
        // the number the continuation will itself record for the bound: one more than was used
        spent: { bound: 'stepRedos', n: 1 },
      },
    })
  })

  it('records only WaitTriaged when the bound is spent', () => {
    const { state } = waiting()
    const spent = { ...room, stepRedos: { used: BOUNDS.stepRedos, allowed: BOUNDS.stepRedos } }
    const d = actOnTriageTransition(state, input(state, {}, { counters: spent }))
    expect(d).toMatchObject({ ok: true, action: { _tag: 'askPerson' } })
    if (d.ok) expect(d.events.map((x) => x.type)).toEqual(['WaitTriaged'])
  })

  it('a person who resolved first makes the answer refused: wait-not-current', () => {
    const { e, events } = waiting()
    const resolved = reduceTicket([
      ...events,
      ...aResolution(e, W, { _tag: 'Close' }),
      e('TicketClosed', { by: 'steven', reason: 'x' }),
    ])
    expect(actOnTriageTransition(resolved, input(resolved))).toEqual({ ok: false, refusal: 'wait-not-current' })
  })

  it('refuses a head that moved, and an action that needs a head the move does not name', () => {
    const { state } = waiting()
    expect(actOnTriageTransition(state, input(state, {}, { headNow: 'def' }))).toEqual({
      ok: false,
      refusal: 'head-moved',
    })
    expect(actOnTriageTransition(state, input(state, {}, { redo: null }))).toEqual({
      ok: false,
      refusal: 'head-moved',
    })
  })

  it('a rerun on an attempt that committed nothing is bound to no head and is allowed', () => {
    const { state } = waiting()
    const d = actOnTriageTransition(
      state,
      input(state, {}, { boundHead: null, headNow: null, redo: { onSha: 'base', ref: null } }),
    )
    expect(d).toMatchObject({ ok: true, action: { _tag: 'redoStep' } })
  })

  it('a start-over needs no head, and releases the claim as a spent new attempt in the same append', () => {
    const { state } = waiting()
    const d = actOnTriageTransition(state, input(state, { result: wrong }, { boundHead: null, headNow: 'zzz' }))
    expect(d).toMatchObject({ ok: true, action: { _tag: 'startNewAttempt' } })
    if (!d.ok) throw new Error('unreachable')
    expect(d.events.map((x) => x.type)).toEqual(['WaitTriaged', 'WaitResolved', 'TicketReleased'])
    expect(d.events[2]).toMatchObject({
      data: { reason: 'Requeued by triage.', cause: { _tag: 'NewAttempt', newAttempt: 1 } },
    })
  })

  it('a fix is a FixRefusal on the saved head and spends refusalFixes', () => {
    const { state } = waiting(refused)
    const d = actOnTriageTransition(state, input(state, { result: fixable }))
    if (!d.ok) throw new Error(JSON.stringify(d))
    expect(d.events[1]).toMatchObject({
      data: { resolution: { _tag: 'FixRefusal', onSha: 'abc', ref: 'agent/7' }, spent: { bound: 'refusalFixes', n: 1 } },
    })
  })

  it("the triage's own run facts after TriageStarted are not a change; anything else is", () => {
    const { state } = waiting()
    const own = (type: string, waitId: string = W) => ({ type, data: { for: { _tag: 'Triage', waitId } } })
    const since = [own('RunPrompted'), own('RunSpent')]
    expect(unchangedSince(since, W)).toBe(true)
    expect(unchangedSince([...since, { type: 'TicketClosed', data: {} }], W)).toBe(false)
    expect(unchangedSince([own('RunSpent', 'other')], W)).toBe(false)
    // The stream is two events past the version the triage read, both its own.
    const now = { ...state, version: state.version + 2 }
    expect(actOnTriageTransition(now, input(state, { since }))).toMatchObject({ ok: true })
    expect(
      actOnTriageTransition(now, input(state, { since: [since[0]!, { type: 'WaitStarted', data: {} }] })),
    ).toEqual({ ok: false, refusal: 'changed' })
  })
})

describe('triageSpentOf', () => {
  const resolvedBy = (by: string, spent?: { bound: 'stepRedos' | 'refusalFixes'; n: number }) => {
    const { e, events } = waiting()
    return reduceTicket([
      ...events,
      e('WaitResolved', {
        waitId: W,
        by,
        resolution: { _tag: 'RedoStep', onSha: 'abc', ref: 'agent/7' },
        note: '',
        ...(spent === undefined ? {} : { spent }),
      }),
    ])
  }

  it("a person's RedoStep or FixRefusal spends nothing", () => {
    expect(triageSpentOf(resolvedBy('steven'), 'run-1')).toEqual({
      refusalFixes: 0,
      conflictResolutions: 0,
      stepRedos: 0,
    })
    const { e, events } = waiting()
    const fixed = reduceTicket([
      ...events,
      ...aResolution(e, W, { _tag: 'FixRefusal', onSha: 'abc', ref: 'agent/7' }, 'steven'),
    ])
    expect(triageSpentOf(fixed, 'run-1').refusalFixes).toBe(0)
  })

  it("a triage resolution is the spend, for its own attempt and no other's", () => {
    const state = resolvedBy('triage', { bound: 'stepRedos', n: 1 })
    expect(triageSpentOf(state, 'run-1').stepRedos).toBe(1)
    expect(triageSpentOf(state, 'run-2').stepRedos).toBe(0)
  })

  it('a reader takes the larger of it and the attempt, so the continuation recording its own number is one spend', () => {
    const state = resolvedBy('triage', { bound: 'stepRedos', n: 1 })
    const spent = triageSpentOf(state, 'run-1').stepRedos
    // Before the continuation has run: the attempt holds none, the spend is triage's alone.
    expect(Math.max(0, spent)).toBe(1)
    // The continuation seeded with that spend, then crashed once: `StepRedone{rerun: 1 + 1}` — two in all, never three.
    expect(Math.max(2, spent)).toBe(2)
    // A restart between the append and the effect re-reads the same log and reads the same one.
    expect(Math.max(0, triageSpentOf(state, 'run-1').stepRedos)).toBe(1)
  })
})
