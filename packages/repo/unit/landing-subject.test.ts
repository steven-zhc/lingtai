import { describe, expect, it } from 'vitest'

import { landingSubject, ticketOfLandingSubject } from '../src/landing-subject.ts'

describe('ticketOfLandingSubject', () => {
  it('reads the ticket out of the subject the lane writes', () => {
    expect(ticketOfLandingSubject(landingSubject('agent/771'))).toBe(771)
  })

  it('is null for every other subject', () => {
    expect(ticketOfLandingSubject("Merge branch 'main' of github.com:x/y")).toBeNull()
    expect(ticketOfLandingSubject("Merge branch 'agent/x' into HEAD")).toBeNull()
    expect(ticketOfLandingSubject('wip: run-1')).toBeNull()
  })
})
