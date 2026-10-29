import { describe, expect, it, vi } from 'vitest'

import { closableOnce, ProcessLogClosedError } from '../src/closable.ts'

describe('closableOnce', () => {
  it('closes the opened handle exactly once, with two racing first callers', async () => {
    const close = vi.fn(async () => {})
    const open = vi.fn(async () => ({ close }))
    const c = closableOnce(open)
    const [a, b] = await Promise.all([c.get(), c.get()])
    expect(a).toBe(b)
    await Promise.all([c.close(), c.close()])
    await c.close()
    expect(open).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('with nothing opened resolves, then refuses by name and never opens', async () => {
    const open = vi.fn(async () => ({ close: async () => {} }))
    const c = closableOnce(open)
    await expect(c.close()).resolves.toBeUndefined()
    await expect(c.get()).rejects.toBeInstanceOf(ProcessLogClosedError)
    await expect(c.close()).resolves.toBeUndefined()
    expect(open).not.toHaveBeenCalled()
  })

  it('does not rethrow an open that failed', async () => {
    const c = closableOnce(async () => {
      throw new Error('refused')
    })
    await expect(c.get()).rejects.toThrow('refused')
    await expect(c.close()).resolves.toBeUndefined()
  })
})

describe('the process log', () => {
  it('refuses each way in after closeProcessLog()', async () => {
    vi.resetModules()
    const m = await import('../src/index.ts')
    await expect(m.closeProcessLog()).resolves.toBeUndefined()
    await expect(m.processLog()).rejects.toBeInstanceOf(m.ProcessLogClosedError)
    await expect(m.processEventStore()).rejects.toBeInstanceOf(m.ProcessLogClosedError)
    await expect(m.processTicketSql()).rejects.toBeInstanceOf(m.ProcessLogClosedError)
    await expect(m.closeProcessLog()).resolves.toBeUndefined()
  })
})
