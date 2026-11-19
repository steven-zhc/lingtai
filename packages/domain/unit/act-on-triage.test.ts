/**
 * #1258: a triage answer the system can act on resolves its own wait, bound to the wait, the head and the version it
 * read; its own run facts between `TriageStarted` and the answer are not a change; and `WaitResolved{by: 'triage'}` is
 * what spends a bound — one spend whether or not the continuation has run, never a person's.
 */
import { describe, expect, it } from 'vitest'

import type { WaitId } from '../src/action.ts'
import { BOUNDS, causeOriginOf, rerunInPlace, type CauseBound, type CauseCounter } from '../src/failure/respond.ts'
import { triageSpentOf } from '../src/read-model.ts'
import {
  actOnTriageTransition,
  reduceTicket,
  unchangedSince,
  type ActContext,
  type TicketState,
} from '../src/ticket.ts'
import type { TriageResult, WaitReason } from '../src/wait.ts'
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
} satisfies WaitReason
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
} satisfies WaitReason

const waiting = (reason: WaitReason = crashed) => {
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
  split: null,
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

  it('a remote ref that moved while triage ran offers no head to continue on: head-moved', () => {
    const { state } = waiting(refused)
    expect(actOnTriageTransition(state, input(state, { result: fixable }, { fix: null }))).toEqual({
      ok: false,
      refusal: 'head-moved',
    })
  })

  it('no head read on either side is not a head that is unchanged: a rerun and a fix are head-moved', () => {
    const { state } = waiting(refused)
    const none = { boundHead: null, headNow: null }
    expect(
      actOnTriageTransition(state, input(state, {}, { ...none, redo: { onSha: 'base', ref: 'agent/7' } })),
    ).toEqual({ ok: false, refusal: 'head-moved' })
    expect(actOnTriageTransition(state, input(state, { result: fixable }, none))).toEqual({
      ok: false,
      refusal: 'head-moved',
    })
    expect(actOnTriageTransition(state, input(state, {}, { boundHead: null }))).toEqual({
      ok: false,
      refusal: 'head-moved',
    })
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
      data: {
        resolution: { _tag: 'FixRefusal', onSha: 'abc', ref: 'agent/7' },
        spent: { bound: 'refusalFixes', n: 1 },
      },
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
    expect(actOnTriageTransition(now, input(state, { since: [since[0]!, { type: 'WaitStarted', data: {} }] }))).toEqual(
      { ok: false, refusal: 'changed' },
    )
  })
})

