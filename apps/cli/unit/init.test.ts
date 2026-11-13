import type { GhStatus } from '@lingtai/github'
import type { RecipeFiles } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'

import type { GitResult } from '../src/first-project.ts'
import {
  type AppCheck,
  type InitWorld,
  type RuntimeFound,
  initCommandEffect,
  machineRuntimeRefusal,
} from '../src/init.ts'
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
import { githubInitSteps, hereSteps, localInitSteps } from '../src/next-steps.ts'
import { type NextStep, renderNextBlock, renderNextLine, stripColour } from '../src/output.ts'
import { liftPort } from '../test/first-project-world.ts'
import { flagsFromArgv } from '../test/flags.ts'
import { type PromiseInitWorld, liftInitWorld, signalPort } from '../test/init-world.ts'

/** `initCommandEffect`, run to its exit code, the way every test here awaited `initCommand`. */
const initCommand = (args: Parameters<typeof initCommandEffect>[0], world: InitWorld): Promise<number> =>
  Effect.runPromise(initCommandEffect(args, world))

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
  state: 'signed-in',
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

/** Every printed line, split, colour removed. */
function lines(logged: string[]): string[] {
  return logged.flatMap((l) => l.split('\n')).map(stripColour)
}

/** The block `init` should close on, drawn: the last lines printed are exactly these. */
function expectClosesOn(logged: string[], steps: readonly NextStep[]): void {
  const drawn = renderNextBlock(steps).map(stripColour)
  expect(lines(logged).slice(-drawn.length)).toEqual(drawn)
}

/** A failure closes on one `NEXT` line, with no number. */
function expectClosesOnLine(logged: string[], command: string): void {
  expect(lines(logged).at(-1)).toBe(stripColour(renderNextLine(command)))
  expect(lines(logged).at(-1)).not.toMatch(/ 1 /)
}

