import { describe, expect, it } from 'vitest'

import { standingSystemResolution, systemBoundOf, systemLine, systemLineText } from '../src/index.ts'
import type { TicketState } from '../src/index.ts'

const answered = (tag: string) =>
  ({ _tag: 'TriageAnswered', cause: { _tag: tag, addToBody: null }, summary: 's' }) as never
const redo = { _tag: 'RedoStep', onSha: 'a', ref: 'r' } as never
const fix = { _tag: 'FixRefusal', onSha: 'a', ref: 'r' } as never
const fresh = { _tag: 'StartNewAttempt' } as never

describe('systemLine', () => {
  it('a redo reads the cause, the action and the bound', () => {
    const l = systemLine(
      { resolution: redo, by: 'triage', spent: { bound: 'stepRedos', n: 2 } },
      answered('Unfinished'),
      { used: 2, allowed: 3 },
    )
    expect(systemLineText(l)).toBe('Triage read only unfinished; the step is being redone — 2 of 3 redos used')
  })
  it('a fix of lines and a conflict resolution are told apart by the bound spent', () => {
    const lines = systemLine(
      { resolution: fix, by: 'triage', spent: { bound: 'refusalFixes', n: 1 } },
      answered('FixableLines'),
      {
        used: 1,
        allowed: 2,
      },
    )
    expect(lines.action).toBe('the lines are being fixed')
    expect(lines.bound).toBe('1 of 2 fix rounds used')
    const conflict = systemLine(
      { resolution: fix, by: 'triage', spent: { bound: 'conflictResolutions', n: 1 } },
      answered('ConflictingHunks'),
      { used: 1, allowed: 2 },
    )
    expect(conflict.action).toBe('the conflict is being resolved')
    expect(conflict.bound).toBe('1 of 2 conflict resolutions used')
  })
  it('a new attempt reads its own bound', () => {
    const l = systemLine({ resolution: fresh, by: 'triage' }, answered('WrongApproach'), { used: 1, allowed: 2 })
    expect(l.action).toBe('a new attempt is being started')
    expect(l.bound).toBe('1 of 2 new attempts used')
  })
  it('a counter that could not be read says so, never 0 of N', () => {
    const l = systemLine({ resolution: redo, by: 'triage' }, answered('Unfinished'), null)
    expect(l.bound).toBe('bound unknown')
  })
  it('a missing WaitTriaged keeps the note and makes up no cause', () => {
    const l = systemLine({ resolution: redo, by: 'triage', note: 'only unfinished' }, null, { used: 1, allowed: 3 })
    expect(l).toEqual({ action: 'resolved by triage: only unfinished', because: null, bound: null })
  })
  it('a missing WaitTriaged reads resolved by triage, with no cause', () => {
    const l = systemLine({ resolution: redo, by: 'triage' }, null, { used: 1, allowed: 3 })
    expect(l).toEqual({ action: 'resolved by triage', because: null, bound: null })
  })
})

const wait = (over: Record<string, unknown>) =>
  ({
    waitId: 'w1',
    reason: { run: { runId: 'run-a' } },
    at: new Date(10),
    resolution: { resolution: redo, by: 'triage', spent: { bound: 'stepRedos', n: 2 } },
    triage: { started: null, result: null, headSha: null },
    landed: null,
    closed: null,
    ...over,
  }) as never
const state = (over: Record<string, unknown>) =>
  ({
    waits: [wait({})],
    claims: [],
    newAttempts: [],
    lifecycle: { status: 'backlog' },
    ...over,
  }) as unknown as TicketState

describe('systemBoundOf', () => {
  it('takes redos from the log and the constant', () => {
    const s = state({})
    expect(systemBoundOf(s, s.waits[0]!, null)).toEqual({ used: 2, allowed: 3 })
  })
  it('takes a new attempt from its release record, and is null without limits', () => {
    const w = wait({ resolution: { resolution: fresh, by: 'triage' } })
    const s = state({ waits: [w], newAttempts: [{ after: 'run-a', newAttempt: 2 }] })
    const limits = { refusalFixes: 2, conflictResolutions: 2, newAttempts: 4 }
    expect(systemBoundOf(s, w, limits)).toEqual({ used: 2, allowed: 4 })
    expect(systemBoundOf(s, w, null)).toBeNull()
  })
})

describe('standingSystemResolution', () => {
  it('stands after the resolution', () => {
    expect(standingSystemResolution(state({}))).not.toBeNull()
  })
  it('a person’s resolution does not', () => {
    const w = wait({ resolution: { resolution: redo, by: 'someone' } })
    expect(standingSystemResolution(state({ waits: [w] }))).toBeNull()
  })
  it('ends at a later WaitStarted', () => {
    const later = wait({ waitId: 'w2', resolution: null, at: new Date(20) })
    expect(standingSystemResolution(state({ waits: [wait({}), later] }))).toBeNull()
  })
  it('ends at a new attempt’s claim but not at its own run’s', () => {
    expect(standingSystemResolution(state({ claims: [{ runId: 'run-b', at: new Date(30), ended: null }] }))).toBeNull()
    expect(
      standingSystemResolution(state({ claims: [{ runId: 'run-a', at: new Date(30), ended: null }] })),
    ).not.toBeNull()
  })
  it('ends at a terminal event', () => {
    for (const status of ['landed', 'closed', 'satisfied'])
      expect(standingSystemResolution(state({ lifecycle: { status } }))).toBeNull()
  })
})
