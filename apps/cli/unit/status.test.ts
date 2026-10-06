/**
 * `lingtai status`'s two ticket-source lines, named after where a project's
 * tickets actually live rather than always `GitHub` (`#389`).
 *
 * `status()` itself calls `selectRunnable` and `readTasks`, which reach the
 * log, so it is not unit-reachable — `offerLine` and `offerFailedLine` are
 * pulled out of it for exactly that reason, the way `status.ts`'s own design
 * note asks for.
 */
import { describe, expect, it } from 'vitest'

import { offerFailedLine, offerLine } from '../src/status.ts'

describe('offerLine', () => {
  it('names GitHub for a github project', () => {
    expect(offerLine('GitHub', 3, null)).toBe('  from GitHub: 3 eligible')
  })

  it('names the ticket table for a db project, never GitHub', () => {
    const line = offerLine('the ticket table', 5, null)
    expect(line).toBe('  from the ticket table: 5 eligible')
    expect(line).not.toContain('GitHub')
  })

  it('appends the passed-over clause when there is one', () => {
    expect(offerLine('GitHub', 3, '1 blocked-by')).toBe('  from GitHub: 3 eligible, 1 blocked-by')
  })
})

describe('offerFailedLine', () => {
  it('names GitHub as what is unavailable for a github project', () => {
    expect(offerFailedLine('GitHub', new Error('503'))).toBe('  (GitHub unavailable: 503 — the queue cannot be listed)')
  })

  it('names the ticket table for a db project, never GitHub', () => {
    const line = offerFailedLine('the ticket table', new Error('no such table'))
    expect(line).toBe('  (the ticket table unavailable: no such table — the queue cannot be listed)')
    expect(line).not.toContain('GitHub')
  })
})