describe('a split triage decided (#1262, 0118 §12)', () => {
  const plan = {
    children: [
      { key: 'a', title: 'part a', body: 'do a', kind: 'bug', covers: [] },
      { key: 'b', title: 'part b', body: 'do b', kind: 'bug', covers: [] },
    ],
    blockedBy: [{ ticket: 'b', blockedBy: 'a' }],
    uncovered: [],
  }
  const tooBig = (p: unknown = plan): Answered =>
    ({
      _tag: 'TriageAnswered',
      cause: { _tag: 'TicketTooBig', plan: p, spentOn: null },
      summary: 'two parts',
      want: null,
    }) as Answered
  const split = { instance: 'daemon:1@2026-01-01T00:00:00.000Z', kinds: ['bug', 'feature'] }

  it('records WaitTriaged and SplitStarted in one append, and resolves nothing: the writer ends the wait', () => {
    const { state } = waiting()
    const d = actOnTriageTransition(state, input(state, { result: tooBig() }, { split }))
    expect(d).toMatchObject({ ok: true, action: { _tag: 'splitTicket' }, resolution: null })
    if (!d.ok) throw new Error('unreachable')
    expect(d.events.map((x) => x.type)).toEqual(['WaitTriaged', 'SplitStarted'])
    expect(d.events[1]).toMatchObject({
      actor: 'conductor',
      data: { waitId: W, instance: split.instance, plan: { children: [{ key: 'a' }, { key: 'b' }] } },
    })
    // The decision is counted from `SplitStarted`: the reducer reads the wait as one a split was started for.
    const after = reduceTicket([...waiting().events])
    expect(after.splitStarts).toEqual([])
  })

  it('a plan with problems is a failed triage, never a partial split', () => {
    const { state } = waiting()
    // The structural faults never parse; what is left is the recipe's: a kind the queue would never see.
    const kind = { ...plan, children: plan.children.map((c) => ({ ...c, kind: 'chore' })) }
    expect(actOnTriageTransition(state, input(state, { result: tooBig(kind) }, { split }))).toMatchObject({
      ok: false,
      refusal: 'plan-refused',
      why: expect.stringContaining('chore'),
    })
  })

  it('a second split on the same root, or on a child, is askPerson(limit): only WaitTriaged', () => {
    const { state } = waiting()
    const spent = { ...room, ticketSplits: { used: 1, allowed: 1 } }
    const d = actOnTriageTransition(state, input(state, { result: tooBig() }, { split, counters: spent }))
    expect(d).toMatchObject({ ok: true, action: { _tag: 'askPerson', why: { _tag: 'limit', bound: 'ticketSplits' } } })
    if (d.ok) expect(d.events.map((x) => x.type)).toEqual(['WaitTriaged'])
  })

  it('a project whose tickets are in db (none allowed) leaves the wait for a person, with the plan on the record', () => {
    const { state } = waiting()
    const db = { ...room, ticketSplits: { used: 0, allowed: 0 } }
    const d = actOnTriageTransition(state, input(state, { result: tooBig() }, { split, counters: db }))
    expect(d).toMatchObject({ ok: true, action: { _tag: 'askPerson' } })
    if (d.ok) {
      expect(d.events.map((x) => x.type)).toEqual(['WaitTriaged'])
      expect(d.events[0]).toMatchObject({
        data: { result: { cause: { plan: { children: [{ key: 'a' }, { key: 'b' }] } } } },
      })
    }
  })

  it('without the facts a split needs, the answer is advice only (the port is absent)', () => {
    const { state } = waiting()
    const d = actOnTriageTransition(state, input(state, { result: tooBig() }))
    if (d.ok) expect(d.events.map((x) => x.type)).toEqual(['WaitTriaged'])
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

  describe('a run that met its limit (#1260)', () => {
    const limited = (proposal: object): WaitReason =>
      ({
        _tag: 'ProposedEscalated',
        run: anAttemptRef('run-1'),
        proposal,
        because: { _tag: 'NotAsked' },
      }) as unknown as WaitReason
    const turns = limited({
      _tag: 'BudgetExhausted',
      from: 'implement',
      kind: 'out-of-turns',
      turns: 90,
      costUsd: null,
      detail: 'x',
    })
    const tooBig = (over: object): Answered => ({
      _tag: 'TriageAnswered',
      cause: { _tag: 'TicketTooBig', plan: null, spentOn: null, ...over },
      summary: 'too much',
      want: null,
    })

    it('names the origin from the wait alone, and a timeout at proposed is not a run limit', () => {
      expect(causeOriginOf(turns)).toBe('run-limit')
      expect(causeOriginOf({ ...crashed, cause: 'timeout' })).toBe('run-limit')
      expect(causeOriginOf({ ...crashed, cause: 'crash' })).toBe('other')
      expect(causeOriginOf({ ...crashed, cause: 'timeout', step: 'proposed' })).toBe('other')
      expect(causeOriginOf(limited({ ...(turns as { proposal: object }).proposal, kind: 'out-of-usd' }))).toBe(
        'run-limit',
      )
      // #1249's rule leaves a wall alone
      expect(rerunInPlace('timeout', 'x', 0)).toBeNull()
    })

    it('Unfinished redoes the step and spends one stepRedos, writing nothing', () => {
      const { state } = waiting(turns)
      const d = actOnTriageTransition(state, input(state, {}, { origin: 'run-limit' }))
      expect(d).toMatchObject({ ok: true, section: null })
      if (!d.ok) throw new Error('unreachable')
      expect(d.events[1]).toMatchObject({
        data: { resolution: { _tag: 'RedoStep' }, spent: { bound: 'stepRedos', n: 1 } },
      })
    })

    it('TicketTooBig with spentOn writes it: the text is on the resolution and handed back', () => {
      const { state } = waiting(turns)
      const d = actOnTriageTransition(
        state,
        input(state, { result: tooBig({ spentOn: ' reading the whole repo ' }) }, { origin: 'run-limit' }),
      )
      expect(d).toMatchObject({ ok: true, section: 'reading the whole repo' })
      if (!d.ok) throw new Error('unreachable')
      expect(d.events[1]).toMatchObject({
        data: { resolution: { _tag: 'RedoStep' }, answers: { section: 'reading the whole repo' } },
      })
    })

    it('Unfinished with addToBody writes its sentence; both null is a plain redo', () => {
      const { state } = waiting(turns)
      const withText: Answered = { ...unfinished, cause: { _tag: 'Unfinished', addToBody: 'start at the parser' } }
      const d = actOnTriageTransition(state, input(state, { result: withText }, { origin: 'run-limit' }))
      expect(d).toMatchObject({ ok: true, section: 'start at the parser' })
      const plain = actOnTriageTransition(state, input(state, { result: tooBig({}) }, { origin: 'run-limit' }))
      expect(plain).toMatchObject({ ok: true, section: null })
      if (plain.ok) expect(plain.events[1]).toMatchObject({ data: { resolution: { _tag: 'RedoStep' } } })
    })

    it('a run that committed nothing (no head either side) redoes on its base', () => {
      const { state } = waiting(turns)
      const base = input(state, {}, { origin: 'run-limit', redo: { onSha: 'b'.repeat(40), ref: null } })
      const d = actOnTriageTransition(state, {
        ...base,
        context: { ...base.context, boundHead: null, headNow: null },
      })
      expect(d).toMatchObject({ ok: true, resolution: { _tag: 'RedoStep', ref: null } })
    })

    it('refuses any other cause, by name', () => {
      const { state } = waiting(turns)
      const d = actOnTriageTransition(state, input(state, { result: fixable }, { origin: 'run-limit' }))
      expect(d).toMatchObject({ ok: false, refusal: 'cause-refused' })
      if (!d.ok) expect(d.why).toContain('FixableLines')
    })

    it('with stepRedos spent the wait stays, and the action names the bound', () => {
      const { state } = waiting(turns)
      const spent = { ...room, stepRedos: { used: BOUNDS.stepRedos, allowed: BOUNDS.stepRedos } }
      const d = actOnTriageTransition(state, input(state, {}, { origin: 'run-limit', counters: spent }))
      expect(d).toMatchObject({ ok: true, action: { _tag: 'askPerson', why: { _tag: 'limit', bound: 'stepRedos' } } })
      if (d.ok) expect(d.events.map((x) => x.type)).toEqual(['WaitTriaged'])
      // the decision is recorded with the answer
      if (d.ok)
        expect(d.events[0]!.data).toMatchObject({
          result: { held: { _tag: 'limit', bound: 'stepRedos', used: 3, allowed: 3 } },
        })
    })
  })
})
