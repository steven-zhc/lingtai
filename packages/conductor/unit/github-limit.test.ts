import { generateKeyPairSync } from 'node:crypto'

import { accountStream, reduceAccount } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { forgetGitHubAuthCache, createGitHubClient, GitHubFailed, type Installation } from '@lingtai/github'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { githubLimitPort } from '../src/account.ts'

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

const answer = (status: number, headers: Record<string, string>, message: string) =>
  vi.stubGlobal('fetch', async (url: string) =>
    String(url).includes('/access_tokens')
      ? new Response(JSON.stringify({ token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() }), {
          status: 201,
        })
      : new Response(JSON.stringify({ message }), { status: status, headers }),
  )

beforeEach(() => forgetGitHubAuthCache())

afterEach(() => vi.unstubAllGlobals())

const client = (onRateLimited: ReturnType<typeof githubLimitPort>) =>
  createGitHubClient({ auth: { appId: '1', privateKey }, owner: 'o', repo: 'r', installation, onRateLimited })

describe('a rate limit locks acct-github', () => {
  it('appends once, fails with the original error, and a second call appends nothing', async () => {
    const store = createMemoryEventStore()
    const reset = String(Math.floor(Date.now() / 1000) + 1800)
    answer(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }, 'API rate limit exceeded')
    const c = await client(githubLimitPort(store, () => {}))
    await expect(c.defaultBranch()).rejects.toBeInstanceOf(GitHubFailed)
    await expect(c.defaultBranch()).rejects.toBeInstanceOf(GitHubFailed)
    const events = await store.read(accountStream('github'))
    expect(events.filter((e) => e.type === 'AccountLimitReached')).toHaveLength(1)
    expect(reduceAccount(events).limit?.untilFrom).toBe('ratelimit-reset')
  })
  it('a permission 403 appends nothing', async () => {
    const store = createMemoryEventStore()
    answer(403, { 'x-ratelimit-remaining': '42' }, 'Resource not accessible by integration')
    const c = await client(githubLimitPort(store, () => {}))
    await expect(c.defaultBranch()).rejects.toBeInstanceOf(GitHubFailed)
    expect(await store.read(accountStream('github'))).toHaveLength(0)
  })
  it('a store that cannot append never changes the error', async () => {
    const store = createMemoryEventStore()
    const broken = { ...store, append: async () => Promise.reject(new Error('down')) } as typeof store
    const lines: string[] = []
    answer(429, { 'retry-after': '90' }, 'slow down')
    const c = await client(githubLimitPort(broken, (l) => lines.push(l)))
    await expect(c.defaultBranch()).rejects.toMatchObject({ status: 429 })
    expect(lines.length).toBeGreaterThan(0)
  })
  it('a token mint refused for rate locks through client.token() too', async () => {
    const store = createMemoryEventStore()
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ message: 'slow down' }), { status: 429, headers: { 'retry-after': '90' } }),
    )
    const c = await client(githubLimitPort(store, () => {}))
    await expect(c.token()).rejects.toMatchObject({ status: 429 })
    expect((await store.read(accountStream('github'))).filter((e) => e.type === 'AccountLimitReached')).toHaveLength(1)
  })
})
