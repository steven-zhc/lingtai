/**
 * The Effect-shaped client and its promise face (#1025): one failure type, one
 * token cache per client, and a rejection that is the `GitHubFailed` itself.
 */
import { generateKeyPairSync } from 'node:crypto'

import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  appInstallationsEffect,
  createGitHubClient,
  GitHubFailed,
  makeGitHub,
  type AppAuth,
  type AppReader,
  type Installation,
} from '../src/index.ts'

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const auth: AppAuth = { appId: '123456', privateKey }
const installation: Installation = {
  id: 1,
  permissions: {},
  account: 'o',
  repositorySelection: 'selected',
  htmlUrl: null,
  appSlug: null,
}
const options = { auth, owner: 'o', repo: 'r', installation }

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const token = () => json({ token: 'ghs_x', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201)
const issue = { number: 1, title: 't', body: '', labels: [], state: 'open', html_url: 'https://example.invalid/1' }

describe('the GitHub client as Effects', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks for one token across several calls', async () => {
    let tokens = 0
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('/access_tokens')) {
        tokens++
        return token()
      }
      return String(url).includes('state=open') ? json([issue]) : json(issue)
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* makeGitHub(options)
        yield* github.getIssue(1)
        yield* github.getIssue(1)
        yield* github.listOpenIssues()
        yield* github.listOpenIssues()
      }),
    )

    expect(tokens).toBe(1)
  })

  it('fails a 404 with a GitHubFailed the Effect side can catch by tag, and the face rejects with', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      String(url).includes('/access_tokens') ? token() : json({ message: 'Not Found' }, 404),
    )

    const caught = await Effect.runPromise(
      Effect.gen(function* () {
        const github = yield* makeGitHub(options)
        return yield* github.getIssue(1).pipe(Effect.catchTag('GitHubFailed', (e) => Effect.succeed(e.status)))
      }),
    )
    expect(caught).toBe(404)

    const error = (await (await createGitHubClient(options)).getIssue(1).catch((e: unknown) => e)) as GitHubFailed
    expect(error).toBeInstanceOf(GitHubFailed)
    expect(error.status).toBe(404)
    expect(error.message).toBe('404 on /repos/o/r/issues/1: Not Found')
  })

  it('turns a fetch that rejects into a GitHubFailed with status 0', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('/access_tokens')) return token()
      throw new TypeError('fetch failed')
    })

    const error = (await (await createGitHubClient(options)).getIssue(1).catch((e: unknown) => e)) as GitHubFailed
    expect(error).toBeInstanceOf(GitHubFailed)
    expect(error.status).toBe(0)
    expect(error.message).toBe('0 on /repos/o/r/issues/1: fetch failed')
  })

  it('aborts the fetch signal when interrupted after the headers, while the body is streaming', async () => {
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (String(url).includes('/access_tokens')) return token()
      signal = init.signal ?? undefined
      // Headers arrive; the body never does until aborted.
      const body = new ReadableStream({
        start(controller) {
          init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
        },
      })
      return new Response(body, { status: 200 })
    })
    const controller = new AbortController()
    const client = await createGitHubClient(options)
    const pending = client.getIssue(1, controller.signal).catch((e: unknown) => e)
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await pending
    expect(signal?.aborted).toBe(true)
  })

  it('fails a null rejection from an AppReader with a GitHubFailed, not a defect', async () => {
    const reader = { request: () => Promise.reject(null) } as unknown as AppReader
    const error = await Effect.runPromise(Effect.flip(appInstallationsEffect(reader)))
    expect(error).toBeInstanceOf(GitHubFailed)
    expect(error.status).toBe(0)
  })
})
