import { describe, expect, it, vi } from 'vitest'

import { askConductor } from '../src/lib/health.ts'

describe('askConductor (#1015)', () => {
  it('never reads the lock while the beacon is up', async () => {
    const holder = vi.fn(async () => null)
    expect(await askConductor('up', holder)).toBeNull()
    expect(holder).not.toHaveBeenCalled()
  })

  it.each(['stale', 'never'] as const)('reads it once when the beacon is %s', async (daemon) => {
    const holder = vi.fn(async () => 'lingtai run')
    expect(await askConductor(daemon, holder)).toEqual({ held: 'lingtai run' })
    expect(holder).toHaveBeenCalledTimes(1)
  })

  it('says nobody holds it only when the read said so', async () => {
    expect(await askConductor('stale', async () => null)).toEqual({ held: null })
  })

  it('turns a failed read into unread, never into nobody', async () => {
    const out = await askConductor('never', async () => {
      throw new Error('EACCES')
    })
    expect(out).toEqual({ unread: 'EACCES' })
  })
})
