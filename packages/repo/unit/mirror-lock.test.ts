import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import { RepoFailed } from '../src/git.ts'
import { integrateEffect } from '../src/integrate.ts'
import { mirrorWrite, withMirrorWrite } from '../src/mirror-lock.ts'

const integrate = (options: Parameters<typeof integrateEffect>[0]) => Effect.runPromise(integrateEffect(options))

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('the mirror write permit (0122 §6, #1026)', () => {
  it('runs writers on one path one after the other, in order', async () => {
    const log: string[] = []
    const latch = deferred()
    const first = withMirrorWrite('/m/a.git', () => latch.promise.then(() => void log.push('first')))
    const second = withMirrorWrite('/m/a.git', () => Promise.resolve().then(() => void log.push('second')))
    await settle()
    expect(log).toEqual([])
    latch.resolve()
    await Promise.all([first, second])
    expect(log).toEqual(['first', 'second'])
  })

  it('lets writers on two paths overlap, and resolves equal paths to one key', async () => {
    const latch = deferred()
    const held = withMirrorWrite('/m/a.git', () => latch.promise)
    let other = false
    await withMirrorWrite('/m/b.git', () => Promise.resolve().then(() => void (other = true)))
    expect(other).toBe(true)
    let same = false
    const behind = withMirrorWrite('/m/x/../a.git', () => Promise.resolve().then(() => void (same = true)))
    await settle()
    expect(same).toBe(false)
    latch.resolve()
    await Promise.all([held, behind])
    expect(same).toBe(true)
  })

  it('releases when a writer rejects or throws synchronously', async () => {
    await expect(withMirrorWrite('/m/a.git', () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    await expect(
      withMirrorWrite('/m/a.git', () => {
        throw new Error('sync')
      }),
    ).rejects.toThrow('sync')
    await expect(withMirrorWrite('/m/a.git', () => Promise.resolve(7))).resolves.toBe(7)
  })

  it('releases when an Effect writer is interrupted while queued, and the one behind runs', async () => {
    const latch = deferred()
    const held = withMirrorWrite('/m/a.git', () => latch.promise)
    let ran = false
    const fiber = Effect.runFork(
      mirrorWrite(
        '/m/a.git',
        Effect.sync(() => void (ran = true)),
      ),
    )
    await settle()
    const interrupting = Effect.runPromise(Fiber.interrupt(fiber))
    let behind = false
    const last = withMirrorWrite('/m/a.git', () => Promise.resolve().then(() => void (behind = true)))
    latch.resolve()
    await Promise.all([held, interrupting, last])
    expect(ran).toBe(false)
    expect(behind).toBe(true)
  })

  it('releases an Effect writer that fails', async () => {
    await expect(Effect.runPromise(mirrorWrite('/m/a.git', Effect.fail('no')))).rejects.toBeDefined()
    await expect(withMirrorWrite('/m/a.git', () => Promise.resolve(1))).resolves.toBe(1)
  })
})

/** Lazy, like the real port: a call is recorded when the Effect runs, not when it is built. */
const lazyGit = (calls: string[][], onMerge?: () => Effect.Effect<string>) => (args: string[]) =>
  Effect.suspend((): Effect.Effect<string, RepoFailed> => {
    calls.push([...args])
    if (args[0] === 'merge' && args[1] !== '--abort' && onMerge) return onMerge()
    if (args[0] === 'rev-parse') return Effect.succeed('1'.repeat(40))
    if (args[0] === 'rev-list') return Effect.succeed('1')
    return Effect.succeed('')
  })

const land = (git: ReturnType<typeof lazyGit>) =>
  integrate({
    project: 'permit-fixture',
    owner: 'o',
    repo: 'r',
    base: 'main',
    branch: 'agent/1',
    ticketId: 't',
    headSha: '0'.repeat(40),
    stepsPassed: true,
    home: '/fake-home',
    store: createMemoryEventStore(),
    git,
  })

describe('the landing takes the permit per command, never across its scope', () => {
  it('waits for a held mirror write on its own mirror, not on another', async () => {
    const other = deferred()
    const otherHold = withMirrorWrite('/fake-home/repos/another.git', () => other.promise)
    const free: string[][] = []
    const unblocked = land(lazyGit(free))
    await settle()
    expect(free.some((c) => c[0] === 'fetch')).toBe(true)
    other.resolve()
    await Promise.all([otherHold, unblocked])

    const latch = deferred()
    const hold = withMirrorWrite('/fake-home/repos/permit-fixture.git', () => latch.promise)
    const blocked: string[][] = []
    const blockedRun = land(lazyGit(blocked))
    await settle()
    expect(blocked.some((c) => c[0] === 'fetch')).toBe(false)
    latch.resolve()
    await Promise.all([hold, blockedRun])
    expect(blocked.some((c) => c[0] === 'fetch')).toBe(true)
  })

  it('holds no permit while the merge runs', async () => {
    let probed: boolean | undefined
    const calls: string[][] = []
    const git = lazyGit(calls, () =>
      Effect.promise(() => {
        let got = false
        void withMirrorWrite('/fake-home/repos/permit-fixture.git', () =>
          Promise.resolve().then(() => void (got = true)),
        )
        return settle().then(() => {
          probed = got
          return ''
        })
      }),
    )
    await land(git)
    expect(calls.some((c) => c[0] === 'merge')).toBe(true)
    expect(probed).toBe(true)
  })
})
