import { generateKeyPairSync } from 'node:crypto'

import { accountStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { createGitHubClient, GitHubFailed, type Installation, makeGitHub } from '@lingtai/github'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { githubLimitPort, reachAccountLimit } from '../src/account.ts'

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const installation: Installation = {
  id: 1,
  permissions: {},
  account: 'o',
  repositorySelection: 'selected',
  htmlUrl: null,
  appSlug: null,
}
const auth = { appId: '1', privateKey }

/** Answers each non-token request from `replies` in turn, and counts what it was asked. */
const stub = (replies: Response[]) => {
  const seen: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    seen.push(String(url))
    if (String(url).includes('/access_tokens')) {
      return new Response(JSON.stringify({ token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() }), {
        status: 201,
      })
    }
    return replies.shift() ?? new Response('{}', { status: 200 })
  })
  return { seen, calls: () => seen.filter((u) => !u.includes('/access_tokens')).length }
}
const limited = () =>
  new Response(JSON.stringify({ message: 'slow down' }), { status: 429, headers: { 'retry-after': '60' } })
const branch = () => new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 })

afterEach(() => vi.unstubAllGlobals())

const make = (store: ReturnType<typeof createMemoryEventStore>, wait: boolean) =>
  makeGitHub({ auth, owner: 'o', repo: 'r', installation, onRateLimited: githubLimitPort(store, () => {}, { wait }) })

const locks = async (store: ReturnType<typeof createMemoryEventStore>) =>
  (await store.read(accountStream('github'))).filter((e) => e.type === 'AccountLimitReached').length

describe('a call the pass makes waits out the lock and is made again', () => {
  it('429 with retry-after 60 then 200: the second request is made at 60 s, with one lock appended', async () => {
    const store = createMemoryEventStore()
    const net = stub([limited(), branch()])
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const gh = yield* make(store, true)
        const fiber = yield* Effect.forkChild(gh.defaultBranch())
        yield* TestClock.adjust(59_000)
        expect(net.calls()).toBe(1)
        yield* TestClock.adjust(1_000)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(result).toBe('main')
    expect(net.calls()).toBe(2)
    expect(await locks(store)).toBe(1)
  })

  it('a standing lock whose until has passed still waits one minute, never zero', async () => {
    const store = createMemoryEventStore()
    await Effect.runPromise(
      reachAccountLimit(store, 'github', {
        until: new Date(-3_600_000).toISOString(),
        untilFrom: 'retry-after',
        said: 'old',
      }),
    )
    const net = stub([limited(), branch()])
    await Effect.runPromise(
      Effect.gen(function* () {
        const gh = yield* make(store, true)
        const fiber = yield* Effect.forkChild(gh.defaultBranch())
        yield* TestClock.adjust(59_000)
        expect(net.calls()).toBe(1)
        yield* TestClock.adjust(1_000)
        yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(net.calls()).toBe(2)
    expect(await locks(store)).toBe(1)
  })

  it('interrupting the fiber during the wait ends it without a second request', async () => {
    const store = createMemoryEventStore()
    const net = stub([limited(), branch()])
    await Effect.runPromise(
      Effect.gen(function* () {
        const gh = yield* make(store, true)
        const fiber = yield* Effect.forkChild(gh.defaultBranch())
        yield* TestClock.adjust(30_000)
        yield* Fiber.interrupt(fiber)
        yield* TestClock.adjust(120_000)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(net.calls()).toBe(1)
  })

  it('a store that cannot append answers fail even when waiting: no second request', async () => {
    const store = createMemoryEventStore()
    const broken = { ...store, append: async () => Promise.reject(new Error('down')) } as typeof store
    const net = stub([limited(), branch()])
    const failed = await Effect.runPromise(
      Effect.gen(function* () {
        const gh = yield* makeGitHub({
          auth,
          owner: 'o',
          repo: 'r',
          installation,
          onRateLimited: githubLimitPort(broken, () => {}, { wait: true }),
        })
        const out = yield* Effect.flip(gh.defaultBranch())
        yield* TestClock.adjust(600_000)
        return out
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(failed).toBeInstanceOf(GitHubFailed)
    expect(net.calls()).toBe(1)
  })
})

describe('the look keeps failing, the pass waits, over one client', () => {
  it('withRateLimited shares the installation lookup and the token', async () => {
    const store = createMemoryEventStore()
    const seen: string[] = []
    let rateLimited = 0
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(String(url))
      if (String(url).endsWith('/installation'))
        return new Response(
          JSON.stringify({ id: 1, permissions: {}, account: { login: 'o' }, repository_selection: 'selected' }),
          { status: 200 },
        )
      if (String(url).includes('/access_tokens'))
        return new Response(
          JSON.stringify({ token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
          { status: 201 },
        )
      // a 429 for the look, which reaches here first; then the pass's retry is answered
      return rateLimited++ < 2 ? limited() : branch()
    })
    const look = await createGitHubClient({
      auth,
      owner: 'o',
      repo: 'r',
      onRateLimited: githubLimitPort(store, () => {}, { wait: false }),
    })
    await expect(look.defaultBranch()).rejects.toMatchObject({ status: 429 })
    const pass = look.withRateLimited(githubLimitPort(store, () => {}, { wait: true }))
    vi.useFakeTimers()
    const done = pass.defaultBranch()
    await vi.advanceTimersByTimeAsync(61_000)
    vi.useRealTimers()
    await expect(done).resolves.toBe('main')
    expect(seen.filter((u) => u.endsWith('/repos/o/r/installation'))).toHaveLength(1)
    expect(seen.filter((u) => u.includes('/access_tokens'))).toHaveLength(1)
  })
})
