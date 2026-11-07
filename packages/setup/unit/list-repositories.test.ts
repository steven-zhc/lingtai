/**
 * `listRepositories` (#969, moved from the conductor's `pick-repository.ts`):
 * the App's installations, or what the `gh` login can push to.
 *
 * No network and no `gh`: the App reader is a fake that answers `GET`s from a
 * fixture and **fails any other method**, and the `gh` reader and status are
 * fakes too, so every test here is also the test that nothing is written.
 */
import type { ProjectState } from '@lingtai/domain'
import { GitHubError, type GhReader, type GhStatus } from '@lingtai/github'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { listRepositories } from '../src/index.ts'

const WRITE = { issues: 'write', contents: 'write', pull_requests: 'write', workflows: 'write', metadata: 'read' }

interface FakeInstallation {
  id: number
  account: string
  selection?: 'all' | 'selected'
  permissions?: Record<string, string>
  repositories: string[]
}

function fakeReader(installations: FakeInstallation[], suspended: number[] = []) {
  const calls: string[] = []
  return {
    calls,
    async request<T>(method: string, path: string, as: 'app' | number): Promise<T> {
      calls.push(`${method} ${path} as ${as}`)
      if (method !== 'GET') throw new Error(`the picker wrote to GitHub: ${method} ${path}`)
      const url = new URL(path, 'https://api.github.com')
      const page = Number(url.searchParams.get('page') ?? '1')
      const raw = (i: FakeInstallation) => ({
        id: i.id,
        permissions: i.permissions ?? WRITE,
        account: { login: i.account },
        repository_selection: i.selection ?? 'selected',
        html_url: `https://github.com/settings/installations/${i.id}`,
      })
      if (url.pathname === '/app/installations' && as === 'app') {
        return (page === 1 ? installations.map(raw) : []) as T
      }
      const one = /^\/app\/installations\/(\d+)$/.exec(url.pathname)
      if (one && as === 'app') {
        const found = installations.find((i) => i.id === Number(one[1]))
        if (found === undefined) throw new GitHubError(404, path, 'Not Found')
        return raw(found) as T
      }
      if (url.pathname === '/installation/repositories' && typeof as === 'number') {
        // A suspended installation's token is refused before any listing.
        if (suspended.includes(as))
          throw new GitHubError(403, `/app/installations/${as}/access_tokens`, 'This installation has been suspended')
        const i = installations.find((x) => x.id === as)!
        return {
          repositories: (page === 1 ? i.repositories : []).map((name) => ({
            name,
            owner: { login: i.account },
            private: true,
          })),
        } as T
      }
      throw new GitHubError(404, path, 'Not Found')
    },
  }
}

const project = (name: string, owner: string | null, configHash: string | null): ProjectState => ({
  project: name,
  owner,
  base: 'main',
  configHash,
  fromSha: null,
  refused: null,
  version: 1,
  lastSeq: 1n,
})

/** The App machine's list, run. */
async function listApp(o: {
  reader: ReturnType<typeof fakeReader>
  projects: readonly ProjectState[]
  installUrl: string | null
}) {
  const out = await Effect.runPromise(
    listRepositories({ auth: 'app', projects: o.projects, app: { reader: o.reader, installUrl: o.installUrl } }),
  )
  if (out.kind !== 'app') throw new Error('expected the App list')
  return out.picker
}

const INSTALL = 'https://github.com/apps/lingtai-steven/installations/new'

describe('listRepositories on an App machine', () => {
  it('lists what each installation can see, with GET and nothing else', async () => {
    const reader = fakeReader([
      { id: 7, account: 'steven-zhc', repositories: ['lingtai', 'nextloom-ai-admin'] },
      { id: 9, account: 'acme', selection: 'all', repositories: ['app'] },
    ])

    const picker = await listApp({ reader, projects: [], installUrl: INSTALL })

    expect(picker.installations.map((l) => l.repositories.map((r) => r.slug))).toEqual([
      ['steven-zhc/lingtai', 'steven-zhc/nextloom-ai-admin'],
      ['acme/app'],
    ])
    expect(picker.installations[0]!.installation.htmlUrl).toBe('https://github.com/settings/installations/7')
    expect(reader.calls.every((c) => c.startsWith('GET '))).toBe(true)
    // The blunt endpoint, with the installation's token — there is no user token to use the finer one.
    expect(reader.calls).toContain('GET /installation/repositories?per_page=100&page=1 as 7')
  })

  it('is an empty list with an install link carrying a state when nothing is installed', async () => {
    const picker = await listApp({ reader: fakeReader([]), projects: [], installUrl: INSTALL })

    expect(picker.installations).toEqual([])
    const link = new URL(picker.installUrl!)
    expect(`${link.origin}${link.pathname}`).toBe(INSTALL)
    expect(link.searchParams.get('state')).toMatch(/^[\w-]{16,}$/)
  })

  it('still calls an ownerless project onboarded when one account has the name and every installation answered', async () => {
    const reader = fakeReader([{ id: 7, account: 'steven-zhc', repositories: ['lingtai'] }])

    const picker = await listApp({ reader, projects: [project('lingtai', null, 'abc')], installUrl: INSTALL })

    expect(picker.installations[0]!.repositories[0]!.onboarded).toBe('registered')
  })
})

const OK: GhStatus = { ok: true, login: 'me', scopes: ['repo', 'workflow'] }

