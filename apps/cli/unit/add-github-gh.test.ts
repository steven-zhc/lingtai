import { afterEach, describe, expect, it, vi } from 'vitest'

import { askBeforeGithubAdd, type AskBeforeGithubAddDeps } from '../src/add-github.ts'
/**
 * `askBeforeGithubAdd` on a `gh` machine (#708): the saved login's access is
 * checked where the App check is on an App machine, before a recipe answer is
 * written, and the App is never consulted.
 */
import type { SetupReader } from '../src/detect-setup.ts'

const SLUG = 'acme/widgets'
const PREVIOUS_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...PREVIOUS_ENV }
  vi.restoreAllMocks()
})

function depsFor(over: Partial<AskBeforeGithubAddDeps>) {
  const calls = { check: 0, picker: 0, writes: 0, reach: [] as unknown[] }
  const store: Record<string, string> = {}
  const reader: SetupReader = { has: async () => false, read: async () => null }
  const deps: AskBeforeGithubAddDeps = {
    check: async () => {
      calls.check++
      return null
    },
    auth: () => 'gh',
    interactive: () => true,
    ghAccess: async () => ({ login: 'sam', defaultBranch: 'main' }),
    picker: async () => {
      calls.picker++
      throw new Error('no picker')
    },
    files: {
      read: async (path) => store[path] ?? null,
      replace: async (path, text) => {
        calls.writes++
        store[path] = text
      },
    },
    reader: async (_o, _r, reach) => {
      calls.reach.push(reach)
      return reader
    },
    ask: async () => '',
    runtimes: async () => [{ id: 'claude-code', state: 'signed-in', signedIn: true, detail: 'signed in' }],
    history: async () => [],
    ...over,
  }
  return { deps, calls }
}

describe('askBeforeGithubAdd on a gh machine (#708)', () => {
  it('adds with no installation call, no picker and the repository read through gh', async () => {
    // A full App is configured too, and is not the auth: `gh` wins.
    process.env['LINGTAI_GITHUB_APP_ID'] = '1'
    process.env['LINGTAI_GITHUB_APP_PRIVATE_KEY'] = 'x'
    const { deps, calls } = depsFor({})
    const code = await askBeforeGithubAdd(SLUG, { base: 'main', install: 'none' }, deps, ['none'])
    expect(code).toBeNull()
    expect(calls.check).toBe(0)
    expect(calls.picker).toBe(0)
    expect(calls.writes).toBeGreaterThan(0)
    expect(calls.reach).toEqual([{ kind: 'gh' }])
  })

  it('refuses by name and writes nothing when the access check refuses', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { deps, calls } = depsFor({
      ghAccess: async (_slug, log) => {
        log('gh is signed in as sam without workflow — run `gh auth refresh --hostname github.com --scopes workflow`')
        return null
      },
    })
    const code = await askBeforeGithubAdd(SLUG, {}, deps)
    expect(code).toBe(1)
    expect(calls.writes).toBe(0)
    expect(calls.check).toBe(0)
    expect(String(error.mock.calls[0]?.[0])).toContain('--scopes workflow')
  })

  it('refuses with run lingtai init when nothing is configured and there is no terminal', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { deps, calls } = depsFor({ auth: () => null, interactive: () => false })
    expect(await askBeforeGithubAdd(SLUG, {}, deps)).toBe(1)
    expect(calls.writes).toBe(0)
    expect(String(error.mock.calls[0]?.[0])).toContain('lingtai init')
  })

  it('refuses a refused github.auth by name before anything is written', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { deps, calls } = depsFor({
      auth: () => {
        throw new Error('github.auth is "foo"')
      },
    })
    expect(await askBeforeGithubAdd(SLUG, {}, deps)).toBe(1)
    expect(calls.writes).toBe(0)
    expect(String(error.mock.calls[0]?.[0])).toContain('github.auth')
  })
})
