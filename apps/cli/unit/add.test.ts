/**
 * `addFlow` (#400, #435): `lingtai add` driven from `unit/` with no
 * `lingtai.ts` import — that file calls `main()` on import, which is why
 * `addFlow` lives in its own module (`add.ts`'s own header).
 */
import type { RecipeFiles } from '@lingtai/recipe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type AddWorld, addFlow } from '../src/add.ts'
import type { SetupReader } from '../src/detect-setup.ts'
import type { FirstProjectWorld, GitResult } from '../src/first-project.ts'
import type { RuntimeFound } from '../src/runtimes.ts'

const before = process.env['NO_COLOR']
beforeAll(() => {
  process.env['NO_COLOR'] = '1'
})
afterAll(() => {
  if (before === undefined) delete process.env['NO_COLOR']
  else process.env['NO_COLOR'] = before
})

const HOME = '/home/me/.lingtai'

// A lockfile at the root, so `detectSetup` suggests an install command — the
// one recipe question (`setup-build.ts`'s `askInstall`) that refuses an empty
// answer outright rather than reading it as "none": with no `--install` flag
// to short-circuit it, a test that answers every later question `''` needs a
// detected default to take.
const SETUP_READER: SetupReader = { has: async (path) => path === 'pnpm-lock.yaml', read: async () => null }

function mapFiles(initial: Record<string, string> = {}): RecipeFiles {
  const store = new Map(Object.entries(initial))
  return {
    read: async (p) => store.get(p) ?? null,
    replace: async (p, text) => {
      store.set(p, text)
    },
  }
}

type GitPlan = Record<string, GitResult>

function fakeGit(plan: GitPlan): FirstProjectWorld['git'] {
  return async (dir, args) => {
    const key = `${dir}::${args.join(' ')}`
    const found = plan[key]
    if (found === undefined) throw new Error(`unplanned git call: ${key}`)
    return found
  }
}

const ok = (stdout: string): GitResult => ({ ok: true, stdout, stderr: '' })

const GIT_PLAN: GitPlan = {
  '/repo::rev-parse --show-toplevel': ok('/repo\n'),
  '/repo::remote get-url origin': ok('https://github.com/acme/widget.git\n'),
  '/repo::symbolic-ref --short refs/remotes/origin/HEAD': ok('origin/main\n'),
  '/repo::rev-parse --verify main^{commit}': ok('abc123f\n'),
}

interface Harness {
  world: AddWorld
  asked: string[]
  errors: string[]
}

/**
 * A TTY: `ask` answers the first prompt `local`, the second `/repo`, and
 * every later one `''` — the default at every later question, including
 * `askRecipe`'s own "use every default?", which takes every recipe question's
 * default along with it (#435's Done-when 3).
 */
function ttyHarness(): Harness {
  const asked: string[] = []
  const errors: string[] = []
  const project: FirstProjectWorld = {
    ask: async (prompt) => {
      asked.push(prompt)
      if (asked.length === 1) return 'local'
      if (asked.length === 2) return '/repo'
      return ''
    },
    log: () => {},
    git: fakeGit(GIT_PLAN),
    projects: async () => [],
    files: mapFiles(),
    home: HOME,
    signedIn: async () => ['claude-code'] as never[],
    runtimes: async () =>
      [{ id: 'claude-code', installed: true, signedIn: true, detail: 'signed in' }] as RuntimeFound[],
    setupReader: () => SETUP_READER,
    register: async (payload) => `added ${payload.project}`,
    kept: 'Nothing was written',
    history: async () => [],
    github: {
      app: async () => ({ configured: false }),
      boardUrl: async () => null,
      waitForApp: async () => ({ skipped: true }),
      picker: async () => ({ installations: [], installUrl: null }),
      add: async () => 1,
    },
  }
  return { world: { project, error: (line) => errors.push(line) }, asked, errors }
}

describe('addFlow at a TTY asks the project and recipe questions, and nothing before them (#435)', () => {
  it('addFlow([], world) registers a local project, asked for through the terminal', async () => {
    const { world, asked, errors } = ttyHarness()

    const code = await addFlow([], world)

    expect(code).toBe(0)
    expect(errors).toEqual([])
    // Nothing before the project question: no store, no App check that asks
    // anything (`world.github.app()` answers directly, with no prompt).
    expect(asked[0]).toMatch(/a GitHub project, or one on this machine only/)
    // Every later prompt is the directory, the base branch, or a recipe
    // question — `askRecipe`'s "use every default?" is the only one of
    // those actually reached, since taking its own default (an empty answer)
    // answers every question beneath it without asking again.
    for (const prompt of asked.slice(1)) {
      expect(prompt).toMatch(
        /the directory of the repository on this machine|the branch this project's recipe governs and merges into|use every default\?/,
      )
    }
    expect(asked.length).toBeGreaterThan(1)
  })
})