interface Entry {
  name: string
  owner: { login: string }
  private: boolean
  archived?: boolean | null
  permissions?: { push?: boolean } | null
}

const entry = (name: string, extra: Partial<Entry> = {}, owner = 'me'): Entry => ({
  name,
  owner: { login: owner },
  private: false,
  permissions: { push: true },
  ...extra,
})

/** A fake `GET /user/repos` over `all`, 100 to a page; `fail` makes that page answer an error. */
function fakeGh(all: Entry[], fail?: { page: number; error: Error }) {
  const paths: string[] = []
  const reader: GhReader = {
    request: <T>(path: string) => {
      paths.push(path)
      const url = new URL(path, 'https://api.github.com')
      const page = Number(url.searchParams.get('page'))
      if (url.pathname !== '/user/repos') return Effect.fail(new Error(`unexpected read ${path}`))
      if (fail?.page === page) return Effect.fail(fail.error)
      return Effect.succeed(all.slice((page - 1) * 100, page * 100) as T)
    },
  }
  return { paths, reader }
}

const many = (n: number) => Array.from({ length: n }, (_, i) => entry(`r${i}`))

const listGh = (
  gh: ReturnType<typeof fakeGh>,
  options: { status?: GhStatus; projects?: readonly ProjectState[] } = {},
) =>
  Effect.runPromise(
    listRepositories({
      auth: 'gh',
      projects: options.projects ?? [],
      gh: { status: async () => options.status ?? OK, reader: gh.reader },
    }),
  )

describe('listRepositories on a gh machine', () => {
  it('follows the pages until one comes back short', async () => {
    const gh = fakeGh(many(207))
    const out = await listGh(gh)

    expect(out).toMatchObject({ kind: 'gh', login: 'me', more: false })
    expect(out.kind === 'gh' && out.repositories).toHaveLength(207)
    expect(gh.paths).toHaveLength(3)
    expect(gh.paths[0]).toBe('/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&page=1')
  })

  it('stops at 1000 and says more are not shown, after exactly ten requests', async () => {
    const gh = fakeGh(many(1500))
    const out = await listGh(gh)

    expect(gh.paths).toHaveLength(10)
    expect(out).toMatchObject({ kind: 'gh', more: true })
    expect(out.kind === 'gh' && out.repositories).toHaveLength(1000)
  })

  it('does not say more when the tenth page is the last one', async () => {
    const out = await listGh(fakeGh(many(950)))
    expect(out).toMatchObject({ more: false })
  })

  it('keeps only what can be pushed to: no push, unknown permissions and archived are left out', async () => {
    const out = await listGh(
      fakeGh([
        entry('ok', { private: true }),
        entry('read-only', { permissions: { push: false } }),
        entry('unknown', { permissions: null }),
        entry('no-field', { permissions: undefined }),
        entry('archived', { archived: true }),
      ]),
    )

    expect(out.kind === 'gh' && out.repositories).toEqual([
      { owner: 'me', repo: 'ok', private: true, slug: 'me/ok', onboarded: null },
    ])
  })

  it('answers an empty list only when the login can push to nothing', async () => {
    expect(await listGh(fakeGh([]))).toEqual({ kind: 'gh', login: 'me', repositories: [], more: false })
  })

  it('fails with the error rather than an empty list, and a partial list is not shown', async () => {
    const gh = fakeGh(many(250), { page: 2, error: new GitHubError(502, '/user/repos', 'Bad Gateway') })

    await expect(listGh(gh)).rejects.toThrow('502 on /user/repos: Bad Gateway')
  })

  it('fails with the gh auth sentence when gh is not usable', async () => {
    const status: GhStatus = { ok: false, reason: 'signed-out', detail: 'gh is not signed in' }
    const gh = fakeGh(many(3))

    await expect(listGh(gh, { status })).rejects.toThrow('gh is not signed in — run `gh auth login`')
    expect(gh.paths).toEqual([])
  })

  it('fails with the scope sentence when the login lacks repo', async () => {
    const gh = fakeGh(many(3))

    await expect(listGh(gh, { status: { ok: true, login: 'me', scopes: ['workflow'] } })).rejects.toThrow(/repo/)
    expect(gh.paths).toEqual([])
  })

  it('marks what is registered, and cannot vouch for a name once the list is capped', async () => {
    const registered = await listGh(fakeGh([entry('lingtai')]), { projects: [project('lingtai', 'me', 'abc')] })
    expect(registered.kind === 'gh' && registered.repositories[0]!.onboarded).toBe('registered')

    const taken = await listGh(fakeGh([entry('lingtai')]), { projects: [project('lingtai', 'acme', 'abc')] })
    expect(taken.kind === 'gh' && taken.repositories[0]).toMatchObject({ onboarded: 'taken', takenBy: 'acme' })

    const uncapped = await listGh(fakeGh([entry('lingtai')]), { projects: [project('lingtai', null, 'abc')] })
    expect(uncapped.kind === 'gh' && uncapped.repositories[0]!.onboarded).toBe('registered')

    const capped = await listGh(fakeGh([entry('lingtai'), ...many(1099)]), {
      projects: [project('lingtai', null, 'abc')],
    })
    expect(capped).toMatchObject({ more: true })
    expect(capped.kind === 'gh' && capped.repositories[0]!.onboarded).toBe('unrecorded')
  })
})
