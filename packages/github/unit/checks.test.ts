/** The checks reads and the ready-for-review mutation (#1339), over a stubbed `fetch`. */
import { generateKeyPairSync } from 'node:crypto'

import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeGitHub, PermissionDenied, type AppAuth, type Installation } from '../src/index.ts'

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
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const token = () => json({ token: 'ghs_x', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201)

const github = (answer: (url: string, init: { method?: string; body?: string }) => Response) => {
  vi.stubGlobal('fetch', async (url: string, init: { method?: string; body?: string }) =>
    String(url).includes('/access_tokens') ? token() : answer(String(url), init),
  )
  return makeGitHub({ auth, owner: 'o', repo: 'r', installation })
}

describe('the checks reads and the ready mutation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads the check runs by the fields named', async () => {
    const runs = await Effect.runPromise(
      Effect.flatMap(
        github(() =>
          json({
            check_runs: [
              {
                name: 'test',
                status: 'completed',
                conclusion: 'success',
                html_url: 'u',
                started_at: 's',
                completed_at: 'c',
              },
              { name: 'lint', status: 'in_progress', conclusion: null, html_url: 'v' },
            ],
          }),
        ),
        (g) => g.checkRunsAt('abc'),
      ),
    )
    expect(runs.map((r) => [r.name, r.status, r.conclusion])).toEqual([
      ['test', 'completed', 'success'],
      ['lint', 'in_progress', null],
    ])
  })

  it('a 403 on the check-runs read is PermissionDenied naming checks', async () => {
    const err = await Effect.runPromise(
      Effect.flip(
        Effect.flatMap(
          github(() => json({ message: 'Resource not accessible by integration' }, 403)),
          (g) => g.checkRunsAt('abc'),
        ),
      ),
    )
    expect(err).toBeInstanceOf(PermissionDenied)
    expect((err as PermissionDenied).permission).toBe('checks')
  })

  it('a 403 on the status read names statuses', async () => {
    const err = await Effect.runPromise(
      Effect.flip(
        Effect.flatMap(
          github(() => json({ message: 'nope' }, 403)),
          (g) => g.combinedStatusAt('abc'),
        ),
      ),
    )
    expect((err as PermissionDenied).permission).toBe('statuses')
  })

  it('total_count 0 is no statuses', async () => {
    const combined = await Effect.runPromise(
      Effect.flatMap(
        github(() => json({ state: 'pending', total_count: 0, statuses: [] })),
        (g) => g.combinedStatusAt('abc'),
      ),
    )
    expect(combined).toEqual({ total: 0, statuses: [] })
  })

  it('reads every page of statuses and fails on a short count', async () => {
    const page = (n: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({ context: `c${n}-${i}`, state: 'success', target_url: null }))
    const g = github((url) => json({ total_count: 31, statuses: url.endsWith('&page=1') ? page(1, 30) : page(2, 1) }))
    const combined = await Effect.runPromise(Effect.flatMap(g, (x) => x.combinedStatusAt('abc')))
    expect(combined.statuses).toHaveLength(31)
    const short = await Effect.runPromise(
      Effect.flip(
        Effect.flatMap(
          github((url) => json({ total_count: 31, statuses: url.endsWith('&page=1') ? page(1, 30) : [] })),
          (x) => x.combinedStatusAt('abc'),
        ),
      ),
    )
    expect(short.message).toContain('30 of 31')
  })

  it('marks ready through GraphQL with the node id', async () => {
    let sent: { method?: string; body?: string; url: string } | null = null
    await Effect.runPromise(
      Effect.flatMap(
        github((url, init) => {
          sent = { ...init, url }
          return json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } })
        }),
        (g) => g.markReadyForReview('PR_7'),
      ),
    )
    expect(sent!.url).toContain('/graphql')
    expect(JSON.parse(sent!.body!).variables).toEqual({ id: 'PR_7' })
  })

  it('an HTTP 200 with errors is a failure, never a success', async () => {
    const err = await Effect.runPromise(
      Effect.flip(
        Effect.flatMap(
          github(() => json({ data: null, errors: [{ type: 'UNPROCESSABLE', message: 'not a draft' }] })),
          (g) => g.markReadyForReview('PR_7'),
        ),
      ),
    )
    expect(err.message).toContain('not a draft')
  })
})
