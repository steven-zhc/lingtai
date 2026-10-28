import type { ProjectState } from '@lingtai/domain'
import type { GhRun } from '@lingtai/github'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { githubClientFor } from '../src/filter.ts'

/**
 * **`githubClientFor` under `gh` builds its client with no installation lookup (#707).**
 *
 * A full App beside `github.auth: gh` is the case that matters: the election
 * says `gh`, so the App's credentials are never read and `/installation` is
 * never fetched. The fetch is stubbed and every URL it is asked for is kept.
 */
const STATE: ProjectState = {
  project: 'repo',
  owner: 'owner',
  base: 'main',
  configHash: 'seeded',
  fromSha: '0'.repeat(40),
  refused: null,
  version: 1,
  lastSeq: null,
}

const urls: string[] = []
const tokens: string[] = []

beforeEach(() => {
  urls.length = 0
  tokens.length = 0
  vi.stubEnv('LINGTAI_HOME', '/nonexistent/lingtai-home')
  vi.stubEnv('LINGTAI_GITHUB_AUTH', 'gh')
  vi.stubEnv('LINGTAI_GITHUB_APP_ID', '1')
  vi.stubEnv('LINGTAI_GITHUB_APP_PRIVATE_KEY', 'not-a-key')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      urls.push(url)
      tokens.push(init.headers.authorization ?? '')
      return new Response(JSON.stringify({ default_branch: 'trunk' }), { status: 200 })
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('githubClientFor', () => {
  it('builds a gh client through the injected runner, with no installation lookup', async () => {
    const gh: GhRun = async () => ({ code: 0, stdout: 'gho_test\n', stderr: '' })
    const client = await githubClientFor(STATE, undefined, gh)

    expect(urls).toEqual([])
    expect(await client.defaultBranch()).toBe('trunk')
    expect(urls).toEqual(['https://api.github.com/repos/owner/repo'])
    expect(tokens).toEqual(['Bearer gho_test'])
  })

  it('refuses by name where the machine has no GitHub auth at all', async () => {
    vi.stubEnv('LINGTAI_GITHUB_AUTH', '')
    vi.stubEnv('LINGTAI_GITHUB_APP_ID', '')
    vi.stubEnv('LINGTAI_GITHUB_APP_PRIVATE_KEY', '')
    await expect(githubClientFor(STATE)).rejects.toThrow(/no GitHub App configured/)
  })
})
