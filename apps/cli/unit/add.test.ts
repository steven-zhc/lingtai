import { type RecipeFiles, recipePath } from '@lingtai/recipe'
import type { SetupReader } from '@lingtai/setup'
import type { RuntimeFound } from '@lingtai/setup'
import { Effect } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type AddWorld, addFlowEffect } from '../src/add.ts'

const fx = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (e) => e })
const addFlow = (...args: Parameters<typeof addFlowEffect>) => Effect.runPromise(addFlowEffect(...args))
import type { GitResult } from '../src/first-project.ts'
/**
 * `addFlow` (#400, #435): `lingtai add` driven from `unit/` with no
 * `lingtai.ts` import — that file calls `main()` on import, which is why
 * `addFlow` lives in its own module (`add.ts`'s own header).
 */
import { stripColour } from '../src/output.ts'
import { liftFirstProjectWorld, liftPort, type PromiseFirstProjectWorld } from '../test/first-project-world.ts'
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
const SETUP_READER: SetupReader = {
  has: (path) => Effect.succeed(path === 'pnpm-lock.yaml'),
  read: () => Effect.succeed(null),
}

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

function fakeGit(plan: GitPlan): PromiseFirstProjectWorld['git'] {
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
  const project: PromiseFirstProjectWorld = {
    ask: async (prompt) => {
      asked.push(prompt)
      if (asked.length === 1) return 'local'
      if (asked.length === 2) return '/repo'
      return ''
    },
    log: () => {},
    git: fakeGit(GIT_PLAN),
    projects: async () => [],
    locker: { tryLock: async () => ({ ok: true as const, lock: { release: async () => {} } }) },
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
    project: liftFirstProjectWorld(project),
    error: (line) => errors.push(line),
    log: (line) => logged.push(line),
    doctor: () =>
      fx(async () => ({
        report: { ok: 27, notChecked: 10, deferred: 3 },
        toFix: { count: 0, failed: false },
        blocks: '',
      })),
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

  it('a bare add that goes local at the prompt keeps the recipe flags it was given (#969)', async () => {
    const { world, errors } = ttyHarness()
    world.repositories = {
      interactive: () => true,
      list: () =>
        fx(async () => {
          throw new Error('local was chosen: the list must not be read')
        }),
    }

    const code = await addFlow(flagsFromArgv(['--budget', '7']), world)

    expect(errors).toEqual([])
    expect(code).toBe(0)
    const recipe = await world.project.files.read(recipePath('repo', HOME))
    expect(recipe).toMatch(/usd:\s*7\b/)
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
    h.world.project.github.ghStatus = liftPort(async () => ({ ok: true, login: 'sam', scopes: ['repo', 'workflow'] }))
    h.world.project.github.add = liftPort(async (_options, log) => {
      log('reading /h/.lingtai/widgets/recipe.yml — a dump line that must not reach the screen')
      log('  tier guarded')
      return { ok: true, updated: false, warnings: over.warnings ?? [], reach: { kind: 'gh', login: 'sam' } }
    })
    h.world.githubDeps = {
      check: async () => null,
      auth: () => 'gh',
      interactive: () => true,
      ghAccess: async () => ({ login: 'sam', defaultBranch: 'main' }),
      picker: () => fx(async () => ({ installations: [], installUrl: null })),
      files,
      reader: () => fx(async () => SETUP_READER),
      ask: async () => '',
      runtimes: () => fx(async () => [{ id: 'claude-code', state: 'signed-in', signedIn: true, detail: 'signed in' }]),
      history: async () => [],
    }
    if (over.doctorFails === true) {
      h.world.doctor = () =>
        fx(async () => ({
          report: { ok: 20, notChecked: 0, deferred: 0 },
          toFix: { count: 1, failed: true },
          blocks: 'a failing block',
        }))
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

  it('a bare add on a gh machine offers the login’s repositories and adds the one picked (#969)', async () => {
    const { world, logged, errors, asked } = githubHarness()
    const offered: string[] = []
    world.project.ask = async (prompt, shape) => {
      asked.push(prompt)
      if (/which repository/.test(prompt)) {
        offered.push(...(shape?.choices ?? []))
        return 'acme/widgets'
      }
      return ''
    }
    world.repositories = {
      interactive: () => true,
      list: () =>
        fx(async () => ({
          kind: 'gh',
          login: 'sam',
          more: true,
          repositories: [
            { owner: 'acme', repo: 'widgets', private: false, slug: 'acme/widgets', onboarded: null },
            { owner: 'acme', repo: 'old', private: false, slug: 'acme/old', onboarded: 'registered' },
          ],
        })),
    }
    const parsed = flagsFromArgv(['--project', 'github', '--github-auth', 'gh'])

    const code = await addFlow(parsed, world)
    expect(errors).toEqual([])
    expect(code).toBe(0)
    expect(errors).toEqual([])
    expect(logged).toContain('more not shown — type owner/repo')
    // Only what is not already registered is offered, then the way to type one.
    expect(offered).toEqual(['acme/widgets', 'type owner/repo'])
    expect(logged.join('\n')).toMatch(/code\s+acme\/widgets {2}github/)
  })

  it('a bare add with recipe flags still reaches the picker, and the flags go on with the pick (#969)', async () => {
    const { world, errors } = githubHarness()
    world.project.ask = async (prompt) => (/which repository/.test(prompt) ? 'acme/widgets' : '')
    world.repositories = {
      interactive: () => true,
      list: () =>
        fx(async () => ({
          kind: 'gh',
          login: 'sam',
          more: false,
          repositories: [{ owner: 'acme', repo: 'widgets', private: false, slug: 'acme/widgets', onboarded: null }],
        })),
    }
    const parsed = flagsFromArgv(['--project', 'github', '--github-auth', 'gh', '--agent', 'claude-code'])

    const code = await addFlow(parsed, world)
    expect(errors).toEqual([])
    expect(code).toBe(0)
  })

  it('recipe flags also reach the picker when GitHub is chosen at the prompt, not named (#969)', async () => {
    const { world, errors } = githubHarness()
    world.project.ask = async (prompt) => (/which repository/.test(prompt) ? 'acme/widgets' : '')
    world.repositories = {
      interactive: () => true,
      list: () =>
        fx(async () => ({
          kind: 'gh',
          login: 'sam',
          more: false,
          repositories: [{ owner: 'acme', repo: 'widgets', private: false, slug: 'acme/widgets', onboarded: null }],
        })),
    }
    const code = await addFlow(flagsFromArgv(['--github-auth', 'gh', '--agent', 'claude-code']), world)
    expect(errors).toEqual([])
    expect(code).toBe(0)
  })

  it('an installation the App could not list is said, not shown as empty (#969)', async () => {
    const { world, logged } = githubHarness()
    world.project.ask = async (prompt) => (/owner\/repo/.test(prompt) ? 'acme/widgets' : '')
    world.repositories = {
      interactive: () => true,
      list: () =>
        fx(async () => ({
          kind: 'app',
          picker: {
            installUrl: null,
            installations: [
              {
                installation: {
                  id: 7,
                  account: 'acme',
                  permissions: {},
                  repositorySelection: 'all',
                  htmlUrl: null,
                  appSlug: null,
                },
                unanswered: '502 on /installation/repositories: Bad Gateway',
                gaps: [],
                repositories: [],
              },
            ],
          },
        })),
    }

    await addFlow(flagsFromArgv(['--project', 'github', '--github-auth', 'gh']), world)
    expect(logged.join('\n')).toContain("could not list acme's repositories — 502 on /installation/repositories")
  })

  it('a bare add with no terminal still refuses with exit 2 and reads nothing (#969)', async () => {
    const { world, errors } = githubHarness()
    let read = false
    world.repositories = {
      interactive: () => false,
      list: () =>
        fx(async () => {
          read = true
          throw new Error('must not be asked')
        }),
    }
    const parsed = flagsFromArgv(['--project', 'github', '--github-auth', 'gh'])

    expect(await addFlow(parsed, world)).toBe(2)
    expect(read).toBe(false)
    expect(errors.join('\n')).toContain('no repository was picked')
  })

  it('refuses a GitHub project that is already added before asking anything, naming its recipe (#968)', async () => {
    const { world, errors, asked, argv } = githubHarness()
    world.project.projects = liftPort(async () => [
      {
        project: 'widgets',
        owner: 'acme',
        base: 'main',
        configHash: 'h',
        fromSha: null,
        refused: null,
        paused: null,
        version: 1,
        lastSeq: null,
      },
    ])
    expect(await addFlow({ ...flagsFromArgv(argv), positional: 'acme/widgets' }, world)).toBe(1)
    expect(errors).toEqual([expect.stringContaining(`its recipe is ${recipePath('widgets')}, and it is edited there`)])
    expect(asked).toEqual([])
  })

  it('an owner never recorded is still repaired by adding it again: no question, no recipe written (#968)', async () => {
    const { world, errors, asked } = githubHarness()
    world.project.projects = liftPort(async () => [
      {
        project: 'widgets',
        owner: null,
        base: 'main',
        configHash: 'h',
        fromSha: null,
        refused: null,
        paused: null,
        version: 1,
        lastSeq: null,
      },
    ])
    const code = await addFlow({ ...flagsFromArgv([]), positional: 'acme/widgets' }, world)
    expect(errors).toEqual([])
    expect(code).toBe(0)
    expect(asked).toEqual([])
    expect(await world.project.files.read(recipePath('widgets'))).toBeNull()
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
