/** #996. The board's reader's refusal of a question on a locked project. */
import type { Envelope } from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

import { askRefusal } from '../src/lib/locks.ts'

const ev = (type: string): Envelope =>
  ({
    type,
    data: { project: 'lingtai', by: 'human:steven' },
    at: new Date('2026-11-10T14:20:00Z'),
    seq: 1n,
  }) as unknown as Envelope

describe('askRefusal', () => {
  it('is null when nothing holds the project', () => {
    expect(askRefusal('lingtai', [])).toBeNull()
    expect(askRefusal('lingtai', [ev('ProjectPaused'), ev('ProjectResumed')])).toBeNull()
  })

  it('names the lock and says to resume when paused', () => {
    expect(askRefusal('lingtai', [ev('ProjectPaused')])).toMatch(
      /^lingtai is paused by human:steven .* — resume it, then ask$/,
    )
  })

  it('refuses when the read failed: unknown is not unlocked', () => {
    expect(askRefusal('lingtai', new Error('down'))).toBe('could not read whether lingtai is paused — down')
  })
})
