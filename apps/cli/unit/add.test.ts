import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { recipePath, ProjectFiles } from '@lingtai/project'
import { type RecipeFiles } from '@lingtai/recipe'
import type { SetupReader } from '@lingtai/setup'
import type { RuntimeFound } from '@lingtai/setup'
import { Effect } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type AddWorld, addFlowEffect } from '../src/add.ts'

const fx = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (e) => e })
type AddTestWorld = AddWorld & { project: FirstProjectTestWorld }
const addFlow = (flags: Parameters<typeof addFlowEffect>[0], world: AddTestWorld) =>
  Effect.runPromise(addFlowEffect(flags, world).pipe(Effect.provideService(ProjectFiles, world.project.files)))
import type { GitResult } from '../src/first-project.ts'
/**
 * `addFlow` (#400, #435): `lingtai add` driven from `unit/` with no
 * `lingtai.ts` import — that file calls `main()` on import, which is why
 * `addFlow` lives in its own module (`add.ts`'s own header).
 */
import { askGithubAuthEffect } from '../src/github-auth.ts'
import { stripColour } from '../src/output.ts'
import {
  type FirstProjectTestWorld,
  liftFirstProjectWorld,
  liftPort,
  type PromiseFirstProjectWorld,
} from '../test/first-project-world.ts'
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
  world: AddTestWorld
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
    by: 'human:me',
    store: createMemoryEventStore(),
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
  const world: AddTestWorld = {
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

    const code = await addFlow(flagsFromArgv(['--mode', 'solo']), world)

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

    const code = await addFlow(flagsFromArgv(['--mode', 'solo', '--budget', '7']), world)

    expect(errors).toEqual([])
    expect(code).toBe(0)
    const recipe = await world.project.files.read(recipePath('repo', HOME))
    expect(recipe).toMatch(/usd:\s*7\b/)
  })

  it('a local add prints the card with add <project> and doctor’s count (#773)', async () => {
    const { world, logged } = ttyHarness()
    expect(await addFlow(flagsFromArgv(['--mode', 'solo']), world)).toBe(0)
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
    // Never the live client: it would run `gh auth token` and POST to the repository.
    h.world.labels = () => Effect.succeed({ createLabel: async () => 'created' as const })
    h.world.githubDeps = {
      check: () => Effect.succeed(null),
      auth: () => 'gh',
      interactive: () => true,
      ghAccess: () => Effect.succeed({ login: 'sam', defaultBranch: 'main' }),
      picker: () => fx(async () => ({ installations: [], installUrl: null })),
      reader: () => fx(async () => SETUP_READER),
      ask: async () => '',
      runtimes: () => fx(async () => [{ id: 'claude-code', state: 'signed-in', signedIn: true, detail: 'signed in' }]),
      history: () => Effect.succeed([]),
    }
    if (over.doctorFails === true) {
      h.world.doctor = () =>
        fx(async () => ({
          report: { ok: 20, notChecked: 0, deferred: 0 },
          toFix: { count: 1, failed: true },
          blocks: 'a failing block',
        }))
    }
    const argv = ['acme/widgets', '--mode', 'solo', '--main', 'main', '--install', 'none', '--build', 'none']
    return { ...h, argv }
  }

  /** A machine whose `github.auth` is unset, shared by the early question and `chooseFirstProject`, with every ask counted. */
  function unsetAuthHarness(answer: 'gh' | 'app') {
    const h = githubHarness()
    let auth: 'gh' | 'app' | null = null
    const questions: string[] = []
    const status = async () => ({ ok: true as const, login: 'me', scopes: ['repo', 'workflow'] })
    const count = async (prompt: string) => {
      if (prompt.includes('signed in as me')) questions.push(prompt)
      return prompt.includes('signed in as me') ? answer : ''
    }
    h.world.project.ask = count
    h.world.project.github.auth = () => auth
    h.world.project.github.ghStatus = liftPort(status)
    h.world.project.github.writeAuth = liftPort(async (kind) => {
      auth = kind
    })
    h.world.githubDeps = {
      ...h.world.githubDeps!,
      auth: () => auth,
      githubAuth: (flags) =>
        askGithubAuthEffect(
          {
            ask: async (prompt, shape) => count(shape?.message ?? prompt),
            log: () => {},
            github: {
              auth: () => auth,
              ghStatus: () => fx(status),
              writeAuth: (kind) =>
                Effect.sync(() => {
                  auth = kind
                }),
            },
          },
          flags,
          false,
          'Nothing was written',
        ),
    }
    return { ...h, questions, authNow: () => auth }
  }

  it('asks how this machine reaches GitHub once, and chooseFirstProject does not ask it again (#1487)', async () => {
    const { world, errors, questions, authNow, argv } = unsetAuthHarness('gh')
    const without = argv.filter((a, i) => a !== '--main' && argv[i - 1] !== '--main')
    expect(await addFlow({ ...flagsFromArgv(without), positional: 'acme/widgets' }, world)).toBe(0)
    expect(errors).toEqual([])
    expect(questions).toHaveLength(1)
    expect(authNow()).toBe('gh')
  })

  it('an app answer with --main is asked once as well, and told on rather than asked again (#1487)', async () => {
    const { world, questions, argv } = unsetAuthHarness('app')
    await addFlow({ ...flagsFromArgv(argv), positional: 'acme/widgets' }, world)
    expect(questions).toHaveLength(1)
  })

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

  /** A `labels` stub that records every name asked, answers `exists` for `bug`, and fails the names in `fail` with a status. */
  function labelStub(world: AddTestWorld, fail: Record<string, number> = {}) {
    const asked: string[] = []
    world.labels = () =>
      Effect.succeed({
        createLabel: async (name: string) => {
          asked.push(name)
          const status = fail[name]
          if (status !== undefined) throw Object.assign(new Error(`GitHub ${status}`), { status })
          return name === 'bug' ? ('exists' as const) : ('created' as const)
        },
      })
    return asked
  }

  it('makes the kinds and lingtai:hold, and the card lists the ones it created, never the one that existed (#1486)', async () => {
    const { world, logged, errors, argv } = githubHarness()
    const asked = labelStub(world)
    expect(await addFlow({ ...flagsFromArgv(argv), positional: 'acme/widgets' }, world)).toBe(0)
    expect(errors).toEqual([])
    expect(asked).toContain('bug')
    expect(asked).toContain('feature')
    expect(asked.at(-1)).toBe('lingtai:hold')
    const row = logged
      .join('\n')
      .split('\n')
      .find((l) => /^\s+labels\s+made /.test(l))!
    expect(row).toContain('feature')
    expect(row).toContain('lingtai:hold')
    expect(row).not.toMatch(/\bbug\b/)
  })

  it('does not ask for lingtai:pr-fix in solo mode (#1486)', async () => {
    const { world, errors, argv } = githubHarness()
    const asked = labelStub(world)
    expect(await addFlow({ ...flagsFromArgv(argv), positional: 'acme/widgets' }, world)).toBe(0)
    expect(errors).toEqual([])
    expect(asked).toContain('lingtai:hold')
    expect(asked).not.toContain('lingtai:pr-fix')
  })

  it('a label refused with 403 leaves the add at 0, names the label and its gh line, and makes the rest (#1486)', async () => {
    const { world, logged, errors, argv } = githubHarness()
    const asked = labelStub(world, { feature: 403 })
    expect(await addFlow({ ...flagsFromArgv(argv), positional: 'acme/widgets' }, world)).toBe(0)
    expect(errors).toEqual([])
    const text = logged.join('\n')
    expect(text).toContain('feature could not be made — gh label create feature --repo acme/widgets')
    expect(asked).toContain('lingtai:hold')
    expect(text).toMatch(/labels\s+made .*lingtai:hold/)
  })

  it('a client that cannot be built leaves every label unchecked, and the add at 0 (#1486)', async () => {
    const { world, logged, errors, argv } = githubHarness()
    world.labels = () => Effect.fail(new Error('no App'))
    expect(await addFlow({ ...flagsFromArgv(argv), positional: 'acme/widgets' }, world)).toBe(0)
    expect(errors).toEqual([])
    expect(logged.join('\n')).toContain(
      'lingtai:hold could not be checked — gh label create lingtai:hold --repo acme/widgets',
    )
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
    const parsed = flagsFromArgv(['--mode', 'solo', '--project', 'github', '--github-auth', 'gh'])

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
    const parsed = flagsFromArgv([
      '--mode',
      'solo',
      '--project',
      'github',
      '--github-auth',
      'gh',
      '--agent',
      'claude-code',
    ])

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
    const code = await addFlow(
      flagsFromArgv(['--mode', 'solo', '--github-auth', 'gh', '--agent', 'claude-code']),
      world,
    )
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

    await addFlow(flagsFromArgv(['--mode', 'solo', '--project', 'github', '--github-auth', 'gh']), world)
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
    const parsed = flagsFromArgv(['--mode', 'solo', '--project', 'github', '--github-auth', 'gh'])

    expect(await addFlow(parsed, world)).toBe(2)
    expect(read).toBe(false)
    expect(errors.join('\n')).toContain('no repository was picked')
  })

  const REGISTERED = (owner: string | null) => ({
    project: 'widgets',
    owner,
    base: 'main',
    configHash: 'h',
    fromSha: null,
    refused: null,
    paused: null,
    recipe: null,
    sandboxObserved: null,
    highestPr: null,
    version: 1,
    lastSeq: null,
  })

  /** A first add, then the project registered and the harness's counters reset: what a rerun is run against. */
  async function registeredHarness() {
    const h = githubHarness()
    const added: unknown[] = []
    const first = h.world.project.github.add
    h.world.project.github.add = ((options, log) => {
      added.push(options)
      return first(options, log)
    }) as typeof first
    const labelled = labelStub(h.world)
    expect(await addFlow({ ...flagsFromArgv(h.argv), positional: 'acme/widgets' }, h.world)).toBe(0)
    h.world.project.projects = liftPort(async () => [REGISTERED('acme')])
    const logBefore = await h.world.project.store!.readAll(0n, 1000)
    const recipeBefore = await h.world.project.files.read(recipePath('widgets'))
    added.length = 0
    labelled.length = 0
    h.asked.length = 0
    h.errors.length = 0
    h.logged.length = 0
    return { ...h, added, labelled, logBefore, recipeBefore }
  }

  it('a rerun taking every answer as it is writes nothing, registers nothing, makes no branch and still makes the labels (#1497)', async () => {
    const h = await registeredHarness()
    expect(await addFlow({ ...flagsFromArgv(h.argv), positional: 'acme/widgets' }, h.world)).toBe(0)
    expect(h.errors).toEqual([])
    expect(h.added).toEqual([])
    expect(await h.world.project.store!.readAll(0n, 1000)).toEqual(h.logBefore)
    expect(await h.world.project.files.read(recipePath('widgets'))).toBe(h.recipeBefore)
    expect(h.labelled).toContain('lingtai:hold')
    expect(stripColour(h.logged.join('\n'))).toMatch(/^add {2}widgets {2}unchanged$/m)
  })

  it('a rerun with --defaults is the same: nothing changes (#1497)', async () => {
    const h = await registeredHarness()
    expect(
      await addFlow({ ...flagsFromArgv(['--defaults', '--mode', 'solo']), positional: 'acme/widgets' }, h.world),
    ).toBe(0)
    expect(h.errors).toEqual([])
    expect(h.added).toEqual([])
    expect(await h.world.project.store!.readAll(0n, 1000)).toEqual(h.logBefore)
  })

  it('a changed answer is written through the recipe once and registers again (#1497)', async () => {
    const h = await registeredHarness()
    const argv = h.argv.map((a) => (a === 'none' ? a : a))
    const changed = [...argv.slice(0, argv.indexOf('--build')), '--build', 'pnpm test']
    expect(await addFlow({ ...flagsFromArgv(changed), positional: 'acme/widgets' }, h.world)).toBe(0)
    expect(h.errors).toEqual([])
    expect(h.added).toHaveLength(1)
    const log = await h.world.project.store!.readAll(0n, 1000)
    const fresh = log.slice(h.logBefore.length)
    expect(fresh.filter((e) => e.type === 'ProjectRecipeChanged')).toHaveLength(1)
    expect(await h.world.project.files.read(recipePath('widgets'))).toContain('pnpm test')
    expect(stripColour(h.logged.join('\n'))).not.toMatch(/unchanged/)
  })

  it('a rerun asks the prompts a first add asks, in order (#1497)', async () => {
    const first = githubHarness()
    const seen: string[] = []
    const record = (h: ReturnType<typeof githubHarness>, into: string[]) => {
      const ask = h.world.githubDeps!.ask
      h.world.githubDeps = {
        ...h.world.githubDeps!,
        ask: async (prompt, shape) => {
          into.push(prompt)
          return ask(prompt, shape)
        },
      }
    }
    const bare = first.argv
    record(first, seen)
    expect(await addFlow({ ...flagsFromArgv(bare), positional: 'acme/widgets' }, first.world)).toBe(0)
    const again = githubHarness()
    again.world.project.files = first.world.project.files
    again.world.project.store = first.world.project.store
    again.world.project.projects = liftPort(async () => [REGISTERED('acme')])
    const second: string[] = []
    record(again, second)
    expect(await addFlow({ ...flagsFromArgv(bare), positional: 'acme/widgets' }, again.world)).toBe(0)
    expect(second).toEqual(seen)
  })

  it('a repository of the same name under another owner is still refused, before any question (#1497)', async () => {
    const { world, errors, asked, argv } = githubHarness()
    world.project.projects = liftPort(async () => [REGISTERED('acme')])
    expect(await addFlow({ ...flagsFromArgv(argv), positional: 'other/widgets' }, world)).toBe(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('acme')
    expect(asked).toEqual([])
  })

  it('a rerun whose recipe base is not the registered base registers again rather than answering unchanged (#1497)', async () => {
    const h = await registeredHarness()
    h.world.project.projects = liftPort(async () => [{ ...REGISTERED('acme'), base: 'release' }])
    expect(await addFlow({ ...flagsFromArgv(h.argv), positional: 'acme/widgets' }, h.world)).toBe(0)
    expect(h.added).toHaveLength(1)
  })

  it('a pending project (no ProjectConfigured yet) is registered by the rerun, not answered unchanged (#1497)', async () => {
    const h = await registeredHarness()
    h.world.project.projects = liftPort(async () => [{ ...REGISTERED('acme'), configHash: null }])
    expect(await addFlow({ ...flagsFromArgv([...h.argv, '--defaults']), positional: 'acme/widgets' }, h.world)).toBe(0)
    expect(h.added).toHaveLength(1)
  })

  it('an unchanged rerun still refuses a --local beside the GitHub project (#1497)', async () => {
    const h = await registeredHarness()
    const code = await addFlow(
      { ...flagsFromArgv([...h.argv, '--defaults', '--local', '/another']), positional: 'acme/widgets' },
      h.world,
    )
    expect(code).toBe(1)
    expect(h.errors.join('\n')).toContain('name two different projects')
    expect(h.labelled).toEqual([])
  })

  it('a rerun that registers nothing exits non-zero (#1497)', async () => {
    const h = await registeredHarness()
    h.world.project.projects = liftPort(async () => [{ ...REGISTERED('acme'), base: 'release' }])
    h.world.project.github.add = liftPort(async () => ({ ok: false }) as never)
    expect(await addFlow({ ...flagsFromArgv(h.argv), positional: 'acme/widgets' }, h.world)).toBe(1)
  })

  it('another spelling of a registered repository is refused rather than given a recipe of its own (#1497)', async () => {
    const h = await registeredHarness()
    expect(await addFlow({ ...flagsFromArgv(h.argv), positional: 'acme/Widgets' }, h.world)).toBe(1)
    expect(h.errors.join('\n')).toContain('registered as widgets')
    expect(h.added).toEqual([])
    expect(await h.world.project.files.read(recipePath('Widgets'))).toBeNull()
  })

  it('an unchanged rerun still holds a contradicting --github-auth to the machine (#1497)', async () => {
    const h = await registeredHarness()
    const code = await addFlow(
      { ...flagsFromArgv([...h.argv, '--defaults', '--github-auth', 'app']), positional: 'acme/widgets' },
      h.world,
    )
    expect(code).toBe(1)
    expect(h.errors.join('\n')).toContain('--github-auth app')
    expect(h.labelled).toEqual([])
  })

  it('a rerun over a recipe that does not resolve is refused by name before any question (#1497)', async () => {
    const h = await registeredHarness()
    await h.world.project.files.replace(recipePath('widgets'), 'tier: [unclosed')
    expect(await addFlow({ ...flagsFromArgv(h.argv), positional: 'acme/widgets' }, h.world)).toBe(1)
    expect(h.errors.join('\n')).toContain('does not resolve')
    expect(h.added).toEqual([])
    expect(h.asked).toEqual([])
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
        recipe: null,
        sandboxObserved: null,
        highestPr: null,
        version: 1,
        lastSeq: null,
      },
    ])
    const code = await addFlow({ ...flagsFromArgv(['--mode', 'solo']), positional: 'acme/widgets' }, world)
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
