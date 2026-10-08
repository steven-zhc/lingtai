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
import { recipePath, resolveSource } from '@lingtai/recipe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isMap, isScalar, parseDocument, type Node, type YAMLMap } from 'yaml'

import { askBeforeGithubAdd, type AskBeforeGithubAddDeps } from '../src/add-github.ts'
import { SAID } from '../src/recipe-flow.ts'

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
  /** The latest text written at each path — `files.replace`'s own store. */
  written: Record<string, string>
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
  // An absent file is now created once this check passes (#432) — overridden
  // by the tests that reach that far; every earlier-refusing test never
  // calls either.
  overrides: { runtimes?: AskBeforeGithubAddDeps['runtimes']; history?: AskBeforeGithubAddDeps['history'] } = {},
): Counted {
  const counted: Counted = {
    deps: null as unknown as AskBeforeGithubAddDeps,
    reads: [],
    writes: 0,
    asks: 0,
    written: {},
  }
  counted.deps = {
    check: (slug, log) => checkInstallation(slug, log, undefined, lookup),
    picker,
    files: {
      read: async (path) => {
        counted.reads.push(path)
        return counted.written[path] ?? null
      },
      replace: async (path, text) => {
        counted.writes++
        counted.written[path] = text
      },
    },
    // A test that reaches an absent file's creation needs a reader
    // `askInstallAndBuild` can call without throwing — overridden by any
    // test that cares what it finds.
    reader: async () => ({ has: async () => false, read: async () => null }),
    ask: async () => {
      counted.asks++
      return null
    },
    runtimes: overrides.runtimes ?? (async () => []),
    history: overrides.history ?? (async () => []),
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

  it("prints checkInstallation's gap list, not choose()'s onboarded sentence, for a project Lingtai already has (#402 review)", async () => {
    const counted = countedDeps(
      async () => GAPPY,
      async () => ({
        installations: [
          {
            installation: GAPPY,
            unanswered: null,
            gaps: [],
            repositories: [
              {
                owner: 'steven-zhc',
                repo: 'nextloom-ai-admin',
                private: true,
                slug: SLUG,
                onboarded: 'registered',
              },
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

    const code = await askBeforeGithubAdd(SLUG, {}, counted.deps)
    spy.mockRestore()

    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('the installation is missing permissions:')
    expect(errors.join('\n')).toContain('issues: have read, need write')
    expect(errors.join('\n')).not.toContain('already onboarded')
    expect(counted.writes).toBe(0)
  })

  it('reaches the recipe check once the installation is good, showing the order is not just "always return"', async () => {
    // No agent runtime signed in (`countedDeps`'s default) — `askRecipe`
    // refuses at its agent question rather than succeeding, but by then it
    // has already read the file twice (once here, once inside `askRecipe`
    // itself), proving the installation check ran first and did not short
    // the rest of the function out. `--defaults` (#433) answers `askRecipe`'s
    // own first question, "use every default?" — with no terminal and no
    // flag that question would refuse before either read, which is not what
    // this test is about.
    const counted = countedDeps(async () => FULLY_PERMISSIONED)

    const code = await askBeforeGithubAdd(SLUG, { base: 'main', defaults: '' }, counted.deps)

    expect(code).toBe(1)
    expect(counted.reads.length).toBe(2)
    expect(counted.writes).toBe(0)
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

  it('creates an absent recipe once, with every first-run answer and a SAID comment above each block, when no GitHub App is configured yet (#432)', async () => {
    delete process.env['LINGTAI_GITHUB_APP_ID']
    delete process.env['LINGTAI_GITHUB_APP_PRIVATE_KEY']
    const counted = countedDeps(async () => FULLY_PERMISSIONED, undefined, {
      runtimes: async () => [{ id: 'claude-code', installed: true, signedIn: true, detail: 'signed in' }],
    })
    // Every question takes its own default or detected answer; `install` and
    // `build` are answered directly by flag, since neither has one to take.
    counted.deps.ask = async () => ''

    const code = await askBeforeGithubAdd(
      'steven-zhc/nextloom-ai-admin',
      { base: 'main', install: 'none' },
      counted.deps,
      ['none'],
    )

    expect(code).toBeNull()
    expect(counted.writes).toBe(1)

    const path = recipePath('nextloom-ai-admin')
    const text = counted.written[path]!
    const resolved = resolveSource(text, path, path).recipe
    expect(resolved.repo.base).toBe('main')
    expect(resolved.env.plantAt).toBe('.env.local')
    expect(resolved.source.tickets).toBe('github')
    expect(resolved.runtime.agent).toBe('claude-code')

    // `steps.proposed` and `runtime.limits` are not yet decided at the point
    // this write happens — `askLanding`/`askLimits` have not asked — so they
    // alone may be missing rather than carry a comment (#432 fix round,
    // finding 2).
    const doc = parseDocument(text)
    for (const [dotted, sentence] of Object.entries(SAID)) {
      const keyPath = dotted.split('.')
      const parent = (keyPath.length === 1 ? doc.contents : doc.getIn(keyPath.slice(0, -1), true)) as YAMLMap
      expect(isMap(parent), dotted).toBe(true)
      const pair = parent.items.find((p) => isScalar(p.key) && p.key.value === keyPath[keyPath.length - 1])
      if (!pair) {
        expect(['steps.proposed', 'runtime.limits'], dotted).toContain(dotted)
        continue
      }
      const comment = (pair.key as Node).commentBefore ?? (parent.items[0] === pair ? parent.commentBefore : '') ?? ''
      expect(comment.replace(/\s+/g, ' ').trim(), dotted).toBe(sentence)
    }

    // The file carries only what was asked — no schema or plugin-schema
    // default spelled out as though it had been chosen (#432 fix round,
    // finding 2's own failure scenario).
    expect(doc.getIn(['runtime', 'limits'])).toBeUndefined()
    expect(doc.getIn(['runtime', 'tier'])).toBeUndefined()
    expect(doc.getIn(['runtime', 'budget'])).toBeUndefined()
    expect(doc.getIn(['discuss'])).toBeUndefined()
    expect(doc.getIn(['source', 'backoff'])).toBeUndefined()
    expect(doc.getIn(['repo', 'submodules'])).toBeUndefined()
    expect(doc.getIn(['env', 'deny'])).toBeUndefined()
    expect(doc.getIn(['steps', 'proposed'])).toBeUndefined()
  })

  it('refuses by name, before asking a runtime whether it is signed in, when there is no --base and no default branch to seed an absent file (#432)', async () => {
    delete process.env['LINGTAI_GITHUB_APP_ID']
    delete process.env['LINGTAI_GITHUB_APP_PRIVATE_KEY']
    const counted = countedDeps(async () => FULLY_PERMISSIONED, undefined, {
      runtimes: () => {
        throw new Error('no runtimes in this test')
      },
    })
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg))
    })

    const code = await askBeforeGithubAdd(SLUG, {}, counted.deps)
    spy.mockRestore()

    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('pass --base')
    expect(counted.writes).toBe(0)
    expect(counted.asks).toBe(0)
  })
})
