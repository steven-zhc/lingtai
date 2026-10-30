import type { GhStatus } from '@lingtai/github'
import type { RecipeFiles } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'

import type { GitResult } from '../src/first-project.ts'
import { type AppCheck, type InitWorld, type RuntimeFound, initCommand, machineRuntimeRefusal } from '../src/init.ts'
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
import { stripColour } from '../src/output.ts'
import { flagsFromArgv } from '../test/flags.ts'

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

function nextLines(logged: string[]): string[] {
  return logged.flatMap((l) => l.split('\n')).filter((l) => l.startsWith('next:'))
}

function harness(
  options: {
    gitPlan?: Record<string, GitResult>
    answers?: (string | null)[]
    app?: AppCheck
    doctor?: () => Promise<{ text: string; failed: boolean }>
    boardAt?: string | null
    board?: { url: string } | { refused: string }
    appeared?: { slug: string; owner: string }
    ghStatus?: GhStatus
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
    exists: async () => true,
    setupReader: () => ({ has: async (path) => path === 'pnpm-lock.yaml', read: async () => null }),
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
    files: {
      read: async (p) => files.get(p) ?? null,
      replace: async (p, text) => {
        files.set(p, text)
      },
    } as RecipeFiles,
    signedIn: async () => ['claude-code'] as never[],
    registerLocal: async (payload) => `added ${payload.project}`,
    history: async () => [],
    doctor:
      options.doctor ??
      (async () => ({ text: 'doctor: 3 ok, 0 not checked here, 0 not implemented yet, 0 failed', failed: false })),
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
      doctor: async () => ({ text: warning, failed: false }),
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

    const pathIndex = logged.findIndex((line) => line.includes(path))
    expect(pathIndex).toBeGreaterThan(-1)
    // The path only — the file's body is not printed.
    expect(logged.join('\n')).not.toContain('repo:')

    const doctorIndex = logged.indexOf(warning)
    expect(doctorIndex).toBeGreaterThan(pathIndex)

    // Doctor's warning is printed, and it never sets the exit code.
    expect(code).toBe(0)
    expect(logged.at(-1)).toBe('next: lingtai board · lingtai ticket new · lingtai run')
  })

  it('under NO_COLOR, a local init with --defaults still prints every fact the old output did, in plain sections (#620)', async () => {
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
      for (const heading of ['init', 'Machine', 'Store', 'Projects', 'Board']) {
        expect(text).toContain(heading)
      }
      // The git version, every runtime's state, and the home line.
      expect(text).toMatch(/git\s+git version 2\.50\.0/)
      expect(text).toMatch(/claude-code\s+signed in/)
      expect(text).toMatch(/home\s+\/nonexistent\/\.lingtai — nothing yet/)
      // The store row, the app row, the project row.
      expect(text).toMatch(/store\s+SQLite/)
      expect(text).not.toContain('GitHub App')
      expect(text).not.toContain('manifest flow')
      expect(text.match(/^Projects$/gm)).toHaveLength(1)
      expect(text).toMatch(/project\s+local — repo, registered with its own origin as repo.remote/)
      // The recipe's path and text, then the doctor text and the board row.
      expect(text).toContain('/nonexistent/.lingtai/repo/recipe.yml')
      expect(text).not.toContain('repo:')
      expect(text).toContain('doctor: 3 ok')
      expect(text).toContain('no board was started')
      expect(text).toContain('next: lingtai board · lingtai ticket new · lingtai run')
    } finally {
      if (before === undefined) delete process.env['NO_COLOR']
      else process.env['NO_COLOR'] = before
    }
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
    expect(logged).toContain('doctor did not finish — the beacon file does not parse')
    expect(logged.at(-1)).toBe('next: lingtai doctor --verbose · lingtai board · lingtai ticket new · lingtai run')
  })

  const LOCAL = ['--local', '/repo', '--store', 'sqlite', '--defaults', '--install', 'none']

  it('with a board serving and doctor green, the one closing line is ticket new and run', async () => {
    const { world, logged } = harness({ gitPlan: GIT_PLAN, answers: [''], boardAt: 'http://127.0.0.1:17820' })
    expect(await initCommand(flagsFromArgv(LOCAL), world)).toBe(0)
    expect(logged.at(-1)).toBe('next: lingtai ticket new · lingtai run')
  })

  it('a failing doctor puts lingtai doctor --verbose first', async () => {
    const { world, logged } = harness({
      gitPlan: GIT_PLAN,
      answers: [''],
      boardAt: 'http://127.0.0.1:17820',
      doctor: async () => ({ text: '1 failed', failed: true }),
    })
    expect(await initCommand(flagsFromArgv(LOCAL), world)).toBe(0)
    expect(logged.at(-1)).toBe('next: lingtai doctor --verbose · lingtai ticket new · lingtai run')
  })

  it('exactly one next: line appears on the local path, and it is the last', async () => {
    const { world, logged } = harness({ gitPlan: GIT_PLAN, answers: [''] })
    expect(await initCommand(flagsFromArgv(LOCAL), world)).toBe(0)
    const nexts = logged.flatMap((l) => l.split('\n')).filter((l) => l.startsWith('next:'))
    expect(nexts).toHaveLength(1)
    expect(logged.at(-1)).toBe(nexts[0])
  })

  it('re-running init on a machine with a project ends the same way, once', async () => {
    const { world, logged } = harness({ gitPlan: GIT_PLAN, answers: [''] })
    world.projects = async () => [{ name: 'repo' }] as never
    expect(await initCommand(flagsFromArgv(['--store', 'sqlite', '--defaults']), world)).toBe(0)
    const nexts = logged.flatMap((l) => l.split('\n')).filter((l) => l.startsWith('next:'))
    expect(nexts).toEqual(['next: lingtai board · lingtai ticket new · lingtai run'])
    expect(logged.at(-1)).toBe(nexts[0])
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

  it('a local init, with a board already running on the port, says so rather than naming a `lingtai board` that would refuse', async () => {
    const { world, logged, calls } = harness({ gitPlan: GIT_PLAN, answers: [''], boardAt: 'http://127.0.0.1:17820' })

    const code = await initCommand(
      flagsFromArgv(['--local', '/repo', '--store', 'sqlite', '--defaults', '--install', 'none']),
      world,
    )
    expect(code).toBe(0)
    expect(calls).toEqual({ boardAt: 1, board: 0 })
    expect(logged.at(-2)).toContain('the board was already running at http://127.0.0.1:17820 — this started none')
    expect(logged.at(-1)).toBe('next: lingtai ticket new · lingtai run')
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

  it('a GitHub init with a configured App says it answered', async () => {
    const { world, logged } = harness({
      app: { configured: true, ok: true, slug: 'lingtai-me', owner: 'me' } as never,
    })
    world.ask = async (question) => (/a GitHub project/.test(question) ? 'github' : null)
    expect(await initCommand(flagsFromArgv(['--store', 'sqlite']), world)).toBe(0)
    const text = logged.join('\n')
    expect(text).toMatch(/app\s+lingtai-me, owned by me — it answered/)
    expect(text.match(/it answered/g)).toHaveLength(1)
  })

  it('a re-run on a machine with projects and a configured App says it answered once', async () => {
    const { world, logged } = harness({
      app: { configured: true, ok: true, slug: 'lingtai-me', owner: 'me' } as never,
    })
    world.projects = async () => [{ name: 'repo' }] as never
    expect(await initCommand(flagsFromArgv(['--store', 'sqlite', '--defaults']), world)).toBe(0)
    const text = logged.join('\n')
    expect(text).toMatch(/app {2}lingtai-me, owned by me — it answered/)
    expect(text.match(/it answered/g)).toHaveLength(1)
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
    expect(nextLines(logged)).toEqual([
      'next: open http://127.0.0.1:17820/setup/repository · lingtai add <owner>/<repo>',
    ])
    expect(logged.at(-1)).toBe('next: open http://127.0.0.1:17820/setup/repository · lingtai add <owner>/<repo>')
  })

  it('the App skipped closes on lingtai add, last and once', async () => {
    const { world, logged } = harness()
    world.pressed = async () => {}
    world.appeared = (signal) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
    world.ask = async (question) =>
      /a GitHub project/.test(question)
        ? 'github'
        : /GitHub App of its own/.test(question)
          ? 'app'
          : /the GitHub App now/.test(question)
            ? 'create'
            : null
    expect(await initCommand(flagsFromArgv(['--store', 'sqlite']), world)).toBe(0)
    expect(nextLines(logged)).toEqual(['next: lingtai add <owner>/<repo>'])
    expect(logged.at(-1)).toBe('next: lingtai add <owner>/<repo>')
  })

  it('a configured App closes on lingtai add, last and once', async () => {
    const { world, logged } = harness({ app: { configured: true, ok: true, slug: 'lingtai-me', owner: 'me' } as never })
    world.ask = async (question) => (/a GitHub project/.test(question) ? 'github' : null)
    expect(await initCommand(flagsFromArgv(['--store', 'sqlite']), world)).toBe(0)
    expect(nextLines(logged)).toEqual(['next: lingtai add <owner>/<repo>'])
    expect(logged.at(-1)).toBe('next: lingtai add <owner>/<repo>')
  })

  it('a re-run with a configured App and projects prints no next: line at all', async () => {
    const { world, logged } = harness({ app: { configured: true, ok: true, slug: 'lingtai-me', owner: 'me' } as never })
    world.projects = async () => [{ name: 'repo' }] as never
    expect(await initCommand(flagsFromArgv(['--store', 'sqlite', '--defaults']), world)).toBe(0)
    expect(nextLines(logged)).toEqual([])
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
    world.open = async () => {
      opened++
      return true
    }
    world.ask = async (question) =>
      /a GitHub project/.test(question) ? 'github' : /signed in as steven/.test(question) ? '' : null

    const code = await initCommand(flagsFromArgv(['--store', 'sqlite']), world)
    expect(code).toBe(0)
    expect(parseDocument(machineFiles.get('/nonexistent/.lingtai/config.yml')!).getIn(['github', 'auth'])).toBe('gh')
    expect(calls.board).toBe(0)
    expect(opened).toBe(0)
    expect(nextLines(logged)).toEqual(['next: lingtai add <owner>/<repo>'])
    expect(logged.at(-1)).toBe('next: lingtai add <owner>/<repo>')
    expect(logged.join('\n')).not.toContain('GitHub App')
  })

  it('a failing doctor leads the gh closing line with lingtai doctor --verbose; a warning does not', async () => {
    const run = async (doctor: () => Promise<{ text: string; failed: boolean }>) => {
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
    expect(failed.at(-1)).toBe('next: lingtai doctor --verbose · lingtai add <owner>/<repo>')
    const warned = await run(async () => ({ text: '1 warning', failed: false }))
    expect(warned.at(-1)).toBe('next: lingtai add <owner>/<repo>')
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
