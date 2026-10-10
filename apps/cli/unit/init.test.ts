/**
 * `machineRuntimeRefusal` (#398): a pure function of the machine's
 * `config.yml`, so the migration message for a file still naming a runtime
 * under `runtime:` or `projects:` is tested without an `InitWorld`.
 *
 * Below it (#434, #435): the end of a local `init` — the recipe printed
 * verbatim, `doctor`'s report, and the board line — and the board's own
 * laziness, all driven from `unit/` with no file on disk: `InitWorld.machine`
 * is a `Map`, so `config.yml` is never read through `node:fs`. Every test
 * passes `--store sqlite`, since the `machine` seam's `read` answers null for
 * a path nothing has written — "nothing chosen" — rather than the
 * `LINGTAI_TEST_SQLITE_PATH` the environment used to answer from before this
 * seam existed.
 */
import type { RecipeFiles } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'

import type { GitResult } from '../src/first-project.ts'
import { type AppCheck, type InitWorld, type RuntimeFound, initCommand, machineRuntimeRefusal } from '../src/init.ts'

const PATH = '/home/me/.lingtai/config.yml'

describe('machineRuntimeRefusal', () => {
  it('refuses a file naming runtime:', () => {
    const config = parseDocument('runtime:\n  agent: codex\n')
    const refusal = machineRuntimeRefusal(config, PATH)
    expect(refusal).toContain(PATH)
    expect(refusal).toContain('runtime.agent')
  })

  it('refuses a file naming projects:', () => {
    const config = parseDocument('projects:\n  app:\n    runtime:\n      agent: codex\n')
    expect(machineRuntimeRefusal(config, PATH)).not.toBeNull()
  })

  it('is null for a file naming neither', () => {
    const config = parseDocument('database:\n  store: sqlite\n')
    expect(machineRuntimeRefusal(config, PATH)).toBeNull()
  })
})

// --------------------------------------------------------------------------

const ENV = { VITEST: '1', HOME: '/nonexistent', LINGTAI_TEST_SQLITE_PATH: '/nonexistent/log.sqlite' }
const HOME = '/nonexistent/.lingtai'

const signedIn = (id: RuntimeFound['id']): RuntimeFound => ({
  id,
  installed: true,
  signedIn: true,
  detail: 'signed in',
})

interface Harness {
  world: InitWorld
  logged: string[]
  asked: string[]
  files: Map<string, string>
  machineFiles: Map<string, string>
  machineWrites: number
  calls: { boardAt: number; board: number }
}