function harness(
  options: {
    gitPlan?: Record<string, GitResult>
    answers?: (string | null)[]
    app?: AppCheck
    doctor?: () => Promise<{ text: string; failed: boolean; count?: number }>
    boardAt?: string | null
    board?: { url: string } | { refused: string }
    appeared?: { slug: string; owner: string }
    ghStatus?: GhStatus
    cwd?: string
    doctorNext?: string
  } = {},
): Harness {
  const logged: string[] = []
  const asked: string[] = []
  const files = new Map<string, string>()
  const machineFiles = new Map<string, string>()
  const writes = { count: 0 }
  const calls = { boardAt: 0, board: 0 }
  const answers = [...(options.answers ?? [])]
  const world: PromiseInitWorld = {
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
    exists: async () => true,
    setupReader: () => ({ has: (path) => Effect.succeed(path === 'pnpm-lock.yaml'), read: () => Effect.succeed(null) }),
    database: async () => ({ ok: true, schema: { created: false, repaired: [] } }),
    ghStatus: async () => options.ghStatus ?? { ok: false, reason: 'missing', detail: 'gh is not installed' },
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
    locker: { tryLock: async () => ({ ok: true as const, lock: { release: async () => {} } }) },
    cwd: options.cwd ?? '/elsewhere',
    files: {
      read: async (p) => files.get(p) ?? null,
      replace: async (p, text) => {
        files.set(p, text)
      },
    } as RecipeFiles,
    signedIn: async () => ['claude-code'] as never[],
    registerLocal: async (payload) => ({ line: `added ${payload.project}`, updated: false }),
    history: async () => [],
    doctor: async () => {
      const said: { text: string; failed: boolean; count?: number } = await (
        options.doctor ??
        (async () => ({ text: 'doctor: 3 ok, 0 not checked here, 0 not implemented yet, 0 failed', failed: false }))
      )()
      return {
        report: { ok: 3, notChecked: 0, deferred: 0 },
        toFix: { count: said.count ?? (said.failed ? 1 : 0), failed: said.failed },
        blocks: said.text,
        ...(options.doctorNext === undefined ? {} : { next: options.doctorNext }),
      }
    },
  }
  return {
    world: liftInitWorld(world),
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

const LOCAL_ARGS = ['--local', '/repo', '--store', 'sqlite', '--defaults', '--install', 'none']

describe('lingtai init ends by printing the recipe, doctor, and the board line (#434)', () => {
  const GIT_PLAN: Record<string, GitResult> = {
    '/repo::rev-parse --show-toplevel': { ok: true, stdout: '/repo\n', stderr: '' },
    '/repo::rev-parse --verify refs/heads/lingtai-base^{commit}': { ok: true, stdout: 'abc123f\n', stderr: '' },
    '/repo::rev-parse --verify refs/heads/main^{commit}': { ok: true, stdout: 'abc123f\n', stderr: '' },
  }

  it('a local init prints the recipe path, the file exactly as written, then doctor, and exits 0 even when doctor warns', async () => {
    const warning =
      'note   a daemon that has never run — nothing has started it yet\n\n2 ok, 1 to note, 0 not checked here, 0 not implemented yet, 0 failed'
    const { world, logged, files, machineFiles } = harness({
      gitPlan: GIT_PLAN,
      answers: [''],
      doctor: async () => ({ text: warning, failed: false, count: 1 }),
    })

    const code = await initCommand(
      flagsFromArgv(['--local', '/repo', '--store', 'sqlite', '--defaults', '--install', 'none']),
      world,
    )
    expect(code).toBe(0)

    // A config written through `world.machine`, and a recipe that resolves
    // (#435's Done-when 1) — `registerLocal` is only reached once
    // `resolveLocalRecipe` has succeeded on the file just written.
    expect(machineFiles.get(`${HOME}/config.yml`)).toContain('store: sqlite')

    const path = `${HOME}/repo/recipe.yml`
    const written = files.get(path)
    expect(written).toBeDefined()

    const readyIndex = logged.findIndex((line) => line.includes(path) && /ready/.test(line))
    expect(readyIndex).toBeGreaterThan(-1)
    // The path only — the file's body is not printed.
    expect(logged.join('\n')).not.toContain('repo:')

    // The ready line, then doctor's blocks.
    const doctorIndex = logged.indexOf(warning)
    expect(doctorIndex).toBe(readyIndex + 1)

    // Doctor's warning is printed, and it never sets the exit code.
    expect(code).toBe(0)
    expectClosesOn(logged, localInitSteps(true))
  })

  it('under NO_COLOR, a local init with --defaults ends on the card and nothing between the questions and it (#773)', async () => {
    const before = process.env['NO_COLOR']
    process.env['NO_COLOR'] = '1'
    try {
      const { world, logged } = harness({
        gitPlan: GIT_PLAN,
        answers: [''],
        doctor: async () => ({ text: 'doctor: 3 ok', failed: false }),
      })
      const code = await initCommand(
        flagsFromArgv(['--local', '/repo', '--store', 'sqlite', '--defaults', '--install', 'none']),
        world,
      )
      expect(code).toBe(0)
      const text = logged.join('\n')
      expect(stripColour(text)).toBe(text)
      for (const gone of ['Machine', 'Store', 'GitHub App', 'Projects', 'Before registering', 'Board']) {
        expect(text).not.toMatch(new RegExp(`^${gone}$`, 'm'))
      }
      expect(text).not.toMatch(/^added .* tier /m)
      expect(text).not.toMatch(/^(tickets|kinds|landing) {2,}/m)
      expect(text).not.toContain('no board was started')
      expect(text).not.toContain('manifest flow')
      const rows = text.split('\n').map((l) => l.trimStart())
      const row = (label: string) => rows.find((l) => l.startsWith(`${label} `))
      expect(rows).toContain('init  repo')
      expect(row('home')).toMatch(/^home\s+~\/\.lingtai\s+new$/)
      expect(row('log')).toMatch(/^log\s+SQLite/)
      expect(row('agents')).toMatch(/claude-code/)
      expect(row('tickets')).toBeDefined()
      expect(row('trial')).toBeDefined()
      expect(text).toMatch(/ready/)
      expect(text).toContain('/nonexistent/.lingtai/repo/recipe.yml')
      expect(text).toContain('[next] 1 lingtai board — the board, leave it running')
    } finally {
      if (before === undefined) delete process.env['NO_COLOR']
      else process.env['NO_COLOR'] = before
    }
  })

  it('with two warnings the ready line is followed by both of doctor’s blocks, then the closing line (#773)', async () => {
    const { world, logged } = harness({
      gitPlan: GIT_PLAN,
      answers: [''],
      doctor: async () => ({ text: 'note   first block\n\nnote   second block', failed: false, count: 2 }),
    })
    expect(await initCommand(flagsFromArgv(LOCAL_ARGS), world)).toBe(0)
    const text = stripColour(logged.join('\n'))
    const ready = text.indexOf('✓ ready · 2 to fix')
    expect(ready).toBeGreaterThan(-1)
    expect(text.indexOf('first block')).toBeGreaterThan(ready)
    expect(text.indexOf('second block')).toBeGreaterThan(text.indexOf('first block'))
    expect(text.indexOf('[next]')).toBeGreaterThan(text.indexOf('second block'))
  })

  it('init --project github ends on this machine alone, then a ready line with no recipe (#755)', async () => {
    const { world, logged } = harness({
      ghStatus: { ok: true, login: 'steven', scopes: ['repo', 'workflow'] },
    })
    world.ask = async (question) =>
      /a GitHub project/.test(question) ? 'github' : /signed in as steven/.test(question) ? '' : null
    expect(await initCommand(flagsFromArgv(['--store', 'sqlite']), world)).toBe(0)
    const text = stripColour(logged.join('\n'))
    expect(text).toMatch(/^this machine$/m)
    expect(text).toMatch(/github\s+gh, signed in as steven/)
    expect(text).not.toMatch(/^(Machine|Store|GitHub App)$/m)
    expect(text).not.toContain('this project')
    expect(text).not.toContain('each attempt')
    expect(text).not.toContain('the recipe is written once')
    expect(text).toMatch(/^✓ ready — doctor: [^\n]*[^\n]$/m)
    expect(text).not.toMatch(/ready[^\n]*recipe:/)
  })

  it('a local init exits 0 even when doctor throws, and prints why it did not finish', async () => {
    const { world, logged } = harness({
      gitPlan: GIT_PLAN,
      answers: [''],
      doctor: async () => {
        throw new Error('the beacon file does not parse')
      },
    })

    const code = await initCommand(
      flagsFromArgv(['--local', '/repo', '--store', 'sqlite', '--defaults', '--install', 'none']),
      world,
    )

    expect(code).toBe(0)
    expect(stripColour(logged.join('\n'))).toContain(
      'not ready — doctor did not finish (the beacon file does not parse)',
    )
    expectClosesOnLine(logged, 'lingtai doctor --verbose')
  })

  const LOCAL = LOCAL_ARGS

  it('with a board serving and doctor green, the one closing line is ticket new and run', async () => {
    const { world, logged } = harness({ gitPlan: GIT_PLAN, answers: [''], boardAt: 'http://127.0.0.1:17820' })
    expect(await initCommand(flagsFromArgv(LOCAL), world)).toBe(0)
    expectClosesOn(logged, localInitSteps(false))
  })

  it('a failing doctor closes on its first fix, alone', async () => {
    const { world, logged } = harness({
      gitPlan: GIT_PLAN,
      answers: [''],
      boardAt: 'http://127.0.0.1:17820',
      doctor: async () => ({ text: '1 failed', failed: true }),
      doctorNext: 'lingtai init',
    })
    expect(await initCommand(flagsFromArgv(LOCAL), world)).toBe(0)
    expectClosesOnLine(logged, 'lingtai init')
    expect(lines(logged).filter((l) => l.includes('[next]'))).toHaveLength(1)
  })

  it('exactly one NEXT block appears on the local path, and it is the last', async () => {
    const { world, logged } = harness({ gitPlan: GIT_PLAN, answers: [''] })
    expect(await initCommand(flagsFromArgv(LOCAL), world)).toBe(0)
    expect(lines(logged).filter((l) => l.includes('[next]'))).toHaveLength(1)
    expectClosesOn(logged, localInitSteps(true))
  })

  it('re-running init on a machine with a project ends the same way, once', async () => {
    const { world, logged } = harness({ gitPlan: GIT_PLAN, answers: [''] })
    world.projects = liftPort(async () => [{ name: 'repo' }] as never)
    expect(await initCommand(flagsFromArgv(['--store', 'sqlite', '--defaults']), world)).toBe(0)
    expect(lines(logged).filter((l) => l.includes('[next]'))).toHaveLength(1)
    // The directory is not a git repository here (no git plan for it): `lingtai add` asks which.
    expectClosesOn(logged, hereSteps({ kind: 'outside' }).steps)
  })

  it('a local init never binds a board, though it probes the port once to say whether one is already running', async () => {
    const { world, calls } = harness({ gitPlan: GIT_PLAN, answers: [''] })

    const code = await initCommand(
      flagsFromArgv(['--local', '/repo', '--store', 'sqlite', '--defaults', '--install', 'none']),
      world,
    )
    expect(code).toBe(0)
    expect(calls).toEqual({ boardAt: 1, board: 0 })
  })

  it('a local init, with a board already running on the port, does not name a `lingtai board` that would refuse', async () => {
    const { world, logged, calls } = harness({ gitPlan: GIT_PLAN, answers: [''], boardAt: 'http://127.0.0.1:17820' })

    const code = await initCommand(
      flagsFromArgv(['--local', '/repo', '--store', 'sqlite', '--defaults', '--install', 'none']),
      world,
    )
    expect(code).toBe(0)
    expect(calls).toEqual({ boardAt: 1, board: 0 })
    // The card has no row for the board; the block simply does not name `lingtai board`.
    expect(logged.join('\n')).not.toContain('the board was already running')
    expectClosesOn(logged, localInitSteps(false))
  })

  it('a local init on a machine with a configured App says nothing of it', async () => {
    const { world, logged } = harness({
      gitPlan: GIT_PLAN,
      answers: [''],
      app: { configured: true, ok: true, slug: 'lingtai-me', owner: 'me' } as never,
    })
    expect(await initCommand(flagsFromArgv(['--local', '/repo', '--store', 'sqlite', '--defaults']), world)).toBe(0)
    const text = logged.join('\n')
    expect(text).not.toContain('GitHub App')
    expect(text).not.toContain('it answered')
  })

  it('a GitHub init with a configured App names it on the github row', async () => {
    const { world, logged } = harness({
      app: { configured: true, ok: true, slug: 'lingtai-me', owner: 'me' } as never,
    })
    world.ask = async (question) => (/a GitHub project/.test(question) ? 'github' : null)
    expect(await initCommand(flagsFromArgv(['--store', 'sqlite']), world)).toBe(0)
    const text = logged.join('\n')
    expect(text).toMatch(/github\s+the App lingtai-me/)
    expect(text.match(/the App lingtai-me/g)).toHaveLength(1)
  })

  it('a re-run on a machine with projects and a configured App names it on the github row once', async () => {
    const { world, logged } = harness({
      app: { configured: true, ok: true, slug: 'lingtai-me', owner: 'me' } as never,
    })
    world.projects = liftPort(async () => [{ name: 'repo' }] as never)
    expect(await initCommand(flagsFromArgv(['--store', 'sqlite', '--defaults']), world)).toBe(0)
    const text = logged.join('\n')
    expect(text).toMatch(/github\s+the App lingtai-me/)
    expect(text.match(/the App lingtai-me/g)).toHaveLength(1)
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
      if (/GitHub App of its own/.test(question)) return 'app'
      if (/the GitHub App now/.test(question)) return 'create'
      return null
    }

    const code = await initCommand(flagsFromArgv(['--store', 'sqlite']), world)
    expect(code).toBe(0)

    expect(countsWhenProjectAsked).toEqual({ boardAt: 0, board: 0 })
    // Asked for twice over the run — once for `waitForApp`'s own URL, once
    // more to print "next, install it…" — and started only once: `startBoard`
    // memoises rather than asking `boardAt`/`board` a second time.
    expect(calls).toEqual({ boardAt: 1, board: 1 })
    expect(logged.join('\n')).toContain('the board keeps running in this terminal')
    expect(lines(logged).filter((l) => l.includes('[next]'))).toHaveLength(1)
    expectClosesOn(logged, githubInitSteps('http://127.0.0.1:17820/setup/repository'))
  })

  it('the App skipped closes on lingtai add, last and once', async () => {
    const { world, logged } = harness()
    world.pressed = signalPort(async () => {})
    world.appeared = signalPort(
      (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    )
    world.ask = async (question) =>
      /a GitHub project/.test(question)
        ? 'github'
        : /GitHub App of its own/.test(question)
          ? 'app'
          : /the GitHub App now/.test(question)
            ? 'create'
            : null
    expect(await initCommand(flagsFromArgv(['--store', 'sqlite']), world)).toBe(0)
    expect(lines(logged).filter((l) => l.includes('[next]'))).toHaveLength(1)
    expectClosesOn(logged, githubInitSteps())
  })

  it('a configured App closes on lingtai add, last and once', async () => {
    const { world, logged } = harness({ app: { configured: true, ok: true, slug: 'lingtai-me', owner: 'me' } as never })
    world.ask = async (question) => (/a GitHub project/.test(question) ? 'github' : null)
    expect(await initCommand(flagsFromArgv(['--store', 'sqlite']), world)).toBe(0)
    expect(lines(logged).filter((l) => l.includes('[next]'))).toHaveLength(1)
    expectClosesOn(logged, githubInitSteps())
  })

  it('a re-run with a configured App and projects closes on the directory block', async () => {
    const { world, logged } = harness({ app: { configured: true, ok: true, slug: 'lingtai-me', owner: 'me' } as never })
    world.projects = liftPort(async () => [{ name: 'repo' }] as never)
    expect(await initCommand(flagsFromArgv(['--store', 'sqlite', '--defaults']), world)).toBe(0)
    expectClosesOn(logged, hereSteps({ kind: 'outside' }).steps)
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
    '/repo::rev-parse --verify refs/heads/lingtai-base^{commit}': { ok: true, stdout: 'abc123f\n', stderr: '' },
    '/repo::rev-parse --verify refs/heads/main^{commit}': { ok: true, stdout: 'abc123f\n', stderr: '' },
  }

  it('a non-TTY init with every question answered by a flag writes a config and a recipe that resolves, and exits 0', async () => {
    const { world, files, machineFiles, logged } = harness({ gitPlan: GIT_PLAN })

    const code = await initCommand(
      flagsFromArgv(['--local', '/repo', '--store', 'sqlite', '--base', 'main', '--defaults', '--install', 'none']),
      world,
    )

    expect(code).toBe(0)
    expect(machineFiles.get(`${HOME}/config.yml`)).toContain('store: sqlite')
    const path = `${HOME}/repo/recipe.yml`
    expect(files.get(path)).toBeDefined()
    expect(logged.some((line) => line.includes(path))).toBe(true)
  })

  it('--defaults, with every other question also answered by a flag, asks nothing — not the store, not the project, not a recipe question', async () => {
    const { world, asked } = harness({ gitPlan: GIT_PLAN })

    const code = await initCommand(
      flagsFromArgv(['--local', '/repo', '--store', 'sqlite', '--base', 'main', '--defaults', '--install', 'none']),
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
    const first = await initCommand(flagsFromArgv(argv), h.world)
    expect(first).toBe(0)

    const configKey = `${HOME}/config.yml`
    const recipeKey = `${HOME}/repo/recipe.yml`
    const configAfterFirst = h.machineFiles.get(configKey)
    const recipeAfterFirst = h.files.get(recipeKey)
    expect(configAfterFirst).toBeDefined()
    expect(recipeAfterFirst).toBeDefined()
    const writesAfterFirst = h.machineWrites

    expect(await initCommand(flagsFromArgv(argv), h.world)).toBe(0)

    // A settled store is reported, not rewritten (this file's header), and a
    // recipe re-asked with every answer unchanged renders no differently
    // (`write.ts`'s `editRecipe`) — so the second run changes neither file.
    expect(h.machineFiles.get(configKey)).toBe(configAfterFirst)
    expect(h.files.get(recipeKey)).toBe(recipeAfterFirst)
    expect(h.machineWrites).toBe(writesAfterFirst)
  })
})

describe('lingtai init asks how this machine reaches GitHub (#710)', () => {
  it('a signed-in gh is the default: github.auth is written, no board starts, and it ends with lingtai add', async () => {
    const { world, calls, logged, machineFiles } = harness({
      ghStatus: { ok: true, login: 'steven', scopes: ['repo', 'workflow'] },
    })
    let opened = 0
    world.open = liftPort(async () => {
      opened++
      return true
    })
    world.ask = async (question) =>
      /a GitHub project/.test(question) ? 'github' : /signed in as steven/.test(question) ? '' : null

    const code = await initCommand(flagsFromArgv(['--store', 'sqlite']), world)
    expect(code).toBe(0)
    expect(parseDocument(machineFiles.get('/nonexistent/.lingtai/config.yml')!).getIn(['github', 'auth'])).toBe('gh')
    expect(calls.board).toBe(0)
    expect(opened).toBe(0)
    expect(lines(logged).filter((l) => l.includes('[next]'))).toHaveLength(1)
    expectClosesOn(logged, githubInitSteps())
    expect(logged.join('\n')).not.toContain('GitHub App')
  })

  it('a failing doctor closes the gh path on one NEXT line; a warning closes on the block', async () => {
    const run = async (doctor: () => Promise<{ text: string; failed: boolean; count?: number }>) => {
      const { world, logged } = harness({
        ghStatus: { ok: true, login: 'steven', scopes: ['repo', 'workflow'] },
        doctor,
      })
      world.ask = async (question) =>
        /a GitHub project/.test(question) ? 'github' : /signed in as steven/.test(question) ? '' : null
      expect(await initCommand(flagsFromArgv(['--store', 'sqlite']), world)).toBe(0)
      return logged
    }
    const failed = await run(async () => ({ text: '1 failed', failed: true }))
    expectClosesOnLine(failed, 'lingtai doctor --verbose')
    const warned = await run(async () => ({ text: '1 warning', failed: false }))
    expectClosesOn(warned, githubInitSteps())
  })

  it('--github-auth gh signed out refuses by name and writes no github.auth', async () => {
    const { world, logged, machineFiles } = harness()
    const code = await initCommand(
      flagsFromArgv(['--store', 'sqlite', '--project', 'github', '--github-auth', 'gh']),
      world,
    )
    expect(code).toBe(1)
    expect(stripColour(logged.join('\n'))).toContain('--github-auth gh, but gh is not installed')
    const file = machineFiles.get('/nonexistent/.lingtai/config.yml') ?? ''
    expect(file).not.toContain('auth: gh')
  })
})

describe('init on a machine that already has projects names the directory it was run in (#756)', () => {
  const run = async (cwd: string, plan: Record<string, GitResult>, files: Record<string, string> = {}) => {
    const { world, logged, files: store } = harness({ gitPlan: plan, cwd })
    for (const [k, v] of Object.entries(files)) store.set(k, v)
    world.projects = liftPort(async () => [{ project: 'widgets', owner: 'acme' }] as never)
    expect(await initCommand(flagsFromArgv(['--store', 'sqlite', '--defaults']), world)).toBe(0)
    return logged
  }

  it('an unregistered repository gets `is not a project here` and add --local with its absolute top level', async () => {
    const logged = await run('/work/clone', {
      '/work/clone::rev-parse --show-toplevel': { ok: true, stdout: '/work/clone\n', stderr: '' },
    })
    const { preface, steps } = hereSteps({ kind: 'unregistered', toplevel: '/work/clone' })
    expect(lines(logged)).toContain(preface)
    expectClosesOn(logged, steps)
    expect(steps[0]!.command).toBe('lingtai add --local /work/clone')
  })

  it('a registered project (name compared case-insensitively) is offered a ticket and start', async () => {
    const logged = await run(
      '/work/Widgets',
      { '/work/Widgets::rev-parse --show-toplevel': { ok: true, stdout: '/work/Widgets\n', stderr: '' } },
      {
        [`${HOME}/widgets/recipe.yml`]:
          'version: 2\nrepo:\n  base: main\nenv:\n  plantAt: .env.local\nsource:\n  tickets: github\n  kinds: [bug, feature]\n',
      },
    )
    expectClosesOn(logged, [
      { command: 'gh issue create -R acme/widgets --label bug', for: 'a ticket for it, with a kind label' },
      { command: 'lingtai start', for: 'takes it, if nothing is taking work already' },
    ])
  })

  it('an omitted source.tickets is github, and kinds under steps.claim queue are the ones named', async () => {
    const logged = await run(
      '/work/widgets',
      { '/work/widgets::rev-parse --show-toplevel': { ok: true, stdout: '/work/widgets\n', stderr: '' } },
      {
        [`${HOME}/widgets/recipe.yml`]:
          'version: 2\nrepo:\n  base: main\nenv:\n  plantAt: .env.local\nsource:\n  kinds: [obsolete]\nsteps:\n  claim:\n    - name: pick\n      queue:\n        kinds: [tech debt, bug]\n        exclude: []\n        backoff: 1h\n        assignee:\n          take: unassigned\n',
      },
    )
    expect(lines(logged).join('\n')).toContain("gh issue create -R acme/widgets --label 'tech debt'")
  })

  it('a git failure is not inside a repository, never a project', async () => {
    const logged = await run('/tmp/x', { '/tmp/x::rev-parse --show-toplevel': { ok: false, stdout: '', stderr: 'no' } })
    expectClosesOn(logged, hereSteps({ kind: 'outside' }).steps)
    expect(lines(logged).join('\n')).not.toContain('is not a project here')
  })

  it('a failed doctor drops the preface and closes on its one line', async () => {
    const { world, logged } = harness({
      gitPlan: { '/work/clone::rev-parse --show-toplevel': { ok: true, stdout: '/work/clone\n', stderr: '' } },
      cwd: '/work/clone',
      doctor: async () => ({ text: '1 failed', failed: true }),
      doctorNext: 'lingtai init',
    })
    world.projects = liftPort(async () => [{ project: 'widgets', owner: 'acme' }] as never)
    expect(await initCommand(flagsFromArgv(['--store', 'sqlite', '--defaults']), world)).toBe(0)
    expectClosesOnLine(logged, 'lingtai init')
    expect(lines(logged).join('\n')).not.toContain('is not a project here')
  })
})
