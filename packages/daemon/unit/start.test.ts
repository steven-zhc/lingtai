/**
 * #174. A daemon obeys only control events above its watermark (#159), and the
 * lock is what `lingtai service shutdown` and `lingtai restart` wait on. So the
 * watermark has to be read **before** the lock: read after, a request appended
 * while the holder was still starting sat below the watermark of the one
 * process that had to obey it, and the wait for the lock never ended.
 *
 * The order is asserted with nothing but the two calls replaced — no projection,
 * no database — because the order is the whole of the claim.
 */
import { LogPredatesHoldError } from '@lingtai/event-store'
import { describe, expect, it } from 'vitest'

import { startDaemon } from '../src/daemon.ts'

/** Every test here replaces `predatesHold` — left to its default, it opens the process log, which no unit test has. */
const clearToStart = async () => null

describe('startDaemon', () => {
  it('reads the control watermark before it tries for the lock, and hands that watermark back', async () => {
    const order: string[] = []
    let stream = 7
    const started = await startDaemon({
      projections: [],
      predatesHold: clearToStart,
      watermark: async () => (order.push(`watermark at ${stream}`), stream),
      acquire: async () => {
        order.push('lock taken')
        // The request lands the moment the lock is held — the reviewer's gap.
        stream += 1
        return { ok: true, lock: { release: async () => void order.push('lock released') } }
      },
    })

    expect(order).toEqual(['watermark at 7', 'lock taken'])
    expect(started.ok).toBe(true)
    if (!started.ok) return
    // The request at version 8 is above `since`, so `readControl(store, since)` returns it.
    expect(started.since).toBe(7)
    expect(stream).toBeGreaterThan(started.since)

    started.daemon.stop()
    expect(await started.daemon.stopped).toBe('asked')
    expect(order).toEqual(['watermark at 7', 'lock taken', 'lock released'])
  })

  it('reads the watermark even when the lock is lost, and takes nothing', async () => {
    const order: string[] = []
    const started = await startDaemon({
      projections: [],
      predatesHold: clearToStart,
      watermark: async () => (order.push('watermark'), 0),
      acquire: async () => (order.push('lock refused'), { ok: false, holder: 'pid 1 on elsewhere' }),
    })
    expect(order).toEqual(['watermark', 'lock refused'])
    expect(started).toEqual({ ok: false, reason: 'already-running', holder: 'pid 1 on elsewhere' })
  })

  /**
   * #451. The guard runs ahead of both: a log too old to fold has to be
   * caught before the watermark is read or the lock is taken, because a
   * refusal that already holds the lock is a daemon somebody else has to
   * notice is not conducting.
   */
  it('refuses before the watermark or the lock when the log predates the Hold event', async () => {
    const order: string[] = []
    const started = await startDaemon({
      projections: [],
      predatesHold: async () => (order.push('predates-hold'), new LogPredatesHoldError(5n)),
      watermark: async () => (order.push('watermark'), 0),
      acquire: async () => (order.push('lock taken'), { ok: false, holder: null }),
    })

    expect(order).toEqual(['predates-hold'])
    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started).toEqual({
      ok: false,
      reason: 'log-predates-hold',
      detail: new LogPredatesHoldError(5n).message,
    })
  })
})
