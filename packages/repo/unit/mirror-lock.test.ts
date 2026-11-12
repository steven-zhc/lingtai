import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Cause, Effect, Exit, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import { RepoFailed } from '../src/git.ts'
import { integrateEffect } from '../src/integrate.ts'
import { mirrorWrite } from '../src/mirror-lock.ts'

const integrate = (options: Parameters<typeof integrateEffect>[0]) => Effect.runPromise(integrateEffect(options))

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

/** An outside holder: a root fiber, so it starts with nothing held. */
const write = <A>(path: string, run: () => Promise<A>) => Effect.runPromise(mirrorWrite(path, Effect.promise(run)))

describe('the mirror write permit (0122 §6, #1026)', () => {
  it('runs writers on one path one after the other, in order, neither refused', async () => {
    const log: string[] = []
    const latch = deferred()
    const first = write('/m/a.git', () => latch.promise.then(() => void log.push('first')))
    const second = write('/m/a.git', () => Promise.resolve().then(() => void log.push('second')))
    await settle()
    expect(log).toEqual([])
    latch.resolve()
    await Promise.all([first, second])
    expect(log).toEqual(['first', 'second'])
  })

  it('lets writers on two paths overlap, and resolves equal paths to one key', async () => {
    const latch = deferred()
    const held = write('/m/a.git', () => latch.promise)
    let other = false
    await write('/m/b.git', () => Promise.resolve().then(() => void (other = true)))
    expect(other).toBe(true)
    let same = false
    const behind = write('/m/x/../a.git', () => Promise.resolve().then(() => void (same = true)))
    await settle()
    expect(same).toBe(false)
    latch.resolve()
    await Promise.all([held, behind])
    expect(same).toBe(true)
  })

  it('releases when a writer rejects or throws', async () => {
    await expect(write('/m/a.git', () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    await expect(Effect.runPromise(mirrorWrite('/m/a.git', Effect.die(new Error('boom'))))).rejects.toThrow('boom')
    await expect(write('/m/a.git', () => Promise.resolve(7))).resolves.toBe(7)
  })

  it('releases when an Effect writer is interrupted while queued, and the one behind runs', async () => {
    const latch = deferred()
    const held = write('/m/a.git', () => latch.promise)
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
    const last = write('/m/a.git', () => Promise.resolve().then(() => void (behind = true)))
    latch.resolve()
    await Promise.all([held, interrupting, last])
    expect(ran).toBe(false)
    expect(behind).toBe(true)
  })

  it('releases an Effect writer that fails', async () => {
    await expect(Effect.runPromise(mirrorWrite('/m/a.git', Effect.fail('no')))).rejects.toBeDefined()
    await expect(write('/m/a.git', () => Promise.resolve(1))).resolves.toBe(1)
  })

  it('refuses its own holder at once, naming the mirror, and the writer behind it runs', async () => {
    const latch = deferred()
    let behind = false
    const outer = Effect.runPromiseExit(
      mirrorWrite(
        '/m/x/../n.git',
        Effect.gen(function* () {
          yield* Effect.promise(() => latch.promise)
          yield* mirrorWrite('/m/n.git', Effect.void)
        }),
      ),
    )
    const last = write('/m/n.git', () => Promise.resolve().then(() => void (behind = true)))
    latch.resolve()
    const exit = await outer
    await last
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(Cause.squash((exit as Exit.Failure<unknown, unknown>).cause))).toContain('/m/n.git')
    expect(behind).toBe(true)
  })

  it('lets a holder of one mirror ask for another', async () => {
    const log: string[] = []
    await Effect.runPromise(
      mirrorWrite(
        '/m/a.git',
        mirrorWrite(
          '/m/b.git',
          Effect.sync(() => void log.push('both')),
        ),
      ),
    )
    expect(log).toEqual(['both'])
  })

  it('refuses a fiber forked inside the holder while it is held', async () => {
    const exit = await Effect.runPromiseExit(
      mirrorWrite(
        '/m/f.git',
        Effect.gen(function* () {
          const child = yield* Effect.forkChild(mirrorWrite('/m/f.git', Effect.void))
          yield* Fiber.join(child)
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it('queues, not refuses, a daemon fiber that asks after the holder released', async () => {
    const gate = deferred()
    let ran = false
    const outer = Effect.gen(function* () {
      return yield* Effect.forkDetach(
        Effect.promise(() => gate.promise).pipe(
          Effect.andThen(
            mirrorWrite(
              '/m/d.git',
              Effect.sync(() => void (ran = true)),
            ),
          ),
        ),
      )
    })
    const child = await Effect.runPromise(mirrorWrite('/m/d.git', outer))
    gate.resolve()
    await Effect.runPromise(Fiber.join(child))
    expect(ran).toBe(true)
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
    const otherHold = write('/fake-home/repos/another.git', () => other.promise)
    const free: string[][] = []
    const unblocked = land(lazyGit(free))
    await settle()
    expect(free.some((c) => c[0] === 'fetch')).toBe(true)
    other.resolve()
    await Promise.all([otherHold, unblocked])

    const latch = deferred()
    const hold = write('/fake-home/repos/permit-fixture.git', () => latch.promise)
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
        void write('/fake-home/repos/permit-fixture.git', () => Promise.resolve().then(() => void (got = true)))
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
