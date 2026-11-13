import { Effect, Fiber } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { closableOnceEffect } from '../src/closable.ts'

describe('the process log', () => {
  it('refuses each way in after closeProcessLog()', async () => {
    vi.resetModules()
    const m = await import('../src/index.ts')
    await expect(Effect.runPromise(m.closeProcessLogEffect())).resolves.toBeUndefined()
    await expect(Effect.runPromise(m.processEvents)).rejects.toBeInstanceOf(m.ProcessLogClosedError)
    await expect(Effect.runPromise(m.processQueries)).rejects.toBeInstanceOf(m.ProcessLogClosedError)
    await expect(Effect.runPromise(m.processTicketSqlEffect())).rejects.toBeInstanceOf(m.ProcessLogClosedError)
    await expect(Effect.runPromise(m.closeProcessLogEffect())).resolves.toBeUndefined()
  })

  it('reads the closed flag when the Effect port is run, not when it was built', async () => {
    vi.resetModules()
    const m = await import('../src/choose.ts')
    const { ProcessLogClosedError: Closed } = await import('../src/closable.ts')
    await Effect.runPromise(m.closeProcessLogEffect())
    await expect(Effect.runPromise(Effect.flatMap(m.processEvents, (e) => e.head('x')))).rejects.toBeInstanceOf(Closed)
  })
})

describe('closableOnceEffect', () => {
  it('serves a second get from the one open when the first caller is interrupted mid-open', async () => {
    let release!: () => void
    const latch = new Promise<void>((r) => (release = r))
    let entered = 0
    const c = closableOnceEffect(
      Effect.promise(async () => {
        entered++
        await latch
        return { id: 1 }
      }),
      () => Effect.void,
    )
    const first = Effect.runFork(c.get())
    await new Promise((r) => setTimeout(r, 10))
    const interrupting = Effect.runPromise(Fiber.interrupt(first))
    const second = Effect.runPromise(c.get())
    release()
    await interrupting
    expect(await second).toEqual({ id: 1 })
    expect(await Effect.runPromise(c.get())).toBe(await second)
    expect(entered).toBe(1)
  })
})
