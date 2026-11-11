/**
 * #996. A resume reaches `discuss` as well as a request. The loop's delivery
 * and the CLI handler's guard both read `DISCUSSION_EVENTS`, so this list is
 * the claim; the memory store's waker never fires here, so a live delivery is
 * settled on the log instead (a `ProjectResumed` followed by a `DiscussionAsked`).
 */
import { describe, expect, it } from 'vitest'

import { COMPLETION_EVENTS, DISCUSSION_EVENTS } from '../src/work-loop.ts'

describe('what discuss is handed', () => {
  it('names a request and a resume, and no landing', () => {
    expect([...DISCUSSION_EVENTS]).toEqual(['DiscussionRequested', 'ProjectResumed'])
    expect(DISCUSSION_EVENTS as readonly string[]).not.toContain('TicketLanded')
  })

  it('every unlock that wakes a pass is either delivered to discuss or known not to be', () => {
    expect(COMPLETION_EVENTS as readonly string[]).toContain('ProjectResumed')
  })
})
