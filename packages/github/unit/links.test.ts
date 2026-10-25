/**
 * Sub-issue and blocked-by links: the number→id lookup, the paging, and the 403.
 *
 * The HTTP is stubbed, and every fixture's `id` differs from its `number`, so a
 * number sent where the id belongs (or the two swapped) fails here rather than
 * naming another repository's issue in production. As in `client.test.ts`, a
 * stub written by the same hand cannot catch a misspelled field name such as
 * `sub_issue_id`; the first live run of the split writer is that check, and a
 * wrong key there is a 422.
 */
import { generateKeyPairSync } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createGitHubClient, GitHubError, PermissionDenied, type AppAuth, type Installation } from '../src/index.ts'

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const auth: AppAuth = { appId: '123456', privateKey }
const installation: Installation = {
  id: 1,
  permissions: {},
  account: 'steven-zhc',
  repositorySelection: 'selected',
  htmlUrl: null,
}

interface Call {
  method: string
  path: string
  body: unknown
}

type Reply = { status: number; json: unknown }

/** Routes by `METHOD path` (query included), recording everything but the token request. */
function stub(routes: Record<string, Reply | Reply[]>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url)
    if (u.includes('/access_tokens')) {
      return new Response(
        JSON.stringify({ token: 'ghs_x', expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    }
    const path = u.replace('https://api.github.com', '')
    const method = init?.method ?? 'GET'
    calls.push({ method, path, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
    const hit = routes[`${method} ${path}`]
    if (hit === undefined) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
    const reply = Array.isArray(hit) ? hit.shift()! : hit
    return new Response(JSON.stringify(reply.json), { status: reply.status })
  })
  return calls
}

function linked(number: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: number * 1_000_003,
    number,
    title: `ticket ${number}`,
    body: '',
    labels: [],
    state: 'open',
    html_url: `https://example.invalid/${number}`,
    repository_url: 'https://api.github.com/repos/steven-zhc/lingtai',
    ...over,
  }
}

const REPO = '/repos/steven-zhc/lingtai'

describe('sub-issue and blocked-by links', () => {
  afterEach(() => vi.unstubAllGlobals())

  async function client() {
    return createGitHubClient({ auth, owner: 'steven-zhc', repo: 'lingtai', installation })
  }

  it('attaches a sub-issue: the path carries the parent number, the body the child id as a number', async () => {
    const calls = stub({
      [`GET ${REPO}/issues/161`]: { status: 200, json: { id: 5466453198, number: 161 } },
      [`POST ${REPO}/issues/599/sub_issues`]: { status: 201, json: {} },
    })

    await (await client()).addSubIssue(599, 161)

    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: `${REPO}/issues/599/sub_issues`,
      body: { sub_issue_id: 5466453198 },
    })
  })

  it('adds a blocked-by link: the path carries the blocked number, the body the blocker id', async () => {
    const calls = stub({
      [`GET ${REPO}/issues/161`]: { status: 200, json: { id: 5466453198, number: 161 } },
      [`POST ${REPO}/issues/164/dependencies/blocked_by`]: { status: 201, json: {} },
    })

    await (await client()).addBlockedBy(164, 161)

    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: `${REPO}/issues/164/dependencies/blocked_by`,
      body: { issue_id: 5466453198 },
    })
    expect(typeof (calls.at(-1)!.body as { issue_id: unknown }).issue_id).toBe('number')
  })

  it('throws when the number does not name an issue, and posts nothing', async () => {
    const calls = stub({})

    await expect((await client()).addSubIssue(599, 9999)).rejects.toMatchObject({ status: 404 })

    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('lists across pages until a short one, carrying the repository of each', async () => {
    const first = Array.from({ length: 100 }, (_, i) => linked(i + 1))
    const second = [linked(101), linked(12, { repository_url: 'https://api.github.com/repos/other/repo' })]
    const calls = stub({
      [`GET ${REPO}/issues/599/sub_issues?per_page=100&page=1`]: { status: 200, json: first },
      [`GET ${REPO}/issues/599/sub_issues?per_page=100&page=2`]: { status: 200, json: second },
    })

    const out = await (await client()).listSubIssues(599)

    expect(out).toHaveLength(102)
    expect(calls).toHaveLength(2)
    expect(out[0]!.repository).toBe('steven-zhc/lingtai')
    expect(out[101]).toMatchObject({ number: 12, repository: 'other/repo' })
  })

  it('lists what blocks an issue', async () => {
    stub({
      [`GET ${REPO}/issues/164/dependencies/blocked_by?per_page=100&page=1`]: { status: 200, json: [linked(161)] },
    })

    expect(await (await client()).listBlockedBy(164)).toMatchObject([{ number: 161, title: 'ticket 161' }])
  })

  it('never reads a 404 on a list as an empty one', async () => {
    stub({})

    await expect((await client()).listSubIssues(599)).rejects.toMatchObject({ status: 404 })
  })

  it('surfaces a 403 as PermissionDenied naming the permission, on a read and a write', async () => {
    stub({
      [`GET ${REPO}/issues/599/sub_issues?per_page=100&page=1`]: {
        status: 403,
        json: { message: 'Resource not accessible by integration' },
      },
      [`GET ${REPO}/issues/161`]: { status: 200, json: { id: 5466453198 } },
      [`POST ${REPO}/issues/599/sub_issues`]: {
        status: 403,
        json: { message: 'Resource not accessible by integration' },
      },
    })
    const c = await client()

    const read = await c.listSubIssues(599).catch((e: unknown) => e)
    const write = await c.addSubIssue(599, 161).catch((e: unknown) => e)

    expect(read).toBeInstanceOf(PermissionDenied)
    expect(read).toBeInstanceOf(GitHubError)
    expect((read as PermissionDenied).message).toMatch(/`issues`.*`read`/)
    expect(write).toBeInstanceOf(PermissionDenied)
    expect((write as PermissionDenied).message).toMatch(/`issues`.*`write`/)
  })

  it('leaves a secondary rate limit as the GitHubError it was', async () => {
    stub({
      [`GET ${REPO}/issues/599/sub_issues?per_page=100&page=1`]: {
        status: 403,
        json: { message: 'You have exceeded a secondary rate limit.' },
      },
    })

    const err = await (await client()).listSubIssues(599).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(GitHubError)
    expect(err).not.toBeInstanceOf(PermissionDenied)
  })
})
