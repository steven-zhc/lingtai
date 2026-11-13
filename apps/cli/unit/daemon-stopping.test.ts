/**
 * #1103: the first Ctrl+C drains and says so once, and the drain is never interrupted. A fake loop
 * waits on a `Deferred`; the daemon is not stopped, and the beacon not given its last word, until
 * the pass finishes.
 */
import type { DaemonPort } from '@lingtai/daemon'
import { Context, Deferred, Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { daemonStopping } from '../src/daemon.ts'

const lines: string[] = []
beforeEach(() => {
  lines.length = 0
  process.env['NO_COLOR'] = '1'
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
})
afterEach(() => vi.restoreAllMocks())

const ticks = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}

function world() {
  const release = Deferred.makeUnsafe<void>()
  const record: string[] = []
  const daemon: DaemonPort = {
    stopped: () => Effect.succeed('asked' as const),
    stop: () => Effect.sync(() => void record.push('daemon.stop')),
    stoppedProjections: [],
  }
  const stopping = daemonStopping({
    beacon: {
      say: async (word) => void record.push(`say ${word}`),
      stop: async (word) => void record.push(`beacon.stop ${word}`),
    },
    daemon,
    loop: () => ({
      stop: () =>
        Deferred.await(release).pipe(
          Effect.onInterrupt(() => Effect.sync(() => void record.push('interrupted'))),
          Effect.andThen(Effect.sync(() => void record.push('loop.stop'))),
        ),
    }),
    inFlight: () => Effect.succeed(['ticket-p-1']),
    clearListening: () => void record.push('clearListening'),
    services: Context.empty(),
    exit: (code) => void record.push(`exit ${code}`),
  })
  return { stopping, release, record }
}

describe('a SIGINT while a pass is in flight', () => {
  it('prints the draining lines once, and stops the daemon only after the pass finished', async () => {
    const { stopping, release, record } = world()
    stopping.onSignal('SIGINT')
    await ticks()

    const draining = lines.filter((l) => l.startsWith('draining —'))
    expect(draining).toHaveLength(1)
    expect(draining[0]).toContain('(ctrl-c)')
    expect(lines.filter((l) => l.includes('press ctrl-c again to stop now'))).toHaveLength(1)
    expect(record).toContain('say draining')
    // Waiting on the pass: nothing has been stopped.
    expect(record).not.toContain('daemon.stop')
    expect(record).not.toContain('beacon.stop stopping')

    Deferred.doneUnsafe(release, Effect.void)
    await ticks()
    expect(record.indexOf('loop.stop')).toBeLessThan(record.indexOf('beacon.stop stopping'))
    expect(record.indexOf('beacon.stop stopping')).toBeLessThan(record.indexOf('daemon.stop'))
    // The pass was never interrupted, and a drain does not exit the process itself.
    expect(record).not.toContain('interrupted')
    expect(record.some((r) => r.startsWith('exit'))).toBe(false)
  })

  it('a second press stops now, without waiting for the pass and without interrupting it', async () => {
    const { stopping, release, record } = world()
    stopping.onSignal('SIGINT')
    await ticks()
    stopping.onSignal('SIGINT')
    await ticks()

    expect(lines.some((l) => l.startsWith('stopping now'))).toBe(true)
    expect(record).toContain('daemon.stop')
    expect(record).toContain('exit 0')
    expect(record).not.toContain('loop.stop')
    expect(record).not.toContain('interrupted')
    expect(lines.filter((l) => l.startsWith('draining —'))).toHaveLength(1)
    Deferred.doneUnsafe(release, Effect.void)
  })
})
