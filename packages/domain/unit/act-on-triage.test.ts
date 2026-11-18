/**
 * #1258: a triage answer the system can act on resolves its own wait, bound to the wait, the head and the version it
 * read; its own run facts between `TriageStarted` and the answer are not a change; and `WaitResolved{by: 'triage'}` is
 * what spends a bound, never a person's.
 */
import { describe, expect, it } from 'vitest'

import type { WaitId } from '../src/action.ts'
import { Actor } from '../src/envelope.ts'
import { BOUNDS, type CauseBound, type CauseCounter } from '../src/failure/respond.ts'
import { actOnTriageTransition, reduceTicket, triageSpentOn, unchangedSince } from '../src/ticket.ts'
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
const unfinished: Extract<TriageResult, { _tag: 'TriageAnswered' }> = {
  _tag: 'TriageAnswered',
  cause: { _tag: 'Unfinished', addToBody: null },
  summary: 'ran out before it finished',
  want: null,
}
const wrong: Extract<TriageResult, { _tag: 'TriageAnswered' }> = {
  _tag: 'TriageAnswered',
  cause: { _tag: 'WrongApproach', why: 'no' },
  summary: 'start over',
  want: null,
}

const waiting = () => {
  const e = item()
  const events = [...aClaim(e, 'run-1'), ...aWait(e, crashed, W), ...aTriageStart(e, W, 1)]
  return { e, state: reduceTicket(events), events }
}
const input = (state: ReturnType<typeof reduceTicket>, over: Record<string, unknown> = {}) => ({
  waitId: W,
  attempt: 1,
  headSha: 'abc',
  boundSha: 'abc',
  by,
  answer: unfinished,
  origin: 'other' as const,
  counters: room,
  ifVersion: state.version,
  headNow: 'abc',
  ...over,
})

describe('actOnTriageTransition', () => {
  it('records WaitTriaged and a triage WaitResolved in one append, and that is the spend', () => {
    const { e, state } = waiting()
    const d = actOnTriageTransition(state, input(state))
    expect(d).toMatchObject({ ok: true, action: { _tag: 'redoStep' } })
    if (!d.ok) throw new Error('unreachable')
    expect(d.events.map((x) => x.type)).toEqual(['WaitTriaged', 'WaitResolved'])
    expect(d.events[1]).toMatchObject({ data: { by: 'triage', resolution: { _tag: 'RedoStep', onSha: 'abc' } } })
    const after = reduceTicket([...aClaim(e, 'x')])
    expect(after).toBeDefined()
    // The wait's resolution is what the spend reads.
    const events = waiting()
    const resolved = reduceTicket([
      ...events.events,
      ...aResolution(events.e, W, { _tag: 'RedoStep', onSha: 'abc', ref: 'agent/7' }, 'triage'),
    ])
    expect(triageSpentOn(resolved).stepRedos).toBe(1)
    expect(triageSpentOn(resolved, 'run-1').stepRedos).toBe(1)
    expect(triageSpentOn(resolved, 'other-run').stepRedos).toBe(0)
  })

  it('every event it returns carries an actor the store accepts, a start-over release included', () => {
    const { state } = waiting()
    for (const over of [{}, { answer: wrong, boundSha: '', headNow: null }]) {
      const d = actOnTriageTransition(state, input(state, over))
      if (!d.ok) throw new Error('unreachable')
      for (const e of d.events) expect(() => Actor.parse(e.actor)).not.toThrow()
      expect(d.events.some((e) => e.type === 'WaitResolved')).toBe(true)
    }
  })

  it('a triage conflict resolution counts as conflictResolutions, a fix as refusalFixes', () => {
    const { e, events } = waiting()
    const resolved = reduceTicket([
      ...events,
      e('WaitTriaged', {
        waitId: W,
        attempt: 1,
        headSha: 'abc',
        result: { ...unfinished, cause: { _tag: 'ConflictingHunks', hunks: [], total: 0 } },
        by,
      }),
      ...aResolution(e, W, { _tag: 'FixRefusal', onSha: 'abc', ref: 'agent/7' }, 'triage'),
    ])
    expect(triageSpentOn(resolved, 'run-1')).toMatchObject({ conflictResolutions: 1, refusalFixes: 0 })
  })

  it('records only WaitTriaged when the bound is spent', () => {
    const { state } = waiting()
    const d = actOnTriageTransition(
      state,
      input(state, { counters: { ...room, stepRedos: { used: BOUNDS.stepRedos, allowed: BOUNDS.stepRedos } } }),
    )
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
    expect(actOnTriageTransition(resolved, input(resolved, { ifVersion: resolved.version }))).toEqual({
      ok: false,
      refusal: 'wait-not-current',
    })
  })

  it('refuses a head that moved, and an unbound head for an action that needs one', () => {
    const { state } = waiting()
    expect(actOnTriageTransition(state, input(state, { headNow: 'def' }))).toEqual({ ok: false, refusal: 'head-moved' })
    expect(actOnTriageTransition(state, input(state, { boundSha: '', headNow: null }))).toEqual({
      ok: false,
      refusal: 'head-moved',
    })
  })

  it('a start-over needs no head', () => {
    const { state } = waiting()
    const d = actOnTriageTransition(state, input(state, { answer: wrong, boundSha: '', headNow: null }))
    expect(d).toMatchObject({ ok: true, action: { _tag: 'startNewAttempt' } })
    if (d.ok) expect(d.events[1]).toMatchObject({ data: { by: 'triage', resolution: { _tag: 'StartNewAttempt' } } })
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
      actOnTriageTransition(now, input(state, { since: [...since.slice(0, 1), { type: 'WaitResolved', data: {} }] })),
    ).toEqual({
      ok: false,
      refusal: 'changed',
    })
  })

  it('a triage spend an attempt counter already holds is not counted again, and one it does not is', () => {
    const { e, events } = waiting()
    const resolved = reduceTicket([
      ...events,
      ...aResolution(e, W, { _tag: 'RedoStep', onSha: 'abc', ref: 'agent/7' }, 'triage'),
    ])
    const seq = resolved.waits[0]!.resolution!.seq!
    // The attempt has raised nothing since: the spend is the triage's alone.
    expect(triageSpentOn(resolved, 'run-1', {}).stepRedos).toBe(1)
    expect(triageSpentOn(resolved, 'run-1', { stepRedosSeq: seq - 1 }).stepRedos).toBe(1)
    // Its continuation, seeded with that spend, wrote a `StepRedone` after the resolution: the counter holds it.
    expect(triageSpentOn(resolved, 'run-1', { stepRedosSeq: seq + 1 }).stepRedos).toBe(0)
    // A conflict resolution is held by `conflictRounds` alone, a fix by `implementRound` alone.
    expect(triageSpentOn(resolved, 'run-1', { conflictRoundsSeq: seq + 1 }).stepRedos).toBe(1)
  })

  it("a person's RedoStep spends nothing", () => {
    const { e, events } = waiting()
    const resolved = reduceTicket([
      ...events,
      ...aResolution(e, W, { _tag: 'RedoStep', onSha: 'abc', ref: 'agent/7' }, 'steven'),
    ])
    expect(triageSpentOn(resolved)).toEqual({ refusalFixes: 0, conflictResolutions: 0, newAttempts: 0, stepRedos: 0 })
  })
})
