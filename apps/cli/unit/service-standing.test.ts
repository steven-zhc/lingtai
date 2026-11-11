/** `service`'s refusal over a standing drain (0126): exempt by `by`, and a failed read refuses. */
import { describe, expect, it } from 'vitest'

import { standingRefusal } from '../src/service.ts'

const BY = 'human:steven'

describe('standingRefusal', () => {
  it('lets nothing standing through, silently', () => {
    expect(standingRefusal({ by: BY, standing: null, unloaded: false })).toEqual({ refuse: false, note: null })
  })

  it("does not refuse this person's own request, and says so in one line", () => {
    const verdict = standingRefusal({ by: BY, standing: { by: BY, reason: 'for the night' }, unloaded: false })
    expect(verdict.refuse).toBe(false)
    if (!verdict.refuse) expect(verdict.note).toBe('your drain stands (for the night); this start ends it')
  })

  it("refuses somebody else's, and says that starting a conductor ends it", () => {
    for (const unloaded of [false, true]) {
      const verdict = standingRefusal({ by: BY, standing: { by: 'human:alice', reason: 'maintenance' }, unloaded })
      expect(verdict.refuse).toBe(true)
      if (verdict.refuse) {
        const said = verdict.lines.join('\n')
        expect(said).toContain('human:alice')
        expect(said).toContain('starting a conductor (lingtai daemon) ends it')
        expect(said).not.toContain('resume')
      }
    }
  })

  it('refuses when the control stream could not be read', () => {
    const verdict = standingRefusal({ by: BY, standing: { unread: 'connect ECONNREFUSED' }, unloaded: false })
    expect(verdict.refuse).toBe(true)
    if (verdict.refuse) expect(verdict.lines.join('\n')).toContain('connect ECONNREFUSED')
  })
})
