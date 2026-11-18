/**
 * #1241 / 0108: the log says `StepRedone`, `NewAttempt`, `FixRefusal`, `MergeBaseBranch` and the bound names, and every
 * row written under the old ones reads with the same meaning — through an upcaster, never rewritten on the log.
 */
import { describe, expect, it } from 'vitest'

import { SCHEMA_VER, isRetiredEventType, parseStoredPayload } from '../src/index.ts'

const OLD_TO_NEW = {
  rounds: 'refusalFixes',
  'conflict-rounds': 'conflictResolutions',
  restarts: 'newAttempts',
  'base-merges': 'baseBranchMerges',
} as const

const proposal = { _tag: 'ReviewFindings', findings: [] }
const storedProposal = { _tag: 'ReviewFindings' }
const route = (type: string, offer: object, decision: object = { _tag: 'Selected', candidate: 'fix-lines' }) => ({
  runId: 'run-1',
  offer: {
    proposal: type === 'PassRouted' ? proposal : storedProposal,
    ended: { version: 3, action: 'review' },
    ...offer,
  },
  reply: { _tag: 'NotAsked' },
  decision,
})

describe('StepRerunInPlace is retired and StepRedone is not', () => {
  it('refuses to append the old name and leaves the new one writable', () => {
    expect(isRetiredEventType('StepRerunInPlace')).toBe(true)
    expect(isRetiredEventType('StepRedone')).toBe(false)
  })
})

describe('TicketReleased 1 → 2', () => {
  const released = (cause: unknown) => ({ runId: 'run-1', reason: 'why', cause })

  it('reads Restart{restart} as NewAttempt{newAttempt}', () => {
    expect(SCHEMA_VER.TicketReleased).toBe(2)
    expect(parseStoredPayload('TicketReleased', 1, released({ _tag: 'Restart', restart: 2 }))).toEqual(
      released({ _tag: 'NewAttempt', newAttempt: 2 }),
    )
  })

  it('leaves every other cause, and a release with none, as it was', () => {
    const never = { _tag: 'NeverStarted', scope: 'conductor' }
    expect(parseStoredPayload('TicketReleased', 1, released(never))).toEqual(released(never))
    expect(parseStoredPayload('TicketReleased', 1, released(null))).toEqual(released(null))
  })

  it('is a no-op on a row already in the new shape', () => {
    const now = released({ _tag: 'NewAttempt', newAttempt: 1 })
    expect(parseStoredPayload('TicketReleased', 1, now)).toEqual(now)
  })
})

describe.each(['ProposalRouted', 'PassRouted'] as const)('%s 1 → 2', (type) => {
  it('reads every renamed next in the offer, field for field', () => {
    expect(SCHEMA_VER[type]).toBe(3)
    const read = parseStoredPayload(
      type,
      1,
      route(type, {
        available: [
          { id: 'fix-lines', next: { _tag: 'FixRound', to: 'implement', round: 2, conflict: 1 } },
          { id: 'merge-base', next: { _tag: 'MergeBase', toSha: 'abc', merge: 3 } },
          { id: 'restart', next: { _tag: 'Requeued', cause: { _tag: 'Restart', restart: 1 } } },
          { id: 'hand-to-person', next: { _tag: 'HandToPerson' } },
        ],
        unavailable: [],
      }),
    ) as { offer: { available: { id: string; next: unknown }[] } }
    expect(read.offer.available.map((c) => c.next)).toEqual([
      { _tag: 'FixRefusal', to: 'implement', round: 2, conflict: 1 },
      { _tag: 'MergeBaseBranch', toSha: 'abc', merge: 3 },
      { _tag: 'Requeued', cause: { _tag: 'NewAttempt', newAttempt: 1 } },
      { _tag: 'HandToPerson' },
    ])
  })

  it.each(Object.entries(OLD_TO_NEW))(
    'reads a ceiling of %s as %s, in the offer and in an escalated decision',
    (was, now) => {
      const excluded = (ceiling: string) => ({ id: 'fix-lines', because: { _tag: 'CeilingReached', ceiling } })
      const read = parseStoredPayload(
        type,
        1,
        route(
          type,
          { available: [], unavailable: [excluded(was), { id: 'x', because: { _tag: 'NoCriterion' } }] },
          { _tag: 'Escalated', because: { _tag: 'CandidateUnavailable', excluded: excluded(was) } },
        ),
      ) as { offer: { unavailable: unknown[] }; decision: unknown }
      expect(read.offer.unavailable).toEqual([excluded(now), { id: 'x', because: { _tag: 'NoCriterion' } }])
      expect(read.decision).toEqual({
        _tag: 'Escalated',
        because: { _tag: 'CandidateUnavailable', excluded: excluded(now) },
      })
    },
  )

  it('leaves an escalation that names no candidate as it was', () => {
    const decision = { _tag: 'Escalated', because: { _tag: 'NotAsked' } }
    const read = parseStoredPayload(type, 1, route(type, { available: [], unavailable: [] }, decision)) as {
      decision: unknown
    }
    expect(read.decision).toEqual(decision)
  })
})

describe('WaitStarted 1 → 2', () => {
  const run = { runId: 'run-1' }
  const started = (because: unknown) => ({
    waitId: 'wait-1',
    reason: { _tag: 'ProposedEscalated', run, proposal, because },
  })

  it.each(Object.entries(OLD_TO_NEW))('reads a ceiling of %s as %s', (was, now) => {
    expect(SCHEMA_VER.WaitStarted).toBe(3)
    const excluded = (ceiling: string) => ({ id: 'restart', because: { _tag: 'CeilingReached', ceiling } })
    const read = parseStoredPayload(
      'WaitStarted',
      1,
      started({ _tag: 'CandidateUnavailable', excluded: excluded(was) }),
    ) as { reason: { because: unknown } }
    expect(read.reason.because).toEqual({ _tag: 'CandidateUnavailable', excluded: excluded(now) })
  })

  it('leaves a wait for any other reason as it was', () => {
    const other = {
      waitId: 'wait-2',
      reason: { _tag: 'CheckRefused', run, step: 'proposed', action: 'x', evidence: 'y', findings: [] },
    }
    expect(parseStoredPayload('WaitStarted', 1, other)).toEqual(other)
  })
})
