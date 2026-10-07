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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { askBeforeGithubAdd, type AskBeforeGithubAddDeps } from '../src/add-github.ts'

const PREVIOUS_ENV = { ...process.env }

beforeEach(() => {
  // `hasGitHubApp()` is read directly (#402 — there is nothing to check with
  // no App configured at all), so these two make it answer true without
  // reaching the filesystem's `config.yml`.
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

function countedDeps(lookup: (owner: string, repo: string) => Promise<Installation>): Counted {
  const counted: Counted = { deps: null as unknown as AskBeforeGithubAddDeps, reads: [], writes: 0, asks: 0 }
  counted.deps = {
    check: (slug, log) => checkInstallation(slug, log, undefined, lookup),
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

  it('reaches read once the installation is good, showing the order is not just "always return"', async () => {
    const counted = countedDeps(async () => FULLY_PERMISSIONED)

    const code = await askBeforeGithubAdd(SLUG, {}, counted.deps)

    expect(code).toBeNull()
    expect(counted.reads.length).toBe(1)
  })
})
