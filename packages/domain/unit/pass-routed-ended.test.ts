import { describe, expect, it } from 'vitest'

import { decideRoute, offerFor, parsePayload } from '../src/index.ts'

const offer = offerFor(
  { _tag: 'BuildRed', output: '3 failing' },
  { rounds: 2, restarts: 0 },
  { rounds: 0, restarts: 0, baseMerges: 0, conflictRounds: 0 },
)
const reply = { _tag: 'NotAsked' } as const
const payload = (o: object) => ({ runId: 'pass-1', offer: o, reply, decision: decideRoute(offer, reply) })

/** #931: `ended` is an optional field, so a payload written before it still parses (0100 §4). */
describe('PassRouted offer.ended', () => {
  it('accepts a stored payload with no `ended`, and keeps it absent', () => {
    expect('ended' in parsePayload('PassRouted', payload(offer)).offer).toBe(false)
  })

  it('keeps a version and the action, and keeps null as null', () => {
    const named = parsePayload('PassRouted', payload({ ...offer, ended: { version: 7, action: 'tests' } }))
    expect(named.offer.ended).toEqual({ version: 7, action: 'tests' })
    expect(parsePayload('PassRouted', payload({ ...offer, ended: null })).offer.ended).toBeNull()
  })

  it('never reads version 0 as a version', () => {
    expect(() => parsePayload('PassRouted', payload({ ...offer, ended: { version: 0, action: 'tests' } }))).toThrow()
  })
})
