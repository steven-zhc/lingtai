import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@lingtai/daemon', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lingtai/daemon')>()),
  readStatusEffect: () => Effect.die(new Error('the beacon store is down')),
  readControlEffect: () => Effect.die(new Error('the control store is down')),
}))

const { daemonLiveness } = await import('../src/doctor.ts')

describe('daemon: liveness (#1098)', () => {
  it('answers no daemon has run when its default reads die', async () => {
    const row = await Effect.runPromise(daemonLiveness())
    expect(row.status).toBe('ok')
    expect(row.detail).toContain('no daemon has run')
  })

  it('still fails when a read it was handed fails: only the defaults swallow', async () => {
    await expect(
      Effect.runPromise(daemonLiveness(() => Effect.fail(new Error('sorry, too many clients already')))),
    ).rejects.toThrow('sorry, too many clients already')
  })
})
