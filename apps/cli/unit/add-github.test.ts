/**
 * `askBeforeGithubAdd` (#402): the installation and its permissions are
 * checked before a single question is asked or a single answer written. A
 * refused check reaches `deps.read`, `deps.write` and `deps.ask` zero times —
 * the unit-level stand-in for "recipe.yml byte-for-byte unchanged", since a
 * byte comparison against a real file is the filesystem and belongs to the
 * integration half (0060 §1).
 *
 * `deps.check` wraps the real `checkInstallation` with a fake lookup, so
 * these tests pin the whole chain — `askBeforeGithubAdd` gating on its
 * result — rather than a stand-in that always returns null.
 */
import { checkInstallation } from '@lingtai/conductor/onboard'
import type { Installation } from '@lingtai/github'
import { NotInstalledError } from '@lingtai/github'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { askBeforeGithubAdd, type AskBeforeGithubAddDeps } from '../src/add-github.ts'

const PREVIOUS_ENV = { ...process.env }

beforeEach(() => {
  // `hasGitHubApp()` is read directly (#402 — there is nothing to check with
  // no App configured at all), so these two make it answer true without
  // reaching the filesystem's `config.yml`, for every test that wants an App
  // present. The tests that want no App deletes these two again.
  process.env['LINGTAI_GITHUB_APP_ID'] = '1'
  process.env['LINGTAI_GITHUB_APP_PRIVATE_KEY'] = 'not-a-real-key'
})

afterEach(() => {
  process.env = { ...PREVIOUS_ENV }
})

const SLUG = 'steven-zhc/nextloom-ai-admin'

const FULLY_PERMISSIONED: Installation = {
  id: 7,
  permissions: { issues: 'write', contents: 'write', pull_requests: 'write', metadata: 'read' },
  account: 'steven-zhc',
  repositorySelection: 'selected',
  htmlUrl: null,
}

const GAPPY: Installation = {
  id: 7,
  permissions: { issues: 'read', contents: 'write', pull_requests: 'write', metadata: 'read' },
  account: 'steven-zhc',
  repositorySelection: 'selected',
  htmlUrl: null,
}

interface Counted {
  deps: AskBeforeGithubAddDeps
  reads: string[]
  writes: number
  asks: number
}

function countedDeps(
  lookup: (owner: string, repo: string) => Promise<Installation>,
  // Most tests never reach `deps.picker` — it is asked only once `deps.check`
  // has refused (#402 fix round 3) — so the default throws, which the code
  // under test catches and falls back on, same as a picker that failed for a
  // real reason would.
  picker: AskBeforeGithubAddDeps['picker'] = async () => {
    throw new Error('no picker in this test')
  },
): Counted {
  const counted: Counted = { deps: null as unknown as AskBeforeGithubAddDeps, reads: [], writes: 0, asks: 0 }
  counted.deps = {
    check: (slug, log) => checkInstallation(slug, log, undefined, lookup),
    picker,
    read: async (path) => {
      counted.reads.push(path)
      return null
    },
    write: async (project) => {
      counted.writes++
      return { path: project, text: '', written: true }
    },
    ask: async () => {
      counted.asks++
      return null
    },
  }
  return counted
}

describe('askBeforeGithubAdd (#402)', () => {
  it('returns 1 and reads, writes and asks nothing when the App is not installed', async () => {
    const counted = countedDeps(async (owner, repo) => {
      throw new NotInstalledError(owner, repo)
    })

    const code = await askBeforeGithubAdd(SLUG, {}, counted.deps)

    expect(code).toBe(1)
    expect(counted.reads).toEqual([])
    expect(counted.writes).toBe(0)
    expect(counted.asks).toBe(0)
  })

  it('returns 1 and reads, writes and asks nothing when the installation is missing a permission', async () => {
    const counted = countedDeps(async () => GAPPY)

    const code = await askBeforeGithubAdd(SLUG, {}, counted.deps)

    expect(code).toBe(1)
    expect(counted.reads).toEqual([])
    expect(counted.writes).toBe(0)
    expect(counted.asks).toBe(0)
  })

  it('names the repository and the installation page, through choose(), when the App is installed on the owner but not this repository (#402 fix round 3)', async () => {
    const installation: Installation = {
      id: 7,
      permissions: { issues: 'write', contents: 'write', pull_requests: 'write', metadata: 'read' },
      account: 'someowner',
      repositorySelection: 'selected',
      htmlUrl: 'https://github.com/organizations/someowner/settings/installations/7',
    }
    const counted = countedDeps(
      async (owner, repo) => {
        throw new NotInstalledError(owner, repo)
      },
      async () => ({
        installations: [
          {
            installation,
            unanswered: null,
            gaps: [],
            repositories: [
              { owner: 'someowner', repo: 'other-repo', private: true, slug: 'someowner/other-repo', onboarded: null },
            ],
          },
        ],
        installUrl: null,
      }),
    )
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg))
    })

    const code = await askBeforeGithubAdd('someowner/somerepo', {}, counted.deps)
    spy.mockRestore()

    expect(code).toBe(1)
    expect(errors.join('\n')).toContain(
      'The App is installed on someowner for selected repositories, and someowner/somerepo is not one of them.',
    )
    expect(errors.join('\n')).toContain(`Add somerepo on the installation's page: ${installation.htmlUrl}`)
    expect(counted.reads).toEqual([])
    expect(counted.writes).toBe(0)
    expect(counted.asks).toBe(0)
  })

  it('reaches read once the installation is good, showing the order is not just "always return"', async () => {
    const counted = countedDeps(async () => FULLY_PERMISSIONED)

    const code = await askBeforeGithubAdd(SLUG, {}, counted.deps)

    expect(code).toBeNull()
    expect(counted.reads.length).toBe(1)
  })

  it('names the App, rather than rethrowing raw, when the lookup fails for a reason other than "not installed"', async () => {
    const counted = countedDeps(async () => {
      throw new Error('error:1E08010C:DECODER routines::unsupported')
    })
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg))
    })

    const code = await askBeforeGithubAdd(SLUG, {}, counted.deps)
    spy.mockRestore()

    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('the GitHub App configured here does not answer')
    expect(errors.join('\n')).toContain('error:1E08010C:DECODER routines::unsupported')
    expect(counted.reads).toEqual([])
    expect(counted.writes).toBe(0)
    expect(counted.asks).toBe(0)
  })

  it('refuses --agent by name instead of silently dropping it when no GitHub App is configured yet', async () => {
    delete process.env['LINGTAI_GITHUB_APP_ID']
    delete process.env['LINGTAI_GITHUB_APP_PRIVATE_KEY']
    const counted = countedDeps(async () => FULLY_PERMISSIONED)
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg))
    })

    const code = await askBeforeGithubAdd(SLUG, { agent: 'claude-code' }, counted.deps)
    spy.mockRestore()

    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('--agent needs a recipe to write into')
    expect(counted.writes).toBe(0)
    expect(counted.asks).toBe(0)
  })
})
