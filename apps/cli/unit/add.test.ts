import type { RecipeFiles } from '@lingtai/recipe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type AddWorld, addFlow } from '../src/add.ts'
import type { SetupReader } from '../src/detect-setup.ts'
import type { FirstProjectWorld, GitResult } from '../src/first-project.ts'
/**
 * `addFlow` (#400, #435): `lingtai add` driven from `unit/` with no
 * `lingtai.ts` import — that file calls `main()` on import, which is why
 * `addFlow` lives in its own module (`add.ts`'s own header).
 */
import { stripColour } from '../src/output.ts'
import type { RuntimeFound } from '../src/runtimes.ts'
import { flagsFromArgv } from '../test/flags.ts'

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
  '/repo::rev-parse --verify refs/heads/lingtai-base^{commit}': ok('abc123f\n'),
}

interface Harness {
  world: AddWorld
  asked: string[]
  errors: string[]
  logged: string[]
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
      [{ id: 'claude-code', state: 'signed-in', signedIn: true, detail: 'signed in' }] as RuntimeFound[],
    setupReader: () => SETUP_READER,
    exists: async () => true,
    register: async (payload) => ({ line: `added ${payload.project}`, updated: false }),
    kept: 'Nothing was written',
    history: async () => [],
    inFlight: async () => [],
    removeMirror: async () => {},
    github: {
      ghStatus: async () => ({ ok: false, reason: 'missing', detail: 'gh is not installed' }),
      writeAuth: async () => {},
      app: async () => ({ configured: false }),
      boardUrl: async () => null,
      waitForApp: async () => ({ skipped: true }),
      picker: async () => ({ installations: [], installUrl: null }),
      add: async () => ({ ok: false }),
    },
  }
  const logged: string[] = []
  const world: AddWorld = {
    project,
    error: (line) => errors.push(line),
    log: (line) => logged.push(line),
    doctor: async () => ({
      report: { ok: 27, notChecked: 10, deferred: 3 },
      toFix: { count: 0, failed: false },
      blocks: '',
    }),
    store: () => ({ store: 'sqlite', path: `${HOME}/lingtai.db`, from: 'default', where: 'default' }) as never,
    userHome: '/home/me',
  }
  return { world, asked, errors, logged }
}

describe('addFlow at a TTY asks the project and recipe questions, and nothing before them (#435)', () => {
  it('addFlow([], world) registers a local project, asked for through the terminal', async () => {
    const { world, asked, errors } = ttyHarness()

    const code = await addFlow(flagsFromArgv([]), world)

    expect(code).toBe(0)
    expect(errors).toEqual([])
    // Nothing before the project question: no store, no App check that asks
    // anything (`world.github.app()` answers directly, with no prompt).
    expect(asked[0]).toMatch(/a GitHub project, or one on this machine only/)
    // Every later prompt is the directory, the base branch, or a recipe
    // question — `askRecipe`'s "use every default?" is the only one of
    // those actually reached, since taking its own default (an empty answer)
    // answers every question beneath it without asking again — and then the summary's confirm.
    for (const prompt of asked.slice(1)) {
      expect(prompt).toMatch(
        /the directory of the repository on this machine|the branch this project's recipe governs and merges into|use every default\?|register anyway\?/,
      )
    }
    expect(asked.length).toBeGreaterThan(1)
  })

  it('a local add prints the card with add <project> and doctor’s count (#773)', async () => {
    const { world, logged } = ttyHarness()
    expect(await addFlow(flagsFromArgv([]), world)).toBe(0)
    const rows = logged
      .join('\n')
      .split('\n')
      .map((l) => l.trimStart())
    expect(rows[0]).toBe('add  repo')
    expect(rows.find((l) => l.startsWith('trial '))).toBeDefined()
    expect(rows.find((l) => l.includes('ready — doctor: all 27 passed'))).toBeDefined()
    expect(rows.find((l) => /^(added|Before registering)/.test(l))).toBeUndefined()
    // The last thing printed is the block's last line.
    expect(rows.at(-1)).toBe('3 lingtai start — takes it, if nothing is taking work already')
    expect(rows.find((l) => l.startsWith('[next] 1 lingtai board'))).toBeDefined()
  })
})

