import { describe, expect, it, vi } from 'vitest'

import { onOpen } from '../src/app/live.tsx'

describe('onOpen', () => {
  it('does not re-read on the first open, and re-reads once on each later one (#644)', () => {
    const reread = vi.fn()
    const opened = onOpen(reread)
    opened()
    expect(reread).not.toHaveBeenCalled()
    opened()
    expect(reread).toHaveBeenCalledTimes(1)
    opened()
    expect(reread).toHaveBeenCalledTimes(2)
  })

  it('counts per stream, so a remounted page is not treated as a reconnect', () => {
    const reread = vi.fn()
    onOpen(reread)()
    onOpen(reread)()
    expect(reread).not.toHaveBeenCalled()
  })
})