function harness(
  options: {
    gitPlan?: Record<string, GitResult>
    answers?: (string | null)[]
    app?: AppCheck
    doctor?: () => Promise<string>
    boardAt?: string | null
    board?: { url: string } | { refused: string }
    appeared?: { slug: string; owner: string }
  } = {},
): Harness {
  const logged: string[] = []
  const asked: string[] = []
  const files = new Map<string, string>()
  const machineFiles = new Map<string, string>()
  const writes = { count: 0 }
  const calls = { boardAt: 0, board: 0 }
  const answers = [...(options.answers ?? [])]
  const world: InitWorld = {
    env: ENV,
    machine: {
      read: (path) => machineFiles.get(path) ?? null,
      write: (path, text) => {
        machineFiles.set(path, text)
        writes.count++
      },
      describeHome: () => 'nothing yet',
    },
    log: (line) => logged.push(line),
    ask: async (prompt) => {
      asked.push(prompt)
      return answers.length > 0 ? answers.shift()! : null
    },
    git: async () => 'git version 2.50.0',
    runtimes: async () => [signedIn('claude-code')],
    // A lockfile at the root, so `detectSetup` suggests an install command —
    // the one question (`setup-build.ts`'s `askInstall`) that refuses an
    // empty answer outright rather than taking one as "none": a test that
    // answers every question empty, with no `--install` flag, needs a
    // detected default to answer against.
    setupReader: () => ({ has: async (path) => path === 'pnpm-lock.yaml', read: async () => null }),
    database: async () => ({ ok: true, schema: { created: false, repaired: [] } }),
    app: async () => options.app ?? { configured: false },
    appeared: async () => options.appeared ?? { slug: 'lingtai-me', owner: 'me' },
    pressed: (signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
    boardAt: async () => {
      calls.boardAt++
      return options.boardAt ?? null
    },
    board: async () => {
      calls.board++
      return options.board ?? { url: 'http://127.0.0.1:17820' }
    },
    open: async () => true,
    runGit: async (dir, args) => {
      const found = (options.gitPlan ?? {})[`${dir}::${args.join(' ')}`]
      if (found === undefined) throw new Error(`unplanned git call: ${dir}::${args.join(' ')}`)
      return found
    },
    projects: async () => [],
    files: {
      read: async (p) => files.get(p) ?? null,
      replace: async (p, text) => {
        files.set(p, text)
      },
    } as RecipeFiles,
    signedIn: async () => ['claude-code'] as never[],
    registerLocal: async (payload) => `added ${payload.project}`,
    history: async () => [],
    doctor: options.doctor ?? (async () => 'doctor: 3 ok, 0 not checked here, 0 not implemented yet, 0 failed'),
  }
  return {
    world,
    logged,
    asked,
    files,
    machineFiles,
    get machineWrites() {
      return writes.count
    },
    calls,
  }
}

describe('lingtai init ends by printing the recipe, doctor, and the board line (#434)', () => {
  const GIT_PLAN: Record<string, GitResult> = {
    '/repo::rev-parse --show-toplevel': { ok: true, stdout: '/repo\n', stderr: '' },
    '/repo::remote get-url origin': { ok: true, stdout: 'https://github.com/acme/widget.git\n', stderr: '' },
    '/repo::symbolic-ref --short refs/remotes/origin/HEAD': { ok: true, stdout: 'origin/main\n', stderr: '' },
    '/repo::rev-parse --verify main^{commit}': { ok: true, stdout: 'abc123f\n', stderr: '' },
  }

  it('a local init prints the recipe path, the file exactly as written, then doctor, and exits 0 even when doctor warns', async () => {
    const warning =
      'note   a daemon that has never run — nothing has started it yet\n\n2 ok, 1 to note, 0 not checked here, 0 not implemented yet, 0 failed'
    const { world, logged, files, machineFiles } = harness({
      gitPlan: GIT_PLAN,
      answers: [''],
      doctor: async () => warning,
    })

    const code = await initCommand(['--local', '/repo', '--store', 'sqlite', '--defaults', '--install', 'none'], world)
    expect(code).toBe(0)

    // A config written through `world.machine`, and a recipe that resolves
    // (#435's Done-when 1) — `registerLocal` is only reached once
    // `resolveLocalRecipe` has succeeded on the file just written.
    expect(machineFiles.get(`${HOME}/config.yml`)).toContain('store: sqlite')

    const path = `${HOME}/repo/recipe.yml`
    const written = files.get(path)
    expect(written).toBeDefined()

    const pathIndex = logged.indexOf(path)
    expect(pathIndex).toBeGreaterThan(-1)
    // The file's bytes, exactly as read back — not trimmed, not summarised.
    expect(logged[pathIndex + 1]).toBe(written)

    const doctorIndex = logged.indexOf(warning)
    expect(doctorIndex).toBeGreaterThan(pathIndex)

    // Doctor's warning is printed, and it never sets the exit code.
    expect(code).toBe(0)
    expect(logged.at(-1)).toContain('no board was started')
  })

  it('a local init exits 0 even when doctor throws, and prints why it did not finish', async () => {
    const { world, logged } = harness({
      gitPlan: GIT_PLAN,
      answers: [''],
      doctor: async () => {
        throw new Error('the beacon file does not parse')
      },
    })

    const code = await initCommand(['--local', '/repo', '--store', 'sqlite', '--defaults', '--install', 'none'], world)

    expect(code).toBe(0)
    expect(logged).toContain('doctor did not finish — the beacon file does not parse')
    expect(logged.at(-1)).toContain('no board was started')
  })

  it('a local init never binds a board, though it probes the port once to say whether one is already running', async () => {
    const { world, calls } = harness({ gitPlan: GIT_PLAN, answers: [''] })

    const code = await initCommand(['--local', '/repo', '--store', 'sqlite', '--defaults', '--install', 'none'], world)
    expect(code).toBe(0)
    expect(calls).toEqual({ boardAt: 1, board: 0 })
  })

  it('a local init, with a board already running on the port, says so rather than naming a `lingtai board` that would refuse', async () => {
    const { world, logged, calls } = harness({ gitPlan: GIT_PLAN, answers: [''], boardAt: 'http://127.0.0.1:17820' })

    const code = await initCommand(['--local', '/repo', '--store', 'sqlite', '--defaults', '--install', 'none'], world)
    expect(code).toBe(0)
    expect(calls).toEqual({ boardAt: 1, board: 0 })
    expect(logged.at(-1)).toContain('the board was already running at http://127.0.0.1:17820 — this started none')
  })

  it('the GitHub branch starts the board only when boardUrl() is first asked, and only once', async () => {
    let countsWhenProjectAsked: { boardAt: number; board: number } | null = null
    const { world, calls, logged } = harness({
      // The project-and-App question (#393) is answered directly, and the
      // moment of answering it is also the moment to check the board has not
      // started yet — nothing upstream has asked for a URL before this.
      answers: [],
    })
    world.ask = async (question) => {
      if (/a GitHub project/.test(question)) {
        countsWhenProjectAsked = { ...calls }
        return 'github'
      }
      if (/the GitHub App now/.test(question)) return 'create'
      return null
    }

    const code = await initCommand(['--store', 'sqlite'], world)
    expect(code).toBe(0)

    expect(countsWhenProjectAsked).toEqual({ boardAt: 0, board: 0 })
    // Asked for twice over the run — once for `waitForApp`'s own URL, once
    // more to print "next, install it…" — and started only once: `startBoard`
    // memoises rather than asking `boardAt`/`board` a second time.
    expect(calls).toEqual({ boardAt: 1, board: 1 })
    expect(logged.join('\n')).toContain('next, install it and pick a repository')
    expect(logged.join('\n')).toContain('the board keeps running in this terminal')
  })
})

// --------------------------------------------------------------------------

/**
 * #400's four Done-when tests (#435): `init` driven end to end with an
 * injected world — no `node:fs`, no database, no network.
 */
describe('init and add, driven end to end from unit/ (#400, #435)', () => {
  const GIT_PLAN: Record<string, GitResult> = {
    '/repo::rev-parse --show-toplevel': { ok: true, stdout: '/repo\n', stderr: '' },
    '/repo::remote get-url origin': { ok: true, stdout: 'https://github.com/acme/widget.git\n', stderr: '' },
    '/repo::symbolic-ref --short refs/remotes/origin/HEAD': { ok: true, stdout: 'origin/main\n', stderr: '' },
    '/repo::rev-parse --verify main^{commit}': { ok: true, stdout: 'abc123f\n', stderr: '' },
  }

  it('a non-TTY init with every question answered by a flag writes a config and a recipe that resolves, and exits 0', async () => {
    const { world, files, machineFiles, logged } = harness({ gitPlan: GIT_PLAN })

    const code = await initCommand(
      ['--local', '/repo', '--store', 'sqlite', '--base', 'main', '--defaults', '--install', 'none'],
      world,
    )

    expect(code).toBe(0)
    expect(machineFiles.get(`${HOME}/config.yml`)).toContain('store: sqlite')
    const path = `${HOME}/repo/recipe.yml`
    expect(files.get(path)).toBeDefined()
    expect(logged).toContain(path)
  })

  it('--defaults, with every other question also answered by a flag, asks nothing — not the store, not the project, not a recipe question', async () => {
    const { world, asked } = harness({ gitPlan: GIT_PLAN })

    const code = await initCommand(
      ['--local', '/repo', '--store', 'sqlite', '--base', 'main', '--defaults', '--install', 'none'],
      world,
    )

    expect(code).toBe(0)
    expect(asked).toEqual([])
  })

  it('a re-run with every answer empty leaves config.yml and recipe.yml byte-for-byte unchanged, and writes the machine file no further', async () => {
    const h = harness({ gitPlan: GIT_PLAN })
    // Every question's own default, including "use every default?" itself —
    // which, taken, answers every recipe question underneath it too, so a
    // re-run needs nothing scripted beyond this one function.
    h.world.ask = async () => ''

    const argv = ['--local', '/repo']
    const first = await initCommand(argv, h.world)
    expect(first).toBe(0)

    const configKey = `${HOME}/config.yml`
    const recipeKey = `${HOME}/repo/recipe.yml`
    const configAfterFirst = h.machineFiles.get(configKey)
    const recipeAfterFirst = h.files.get(recipeKey)
    expect(configAfterFirst).toBeDefined()
    expect(recipeAfterFirst).toBeDefined()
    const writesAfterFirst = h.machineWrites

    expect(await initCommand(argv, h.world)).toBe(0)

    // A settled store is reported, not rewritten (this file's header), and a
    // recipe re-asked with every answer unchanged renders no differently
    // (`write.ts`'s `editRecipe`) — so the second run changes neither file.
    expect(h.machineFiles.get(configKey)).toBe(configAfterFirst)
    expect(h.files.get(recipeKey)).toBe(recipeAfterFirst)
    expect(h.machineWrites).toBe(writesAfterFirst)
  })
})
