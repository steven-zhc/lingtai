/**
 * #839. A projection other than `task_view` that throws stops alone, live or at
 * start, and the daemon keeps conducting. The fake runner does what the real one
 * does — `onError`, then `failure`, then a rejected `start()` — because a fake
 * that only rejects tests an order production never produces.
 */
import type { Projection, ProjectionRunnerPort } from '@lingtai/projector'
import { ProjectionShapeError } from '@lingtai/projector'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { notTakingWork } from '../src/daemon.ts'
import { startDaemon } from '../test/promise-faces.ts'

const base = {
  predatesHold: async () => null,
  watermark: async () => 0,
  acquire: async () => ({ ok: true as const, lock: { release: async () => {} } }),
}

const projection = (name: string): Projection => ({ name }) as Projection

interface Fake {
  runner: ProjectionRunnerPort
  fail(error: unknown): void
}

function fakes(opts: { throwAtStart?: readonly string[]; shape?: string; checkpoint?: bigint } = {}) {
  const made = new Map<string, Fake>()
  const runnerFor = (p: Projection, onError: (error: unknown, phase: string) => void): ProjectionRunnerPort => {
    let failure: unknown = null
    let running = false
    const runner = {
      name: p.name,
      get failure() {
        return failure
      },
      get running() {
        return running
      },
      start: () =>
        Effect.gen(function* () {
          if (opts.shape === p.name) return yield* Effect.fail(new ProjectionShapeError(p.name, []))
          if (opts.throwAtStart?.includes(p.name)) {
            failure = new Error(`${p.name} reduce`)
            onError(failure, 'handler')
            return yield* Effect.fail(new Error('subscription stopped before it caught up'))
          }
          running = true
        }),
      stop: () =>
        Effect.sync(() => {
          running = false
        }),
      close: () => Effect.void,
      lag: () => Effect.succeed({ name: p.name, lastSeq: opts.checkpoint ?? 41n, headSeq: 50n, lag: 9n }),
    } as unknown as ProjectionRunnerPort
    made.set(p.name, {
      runner,
      fail: (error) => {
        failure = error
        running = false
        onError(error, 'handler')
      },
    })
    return runner
  }
  return { runnerFor, made }
}

describe('a stopped projection', () => {
  it('a projection that throws during catch-up at start leaves the daemon up', async () => {
    const { runnerFor } = fakes({ throwAtStart: ['spend'] })
    const started = await startDaemon({
      ...base,
      projections: [projection('task_view'), projection('spend'), projection('finding_backlog')],
      runnerFor,
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.daemon.stoppedProjections).toEqual([
      { name: 'spend', checkpoint: 41n, error: 'Error: spend reduce' },
    ])
    started.daemon.stop()
    expect(await started.daemon.stopped).toBe('asked')
  })

  it('a projection that throws live stops alone', async () => {
    const { runnerFor, made } = fakes()
    const started = await startDaemon({ ...base, projections: [projection('spend')], runnerFor })
    if (!started.ok) throw new Error('did not start')
    made.get('spend')!.fail(new Error('boom'))
    await new Promise((r) => setTimeout(r, 0))
    let settled = false
    void started.daemon.stopped.then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBe(false)
    expect(started.daemon.stoppedProjections.map((p) => p.name)).toEqual(['spend'])
    started.daemon.stop()
    await started.daemon.stopped
  })

  it('a stopped task_view leaves the daemon up', async () => {
    const live = fakes()
    const started = await startDaemon({ ...base, projections: [projection('task_view')], runnerFor: live.runnerFor })
    if (!started.ok) throw new Error('did not start')
    let settled = false
    void started.daemon.stopped.then(() => (settled = true))
    live.made.get('task_view')!.fail(new Error('boom'))
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBe(false)
    expect(started.daemon.stoppedProjections.map((p) => p.name)).toEqual(['task_view'])
    expect(notTakingWork(started.daemon.stoppedProjections)).toContain('not taking work')
    started.daemon.stop()
    await started.daemon.stopped

    const atStart = fakes({ throwAtStart: ['task_view'] })
    const again = await startDaemon({
      ...base,
      projections: [projection('task_view')],
      runnerFor: atStart.runnerFor,
    })
    if (!again.ok) throw new Error('did not start')
    expect(again.daemon.stoppedProjections.map((p) => p.name)).toEqual(['task_view'])
    again.daemon.stop()
    await again.daemon.stopped
  })

  it('notTakingWork is null until task_view is on the list, and names an unread checkpoint', () => {
    expect(notTakingWork([])).toBeNull()
    expect(notTakingWork([{ name: 'spend', checkpoint: 1n, error: 'x' }])).toBeNull()
    expect(notTakingWork([{ name: 'task_view', checkpoint: null, error: 'x' }])).toContain('an unread checkpoint')
    expect(notTakingWork([{ name: 'task_view', checkpoint: 7n, error: 'x' }])).toContain('seq 7')
    // The rebuild refuses while a daemon holds the lock (0100 §13), so the remedy shuts down first.
    expect(notTakingWork([{ name: 'task_view', checkpoint: 7n, error: 'x' }])).toMatch(
      /lingtai shutdown.*lingtai projection rebuild task_view.*lingtai start/,
    )
  })

  it('a shape drift at start stops that projection alone and the daemon comes up', async () => {
    const { runnerFor } = fakes({ shape: 'spend' })
    const result = await startDaemon({
      ...base,
      projections: [projection('spend'), projection('task_view')],
      runnerFor,
    })
    if (!result.ok) throw new Error('the daemon should have come up')
    expect(result.daemon.stoppedProjections.map((s) => s.name)).toEqual(['spend'])
    await result.daemon.stop()
  })
})