describe('a GitHub add ends on the card, not on a dump of every setting (#755)', () => {
  function githubHarness(over: { doctorFails?: boolean; warnings?: string[] } = {}) {
    const h = ttyHarness()
    const files = mapFiles()
    h.world.project.files = files
    h.world.project.github.auth = () => 'gh'
    h.world.project.github.ghStatus = async () => ({ ok: true, login: 'sam', scopes: ['repo', 'workflow'] })
    h.world.project.github.add = async (_options, log) => {
      log('reading /h/.lingtai/widgets/recipe.yml — a dump line that must not reach the screen')
      log('  tier guarded')
      return { ok: true, updated: false, warnings: over.warnings ?? [], reach: { kind: 'gh', login: 'sam' } }
    }
    h.world.githubDeps = {
      check: async () => null,
      auth: () => 'gh',
      interactive: () => true,
      ghAccess: async () => ({ login: 'sam', defaultBranch: 'main' }),
      picker: async () => ({ installations: [], installUrl: null }),
      files,
      reader: async () => SETUP_READER,
      ask: async () => '',
      runtimes: async () => [{ id: 'claude-code', state: 'signed-in', signedIn: true, detail: 'signed in' }],
      history: async () => [],
    }
    if (over.doctorFails === true) {
      h.world.doctor = async () => ({
        report: { ok: 20, notChecked: 0, deferred: 0 },
        toFix: { count: 1, failed: true },
        blocks: 'a failing block',
      })
    }
    const argv = ['acme/widgets', '--base', 'main', '--install', 'none', '--build', 'none']
    return { ...h, argv }
  }

  it('prints the three groups, the github row and the ready line, and none of what add logged', async () => {
    const { world, logged, errors, argv } = githubHarness()
    // The positional is `acme/widgets`; flagsFromArgv reads the rest.
    const parsed = flagsFromArgv(argv)
    expect(await addFlow({ ...parsed, positional: 'acme/widgets' }, world)).toBe(0)
    expect(errors).toEqual([])
    const text = logged.join('\n')
    expect(text).toMatch(/^add {2}widgets$/m)
    expect(text).toMatch(/github\s+gh, signed in as sam/)
    expect(text).toMatch(/code\s+acme\/widgets {2}github/)
    expect(text).toMatch(/lands on\s+main, on GitHub/)
    expect(text).toContain('each attempt')
    expect(text).toMatch(/✓ ready — doctor: all 27 passed.*recipe: .*widgets/)
    expect(text).not.toContain('a dump line')
    expect(text).not.toContain('tier guarded')
  })

  it('prints a warning add reported before the card', async () => {
    const { world, logged, argv } = githubHarness({ warnings: ['warning: main is protected (a ruleset). Ask.'] })
    expect(await addFlow({ ...flagsFromArgv(argv), positional: 'acme/widgets' }, world)).toBe(0)
    const text = logged.join('\n')
    expect(text.indexOf('warning: main is protected')).toBeGreaterThan(-1)
    expect(text.indexOf('warning: main is protected')).toBeLessThan(text.indexOf('this machine'))
  })

  it('a doctor failure ends on not ready with its recipe and the blocks, never ready', async () => {
    const { world, logged, argv } = githubHarness({ doctorFails: true })
    expect(await addFlow({ ...flagsFromArgv(argv), positional: 'acme/widgets' }, world)).toBe(0)
    const text = logged.join('\n')
    expect(text).toMatch(/✗ not ready · recipe: /)
    expect(text).toContain('a failing block')
    expect(text).not.toContain('✓ ready')
    // One NEXT line, no number, last.
    const last = stripColour(logged.join('\n').split('\n').at(-1)!)
    expect(last).toMatch(/^\s*\[next\] \S/)
    expect(last).not.toMatch(/ 1 /)
  })
})
