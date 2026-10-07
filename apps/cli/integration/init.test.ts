import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ProjectState } from '@lingtai/domain'
import { SQLITE_MACHINE, describeStore, storeChoice } from '@lingtai/env'
import { recipePath, type RecipeFiles } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'

import type { GitResult } from '../src/first-project.ts'
import { type AppCheck, type InitWorld, type RuntimeFound, configPath, initCommand, redact } from '../src/init.ts'

/**
 * `lingtai init` (#186), against a world with no database, GitHub, runtime or
 * browser in it — what each would have said is scripted, and what init asked
 * and wrote is recorded. `LINGTAI_HOME` is a directory of the test's own, so
 * `config.yml` is real and the resume is read back from a real file.
 */

const URL_ = 'postgresql://me:secret@db.example:5432/lingtai'

/** A step a Ctrl+C can land in. Each is a call into the world that has not returned. */
const STEPS = ['git', 'runtimes', 'ask:database', 'database', 'app', 'board', 'open', 'appeared'] as const
type Step = (typeof STEPS)[number]

class Interrupted extends Error {}

interface Script {
  runtimes?: RuntimeFound[]
  /** Answers, in order, to whichever questions are asked. */
  answers?: (string | null)[]
  /** URLs that connect. Anything else does not. */
  answering?: string[]
  /** Added to the environment init reads — a `LINGTAI_DATABASE_URL` is the exported one. */
  env?: NodeJS.ProcessEnv
  app?: AppCheck
  git?: string | null
  board?: { url: string } | { refused: string }
  /** A board already up on the port. Its port is then taken, so starting another is refused. */
  running?: string
  /** Throw from this step, once — the Ctrl+C. */
  interruptAt?: Step
  /**
   * The project kind question's answer, when no App is configured (#393).
   * Defaults to `github`; `null` is a world with nobody at its terminal for
   * this question alone, same as an empty `answers` queue is for the database
   * one — `ask` returns `null` for it exactly as `liveInitWorld`'s does without
   * a TTY.
   */
  project?: 'github' | 'local' | null
  /** The App question's answer, when the project is `github` (#393). Defaults to `create`; `null` is the same no-terminal world, for this question alone. */
  appAnswer?: 'create' | 'skip' | null
  /**
   * The local branch's own seams (#394) — never reached unless a test asks
   * for `--local`/`--project local` explicitly, since every other test here
   * answers the project question `github` by default.
   */
  projects?: ProjectState[]
  gitPlan?: Record<string, GitResult>
  files?: Record<string, string>
  registerLocal?: (payload: { project: string; base: string }) => Promise<string>
}

interface Recorded {
  lines: string[]
  asked: string[]
  connected: string[]
  opened: string[]
  boards: number
  /** Calls made to ask the App whether it answers. */
  apps: number
  /** Calls made to wait for the App to appear through the board's manifest flow. */
  appeared: number
  /** Every call to `registerLocal` — the local branch's claim that it registers (#394 finding 10). */
  registered: { project: string; base: string }[]
}

/** The database's state survives between runs, as a real one would: tables made once are there the next time. */
function database() {
  return { created: false }
}

function world(home: string, script: Script, db = database()): { world: InitWorld; seen: Recorded } {
  const seen: Recorded = {
    lines: [],
    asked: [],
    connected: [],
    opened: [],
    boards: 0,
    apps: 0,
    appeared: 0,
    registered: [],
  }
  const answers = [...(script.answers ?? [])]
  let interrupt = script.interruptAt
  const step = (name: Step) => {
    if (interrupt === name) {
      interrupt = undefined
      throw new Interrupted(`ctrl-c during ${name}`)
    }
  }
  return {
    seen,
    world: {
      env: { LINGTAI_HOME: home, ...script.env },
      log: (line) => seen.lines.push(line),
      ask: async (question) => {
        // The project and App questions (#393) are answered directly from the
        // script, never through the `answers` queue and never recorded as a
        // step: the Ctrl+C matrix below is about the database question alone.
        // `??` would treat an explicit `null` the same as "not given" and hand
        // back the default — so a test asking for a true no-terminal world on
        // one of these questions checks for `undefined` instead.
        if (/a GitHub project/.test(question)) return script.project === undefined ? 'github' : script.project
        if (/the GitHub App now/.test(question)) return script.appAnswer === undefined ? 'create' : script.appAnswer
        // The store is the one question init asks about the database: the agent is each recipe's (#372).
        const which: Step = 'ask:database'
        expect(question).toMatch(/Postgres/)
        seen.asked.push(which)
        step(which)
        return answers.length > 0 ? answers.shift()! : null
      },
      git: async () => {
        step('git')
        return script.git === undefined ? 'git version 2.50.0' : script.git
      },
      runtimes: async () => {
        step('runtimes')
        return script.runtimes ?? [signedIn('claude-code'), notInstalled('codex')]
      },
      database: async (url) => {
        seen.connected.push(url)
        if (!(script.answering ?? [URL_]).includes(url)) return { ok: false, why: 'connection refused' }
        step('database')
        if (db.created) return { ok: true, schema: { created: false, repaired: [] } }
        db.created = true
        return { ok: true, schema: { created: true, applied: ['Create table "events"'] } }
      },
      app: async () => {
        step('app')
        seen.apps++
        return script.app ?? { configured: false }
      },
      appeared: async (_signal) => {
        step('appeared')
        seen.appeared++
        return { slug: 'lingtai-me', owner: 'me' }
      },
      // Never resolves at a terminal with nobody at it — only on the signal
      // the race's winner aborts it with, exactly as `liveInitWorld`'s does
      // with no TTY.
      pressed: (signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
      boardAt: async () => script.running ?? null,
      board: async () => {
        step('board')
        seen.boards++
        if (script.running !== undefined) return { refused: '127.0.0.1:3200 is already in use' }
        return script.board ?? { url: 'http://127.0.0.1:3200' }
      },
      open: async (url) => {
        step('open')
        seen.opened.push(url)
        return true
      },
      runGit: async (dir, gitArgs) => {
        const found = (script.gitPlan ?? {})[`${dir}::${gitArgs.join(' ')}`]
        if (found === undefined) throw new Error(`unplanned git call: ${dir}::${gitArgs.join(' ')}`)
        return found
      },
      projects: async () => script.projects ?? [],
      files: (() => {
        const store = new Map(Object.entries(script.files ?? {}))
        return {
          read: async (p) => store.get(p) ?? null,
          replace: async (p, text) => {
            store.set(p, text)
          },
        }
      })() as RecipeFiles,
      signedIn: async () => ['claude-code'] as never[],
      registerLocal: async (payload) => {
        seen.registered.push({ project: payload.project, base: payload.base })
        return (script.registerLocal ?? (async (p) => `added ${p.project}`))({
          project: payload.project,
          base: payload.base,
        })
      },
    },
  }
}

function signedIn(id: RuntimeFound['id']): RuntimeFound {
  return { id, installed: true, signedIn: true, detail: 'signed in via claude.ai' }
}
function notInstalled(id: RuntimeFound['id']): RuntimeFound {
  return { id, installed: false, signedIn: false, detail: `spawn ${id} ENOENT` }
}

function freshHome(): string {
  return join(mkdtempSync(join(tmpdir(), 'lingtai-init-')), '.lingtai')
}

function config(home: string): string | null {
  const path = configPath({ LINGTAI_HOME: home })
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

describe('lingtai init (#186)', () => {
  it("on a machine with nothing, ends with a browser open on the wizard's first screen", async () => {
    const home = freshHome()
    const { world: w, seen } = world(home, { answers: [URL_] })

    expect(await initCommand([], w)).toBe(0)

    expect(config(home)).toBe(`database:\n  store: postgres\n  url: ${URL_}\n`)
    expect(statSync(configPath({ LINGTAI_HOME: home })).mode & 0o777).toBe(0o600)
    expect(seen.opened).toEqual(['http://127.0.0.1:3200/setup/github-app'])
    expect(seen.lines.join('\n')).toContain('lingtai-me, owned by me — it answered')
    // The password is not printed anywhere.
    expect(seen.lines.join('\n')).not.toContain('secret')
  })

  it('a directory registered with --local never calls appeared or opens a browser, and exits 0 (#394)', async () => {
    const home = freshHome()
    const { world: w, seen } = world(home, {
      answers: [URL_],
      gitPlan: {
        '/repo::rev-parse --show-toplevel': { ok: true, stdout: '/repo\n', stderr: '' },
        '/repo::remote get-url origin': { ok: true, stdout: 'https://github.com/acme/widget.git\n', stderr: '' },
        '/repo::symbolic-ref --short refs/remotes/origin/HEAD': { ok: true, stdout: 'origin/main\n', stderr: '' },
        '/repo::rev-parse --verify main^{commit}': { ok: true, stdout: 'abc123f\n', stderr: '' },
      },
    })
    expect(await initCommand(['--local', '/repo', '--base', 'main'], w)).toBe(0)
    expect(seen.opened).toEqual([])
    expect(seen.appeared).toBe(0)
    expect(seen.lines.join('\n')).toContain('project      local — repo, registered with its own origin as repo.remote')
  })

  it('a local project, once registered, is listed on a re-run rather than asked about again (#394)', async () => {
    const home = freshHome()
    const git = {
      '/repo::rev-parse --show-toplevel': { ok: true, stdout: '/repo\n', stderr: '' },
      '/repo::remote get-url origin': { ok: true, stdout: 'https://github.com/acme/widget.git\n', stderr: '' },
      '/repo::symbolic-ref --short refs/remotes/origin/HEAD': { ok: true, stdout: 'origin/main\n', stderr: '' },
      '/repo::rev-parse --verify main^{commit}': { ok: true, stdout: 'abc123f\n', stderr: '' },
    }
    const first = world(home, { answers: [URL_], gitPlan: git })
    expect(await initCommand(['--local', '/repo', '--base', 'main'], first.world)).toBe(0)

    // The first run actually registered the directory — not just printed a
    // line claiming to (#394 finding 10): `registerLocal` is the record, and
    // nothing here checked that the local branch ever calls it.
    expect(first.seen.registered).toEqual([{ project: 'repo', base: 'main' }])

    // No --project, --local or --github and no terminal: with the directory
    // already registered, the question is not asked again — it is listed.
    const registered: ProjectState = {
      project: 'repo',
      owner: null,
      base: 'main',
      configHash: 'hash',
      fromSha: 'abc123f',
      refused: null,
      version: 1,
      lastSeq: 1n,
    }
    // Each world keeps its own files, so the recipe the first run wrote is
    // handed on: its `repo.remote` is what marks the project local (#394's review).
    const second = world(home, {
      projects: [registered],
      files: { [recipePath('repo', home)]: 'repo:\n  remote: git@github.com:acme/repo.git\n' },
    })
    expect(await initCommand([], second.world)).toBe(0)
    expect(second.seen.lines.join('\n')).toContain('repo — local, git@github.com:acme/repo.git')
    expect(second.seen.lines.join('\n')).toContain('lingtai add asks GitHub-or-directory')
    expect(second.seen.asked).toEqual([])
  })

  it('a machine with a project already registered still starts the board, rather than stopping at the list (#394)', async () => {
    const home = freshHome()
    const registered: ProjectState = {
      project: 'widget',
      owner: null,
      base: 'main',
      configHash: 'hash',
      fromSha: 'sha',
      refused: null,
      version: 1,
      lastSeq: 1n,
    }
    const { world: w, seen } = world(home, { answers: [URL_], projects: [registered] })
    expect(await initCommand(['--port', '17900'], w)).toBe(0)
    expect(seen.boards).toBe(1)
    expect(seen.lines.join('\n')).toContain('widget — owner not recorded')
  })

  it('--project local --github-app create is refused rather than silently creating no App and saying nothing (#393)', async () => {
    const home = freshHome()
    const { world: w, seen } = world(home, { answers: [URL_], project: 'local' })
    expect(await initCommand(['--store', 'sqlite', '--project', 'local', '--github-app', 'create'], w)).toBe(1)
    expect(seen.lines.at(-1)).toContain('--github-app create')
    expect(seen.opened).toEqual([])
    expect(config(home)).not.toContain('project')
  })

  it('a skipped App opens no browser, at once, with the come-back line, and exits 0 (#393)', async () => {
    const home = freshHome()
    const { world: w, seen } = world(home, { answers: [URL_], appAnswer: 'skip' })
    expect(await initCommand([], w)).toBe(0)
    expect(seen.opened).toEqual([])
    expect(seen.lines.join('\n')).toContain('not created (skipped)')
    expect(seen.lines.join('\n')).toContain('run lingtai init again')
  })

  it('opens the repository picker instead when the App already answers', async () => {
    const home = freshHome()
    const { world: w, seen } = world(home, {
      answers: [URL_],
      app: { configured: true, ok: true, slug: 'lingtai-me', owner: 'me' },
    })
    expect(await initCommand([], w)).toBe(0)
    expect(seen.opened).toEqual(['http://127.0.0.1:3200/setup/repository'])
  })

  it('refuses --project when a GitHub App is already configured, rather than silently ignoring it (#393)', async () => {
    const home = freshHome()
    const { world: w, seen } = world(home, {
      answers: [URL_],
      app: { configured: true, ok: true, slug: 'lingtai-me', owner: 'me' },
    })
    expect(await initCommand(['--project', 'local'], w)).toBe(1)
    expect(seen.lines.at(-1)).toContain('--project local')
    expect(seen.opened).toEqual([])
  })

  it('refuses --github-app create when a GitHub App is already configured, rather than silently ignoring it (#393)', async () => {
    const home = freshHome()
    const { world: w, seen } = world(home, {
      answers: [URL_],
      app: { configured: true, ok: true, slug: 'lingtai-me', owner: 'me' },
    })
    expect(await initCommand(['--github-app', 'create'], w)).toBe(1)
    expect(seen.lines.at(-1)).toContain('--github-app create')
    expect(seen.opened).toEqual([])
  })

  it('--github-app skip is accepted when a GitHub App is already configured — it asks for exactly what the machine already does (#393)', async () => {
    const home = freshHome()
    const { world: w, seen } = world(home, {
      answers: [URL_],
      app: { configured: true, ok: true, slug: 'lingtai-me', owner: 'me' },
    })
    expect(await initCommand(['--github-app', 'skip'], w)).toBe(0)
    expect(seen.opened).toEqual(['http://127.0.0.1:3200/setup/repository'])
  })

  describe('Ctrl+C at each step, then again: it continues', () => {
    for (const at of STEPS) {
      it(`interrupted during ${at}`, async () => {
        const home = freshHome()
        const db = database()
        // Two signed in, which init no longer asks about: each recipe names its agent (#372).
        const runtimes = [signedIn('claude-code'), signedIn('codex')]

        const first = world(home, { runtimes, answers: [URL_], interruptAt: at }, db)
        await expect(initCommand([], first.world)).rejects.toThrow(Interrupted)

        const second = world(home, { runtimes, answers: [URL_] }, db)
        expect(await initCommand([], second.world)).toBe(0)

        expect(config(home)).toBe(`database:\n  store: postgres\n  url: ${URL_}\n`)
        expect(second.seen.opened).toEqual(['http://127.0.0.1:3200/setup/github-app'])

        // What the first run settled, the second does not ask again.
        const settledDatabase = STEPS.indexOf(at) > STEPS.indexOf('database')
        expect(second.seen.asked.includes('ask:database')).toBe(!settledDatabase)
      })
    }
  })

  it('writes nothing before the choice it belongs to is made', async () => {
    const home = freshHome()
    const runtimes = [signedIn('claude-code'), signedIn('codex')]

    // Stopped at the database question: no file at all.
    await expect(initCommand([], world(home, { runtimes, interruptAt: 'ask:database' }).world)).rejects.toThrow(
      Interrupted,
    )
    expect(config(home)).toBeNull()

    // Stopped while connecting: the URL was given and not yet verified.
    await expect(
      initCommand([], world(home, { runtimes, answers: [URL_], interruptAt: 'database' }).world),
    ).rejects.toThrow(Interrupted)
    expect(config(home)).toBeNull()
  })

  it('verifies each detection rather than assuming it: the database by connecting, the App by a call', async () => {
    const home = freshHome()
    const { world: w, seen } = world(home, { answers: [URL_] })
    expect(await initCommand([], w)).toBe(0)
    const second = world(home, { app: { configured: true, ok: true, slug: 'lingtai-me', owner: 'me' } })
    expect(await initCommand([], second.world)).toBe(0)
    // Written by the first run, and still connected to by the second.
    expect(second.seen.connected).toEqual([URL_])
    expect(seen.connected).toEqual([URL_])
    // The App is asked on every run, and only what the call answered is reported.
    expect(seen.apps).toBe(1)
    expect(second.seen.apps).toBe(1)
    expect(seen.lines.join('\n')).toContain('app          none yet')
    expect(second.seen.lines.join('\n')).toContain('app          lingtai-me, owned by me — it answered')

    // A configured App that does not answer is not reported as answering.
    const failing = world(home, { app: { configured: true, ok: false, why: '401 Bad credentials' } })
    expect(await initCommand([], failing.world)).toBe(1)
    expect(failing.seen.apps).toBe(1)
    expect(failing.seen.lines.join('\n')).not.toContain('it answered')
  })

  describe('a failure returns to the choice', () => {
    it('a URL that does not connect is not written, and the question is asked again', async () => {
      const home = freshHome()
      const bad = 'postgresql://me:wrong@db.example:5432/lingtai'
      const { world: w, seen } = world(home, { answers: [bad, URL_] })
      expect(await initCommand([], w)).toBe(0)
      expect(seen.connected).toEqual([bad, URL_])
      expect(seen.asked.filter((q) => q === 'ask:database')).toHaveLength(2)
      expect(config(home)).not.toContain('wrong')
    })

    it('a URL written before the store was (#186) is adopted: verified, and recorded as the choice', async () => {
      const home = freshHome()
      mkdirSync(home, { recursive: true })
      // No `store` key, which is every machine set up before this existed.
      writeFileSync(configPath({ LINGTAI_HOME: home }), `# mine\ndatabase:\n  url: ${URL_}\n`)
      const { world: w, seen } = world(home, { answers: [] })
      expect(await initCommand([], w)).toBe(0)
      // Asked nothing: the URL it already had is the choice nobody recorded.
      expect(seen.asked).toEqual([])
      expect(seen.connected).toEqual([URL_])
      expect(config(home)).toContain('# mine')
      expect(config(home)).toContain('store: postgres')
      expect(storeChoice({ LINGTAI_HOME: home })).toMatchObject({ store: 'postgres', url: URL_ })
    })

    it('tries a URL it inherited once, then asks — never again, which would never reach the question', async () => {
      const home = freshHome()
      mkdirSync(home, { recursive: true })
      const gone = 'postgresql://me@gone.example/lingtai'
      writeFileSync(configPath({ LINGTAI_HOME: home }), `database:\n  url: ${gone}\n`)
      const { world: w, seen } = world(home, { answers: [URL_] })
      expect(await initCommand([], w)).toBe(0)
      expect(seen.connected).toEqual([gone, URL_])
      expect(seen.asked.filter((q) => q === 'ask:database')).toHaveLength(1)
      expect(storeChoice({ LINGTAI_HOME: home })).toMatchObject({ store: 'postgres', url: URL_ })
    })

    it('a written URL that stopped answering asks again rather than going on', async () => {
      const home = freshHome()
      mkdirSync(home, { recursive: true })
      const gone = 'postgresql://me@gone.example/lingtai'
      writeFileSync(configPath({ LINGTAI_HOME: home }), `# mine\ndatabase:\n  store: postgres\n  url: ${gone}\n`)
      const { world: w, seen } = world(home, { answers: [URL_] })
      expect(await initCommand([], w)).toBe(0)
      expect(seen.connected).toEqual([gone, URL_])
      expect(config(home)).toContain('# mine')
      expect(config(home)).toContain(URL_)
    })
  })

  /**
   * **Which runtime runs is each recipe's** (`#372`, `#398`), so init asks
   * nothing about it and writes nothing for it, whether or not anything is
   * signed in here — that question is `lingtai add`'s now. A file that
   * still names one at the machine level is refused by name, because every
   * resolve would refuse it next.
   */
  it('asks nothing about the agent, however many runtimes are signed in, and writes none', async () => {
    const home = freshHome()
    const runtimes = [signedIn('claude-code'), signedIn('codex')]
    const { world: w, seen } = world(home, { runtimes, answers: [URL_] })
    expect(await initCommand([], w)).toBe(0)
    expect(seen.asked).toEqual(['ask:database'])
    expect(config(home)).not.toContain('agent')
  })

  it('asks nothing about the agent when nothing is signed in either', async () => {
    const home = freshHome()
    const { world: w, seen } = world(home, {
      runtimes: [notInstalled('claude-code'), notInstalled('codex')],
      answers: [URL_],
    })
    expect(await initCommand([], w)).toBe(0)
    expect(seen.asked).toEqual(['ask:database'])
    expect(config(home)).not.toContain('agent')
  })

  it('refuses a file that still names a runtime, saying where it moved, and writes nothing', async () => {
    const home = freshHome()
    mkdirSync(home, { recursive: true })
    const before = `database:\n  store: postgres\n  url: ${URL_}\nruntime:\n  agent: codex\n`
    writeFileSync(configPath({ LINGTAI_HOME: home }), before)
    const { world: w, seen } = world(home, {})
    expect(await initCommand([], w)).toBe(1)
    expect(seen.lines.at(-1)).toContain('runtime.agent in that project')
    expect(config(home)).toBe(before)
    expect(seen.boards).toBe(0)
  })

  it('refuses without git, before asking anything', async () => {
    const home = freshHome()
    const { world: w, seen } = world(home, { git: null })
    expect(await initCommand([], w)).toBe(1)
    expect(seen.asked).toEqual([])
    expect(config(home)).toBeNull()
  })

  it('does not create a second App beside one that does not answer', async () => {
    const home = freshHome()
    const { world: w, seen } = world(home, {
      answers: [URL_],
      app: { configured: true, ok: false, why: '401 A JSON web token could not be decoded' },
    })
    expect(await initCommand([], w)).toBe(1)
    expect(seen.boards).toBe(0)
    expect(seen.opened).toEqual([])
  })

  it('uses a database already set in the environment, verifies it, and writes nothing for it', async () => {
    const home = freshHome()
    const { world: w, seen } = world(home, { env: { LINGTAI_DATABASE_URL: URL_ } })
    expect(await initCommand([], w)).toBe(0)
    expect(seen.asked).toEqual([])
    expect(seen.connected).toEqual([URL_])
    expect(config(home)).toBeNull()
    // It is the process's answer and not the file's, so the file still says nothing.
    expect(seen.lines.join('\n')).toContain('exported into this process')
  })

  it('re-running a finished init reports the state and changes nothing', async () => {
    const home = freshHome()
    const db = database()
    expect(await initCommand([], world(home, { answers: [URL_] }, db).world)).toBe(0)
    const before = config(home)
    const mtime = statSync(configPath({ LINGTAI_HOME: home })).mtimeMs

    // The board is up, as it is on a finished machine, so its port is taken.
    const again = world(
      home,
      { app: { configured: true, ok: true, slug: 'lingtai-me', owner: 'me' }, running: 'http://127.0.0.1:3200' },
      db,
    )
    expect(await initCommand([], again.world)).toBe(0)
    expect(again.seen.boards).toBe(0)
    expect(again.seen.opened).toEqual(['http://127.0.0.1:3200/setup/repository'])

    expect(again.seen.asked).toEqual([])
    expect(config(home)).toBe(before)
    expect(statSync(configPath({ LINGTAI_HOME: home })).mtimeMs).toBe(mtime)
    const said = again.seen.lines.join('\n')
    expect(said).toContain('tables present')
    expect(said).toContain('claude-code  signed in via claude.ai')
    expect(said).toContain('lingtai-me, owned by me')
  })

  it('refuses a config.yml that does not parse, rather than writing over it', async () => {
    const home = freshHome()
    mkdirSync(home, { recursive: true })
    writeFileSync(configPath({ LINGTAI_HOME: home }), 'database: [unclosed\n')
    const { world: w, seen } = world(home, { answers: [URL_] })
    expect(await initCommand([], w)).toBe(1)
    expect(seen.asked).toEqual([])
    expect(config(home)).toBe('database: [unclosed\n')
  })

  it('never prints a password', () => {
    expect(redact(URL_)).toBe('postgresql://me:***@db.example:5432/lingtai')
    expect(redact('postgresql://db.example/lingtai')).toBe('postgresql://db.example/lingtai')
  })
})

/**
 * #215, [0056](../../../doc/decisions-archive/0056-the-store-is-a-written-choice.md).
 * The store is a value this command writes; every assertion here reads it back
 * with `storeChoice`, which is the function a later command asks — a test that
 * only read the YAML would pass on exactly the file that made this ticket.
 */
describe('the store is written down, and the screen is a reading of it (#215)', () => {
  it('writes database.store beside the URL, at 0600', async () => {
    const home = freshHome()
    expect(await initCommand([], world(home, { answers: [URL_] }).world)).toBe(0)
    expect(config(home)).toContain('store: postgres')
    expect(statSync(configPath({ LINGTAI_HOME: home })).mode & 0o777).toBe(0o600)
    expect(storeChoice({ LINGTAI_HOME: home })).toMatchObject({ store: 'postgres', url: URL_, where: 'config.yml' })
  })

  it('makes the empty answer the SQLite choice, and removes the URL the other store was opened by', async () => {
    const home = freshHome()
    // A machine on Postgres, switched by the edit 0056 leaves to this ticket:
    // `store` is the key, and the `url` the old store left behind is what made
    // the reviewer's finding — the screen said SQLite and the file went on
    // selecting Postgres.
    expect(await initCommand([], world(home, { answers: [URL_] }).world)).toBe(0)
    writeFileSync(configPath({ LINGTAI_HOME: home }), config(home)!.replace('store: postgres', 'store: sqlite'))
    expect(storeChoice({ LINGTAI_HOME: home })).toMatchObject({ because: 'two keys' })

    const { world: w, seen } = world(home, { answers: [''] })

    // The choice is recorded and **setup finishes on it**: since #179 a written
    // `sqlite` opens a log, so there is a board to serve and no reason to exit
    // non-zero. Exiting 1 here told an operator whose machine was correctly set
    // up to go back and give a Postgres URL instead.
    expect(await initCommand([], w)).toBe(0)
    expect(seen.boards).toBe(1)

    expect(config(home)).toContain('store: sqlite')
    expect(config(home)).not.toContain('url:')
    // The assertion this ticket exists for: what is read afterwards is not Postgres.
    const read = storeChoice({ LINGTAI_HOME: home })
    expect(read).toMatchObject({ store: 'sqlite', path: join(home, 'lingtai.db') })
    expect(seen.lines.join('\n')).toContain(SQLITE_MACHINE)
    // And nothing offers Postgres as the store this version runs on.
    expect(seen.lines.join('\n')).not.toContain('--database-url')
  })

  it('confirms with the same function a later command asks, and never with the answer typed', async () => {
    const home = freshHome()
    const { world: w, seen } = world(home, { answers: [URL_] })
    expect(await initCommand([], w)).toBe(0)
    // Literally the later command's answer, rendered the one way.
    const line = seen.lines.find((l) => l.includes('store '))!
    expect(line).toContain(describeStore(storeChoice({ LINGTAI_HOME: home })))
  })

  it('repairs the two refusals a file can be in, saying what was wrong with it first', async () => {
    const contradiction = `database:\n  store: sqlite\n  url: ${URL_}\n`
    const noUrl = 'database:\n  store: postgres\n'
    for (const [written, quoted] of [
      [contradiction, 'two keys disagreeing'],
      [noUrl, 'names no database.url'],
    ] as const) {
      const home = freshHome()
      mkdirSync(home, { recursive: true })
      writeFileSync(configPath({ LINGTAI_HOME: home }), written)
      const { world: w, seen } = world(home, { answers: [URL_] })

      expect(await initCommand([], w)).toBe(0)
      expect(seen.lines.join('\n')).toContain(quoted)
      expect(storeChoice({ LINGTAI_HOME: home })).toMatchObject({ store: 'postgres', url: URL_ })
      expect(config(home)).toContain('store: postgres')
    }
  })

  it('leaves a machine a second run completes, whichever question an interruption landed in', async () => {
    const home = freshHome()
    const db = database()
    // Stopped while connecting: nothing is written, so nothing half-opens.
    await expect(initCommand([], world(home, { answers: [URL_], interruptAt: 'database' }, db).world)).rejects.toThrow(
      Interrupted,
    )
    expect(storeChoice({ LINGTAI_HOME: home })).toMatchObject({ because: 'nothing chosen' })

    // Stopped after it: the store is written, and the second run asks nothing about it.
    await expect(initCommand([], world(home, { answers: [URL_], interruptAt: 'app' }, db).world)).rejects.toThrow(
      Interrupted,
    )
    expect(storeChoice({ LINGTAI_HOME: home })).toMatchObject({ store: 'postgres', url: URL_ })
    // Beside, then renamed over: what `install.sh` runs this under can stop at
    // any point and leave a whole file or none, never half of one.
    expect(readdirSync(home).filter((name) => name.includes('partial'))).toEqual([])

    const second = world(home, {}, db)
    expect(await initCommand([], second.world)).toBe(0)
    expect(second.seen.asked).toEqual([])
  })

  it('is the exported variable that wins, and it says which it was', async () => {
    const home = freshHome()
    mkdirSync(home, { recursive: true })
    // The file says SQLite; the process was handed a URL, and 0056 §3 is that it wins.
    writeFileSync(configPath({ LINGTAI_HOME: home }), 'database:\n  store: sqlite\n')
    const { world: w, seen } = world(home, { env: { LINGTAI_DATABASE_URL: URL_ } })
    expect(await initCommand([], w)).toBe(0)
    expect(seen.connected).toEqual([URL_])
    expect(seen.lines.join('\n')).toContain('LINGTAI_DATABASE_URL, exported into this process')
    // And nothing was written over: the file's choice is still the file's.
    expect(config(home)).toContain('store: sqlite')
  })
})

/**
 * #345. `--store` answers the store question with nobody at a terminal, by the
 * same lines the empty answer takes — and refuses by name, writing nothing,
 * wherever the machine would not obey it. "No terminal" here means the
 * *database* question: its world has no `answers` queued for it, so `ask`
 * returns null exactly as `liveInitWorld`'s does without a TTY, and
 * `seen.asked` says the question was not reached at all.
 *
 * It is not also true of the project and App questions (#393): `ask`'s mock
 * answers those `github`/`create` by default whether or not a terminal is
 * meant to be there, so a test below that wants a genuinely headless run all
 * the way to the board passes `--project local` (or `--project github
 * --github-app skip`) the way a real script would — and one test pins the
 * regression this leaves otherwise: `--store sqlite` alone, with the project
 * question put at a true no-terminal world (`project: null`), refuses there
 * rather than finishing setup.
 */
describe('--store answers the store question without a terminal (#345)', () => {
  function written(home: string): { text: string | null; mtime: number | null } {
    const path = configPath({ LINGTAI_HOME: home })
    return { text: config(home), mtime: existsSync(path) ? statSync(path).mtimeMs : null }
  }

  it('without it, nobody at a terminal is still a refusal that names --store sqlite', async () => {
    const home = freshHome()
    const { world: w, seen } = world(home, {})
    expect(await initCommand([], w)).toBe(1)
    expect(seen.lines.at(-1)).toContain('--store sqlite')
    expect(config(home)).toBeNull()
  })

  it('--store sqlite, with --local <dir> --base <branch>, writes database.store: sqlite, leaves no database.url, and finishes setup', async () => {
    const home = freshHome()
    const { world: w, seen } = world(home, {
      gitPlan: {
        '/repo::rev-parse --show-toplevel': { ok: true, stdout: '/repo\n', stderr: '' },
        '/repo::remote get-url origin': { ok: true, stdout: 'https://github.com/acme/widget.git\n', stderr: '' },
        '/repo::symbolic-ref --short refs/remotes/origin/HEAD': { ok: true, stdout: 'origin/main\n', stderr: '' },
        '/repo::rev-parse --verify main^{commit}': { ok: true, stdout: 'abc123f\n', stderr: '' },
      },
    })
    expect(await initCommand(['--store', 'sqlite', '--local', '/repo', '--base', 'main'], w)).toBe(0)
    expect(seen.asked).toEqual([])
    expect(seen.connected).toEqual([])
    expect(config(home)).toBe('database:\n  store: sqlite\n')
    expect(statSync(configPath({ LINGTAI_HOME: home })).mode & 0o777).toBe(0o600)
    expect(storeChoice({ LINGTAI_HOME: home })).toMatchObject({ store: 'sqlite', path: join(home, 'lingtai.db') })
    expect(seen.lines.join('\n')).toContain(SQLITE_MACHINE)
    expect(seen.boards).toBe(1)
  })

  it('--store sqlite alone, with nobody at the project question either, writes the store and refuses there — not the usage line "Nothing was written" (#393)', async () => {
    const home = freshHome()
    const { world: w, seen } = world(home, { project: null })
    expect(await initCommand(['--store', 'sqlite'], w)).toBe(1)
    const said = seen.lines.at(-1)!
    expect(said).toContain('--project github, or --project local')
    expect(said).toContain('the store chosen above is kept')
    expect(said).not.toContain('Nothing was written')
    // The store it names is kept: this is the claim the message makes good on.
    expect(config(home)).toBe('database:\n  store: sqlite\n')
    // The board has to be up before the project question can wait for a new
    // App (`waitForApp` needs `board.url`), so it starts before this question
    // is asked — a refusal here no longer implies no board.
    expect(seen.boards).toBe(1)
  })

  it('writes the same file the empty answer does', async () => {
    const flagged = freshHome()
    const answered = freshHome()
    expect(await initCommand(['--store', 'sqlite'], world(flagged, {}).world)).toBe(0)
    expect(await initCommand([], world(answered, { answers: [''] }).world)).toBe(0)
    expect(config(flagged)).toBe(config(answered))
  })

  it('over a machine already on SQLite, reports it and writes nothing', async () => {
    const home = freshHome()
    expect(await initCommand(['--store', 'sqlite'], world(home, {}).world)).toBe(0)
    const before = written(home)
    const again = world(home, {})
    expect(await initCommand(['--store', 'sqlite'], again.world)).toBe(0)
    expect(written(home)).toEqual(before)
    expect(again.seen.asked).toEqual([])
  })

  it('completes the switch the documented edit leaves — store: sqlite beside the old url', async () => {
    const home = freshHome()
    mkdirSync(home, { recursive: true })
    writeFileSync(configPath({ LINGTAI_HOME: home }), `# mine\ndatabase:\n  store: sqlite\n  url: ${URL_}\n`)
    const { world: w, seen } = world(home, {})
    expect(await initCommand(['--store', 'sqlite'], w)).toBe(0)
    expect(seen.lines.join('\n')).toContain('two keys disagreeing')
    expect(config(home)).toContain('# mine')
    expect(config(home)).not.toContain('url:')
    expect(storeChoice({ LINGTAI_HOME: home })).toMatchObject({ store: 'sqlite' })
  })

  describe('refuses by name, and writes nothing, where the machine would not obey it', () => {
    it('beside --database-url', async () => {
      const home = freshHome()
      const { world: w, seen } = world(home, {})
      expect(await initCommand(['--store', 'sqlite', '--database-url', URL_], w)).toBe(2)
      expect(seen.lines.at(-1)).toContain('name two different stores')
      expect(seen.connected).toEqual([])
      expect(config(home)).toBeNull()
    })

    it('beside an exported LINGTAI_DATABASE_URL, which wins over the file', async () => {
      const home = freshHome()
      const { world: w, seen } = world(home, { env: { LINGTAI_DATABASE_URL: URL_ } })
      expect(await initCommand(['--store', 'sqlite'], w)).toBe(1)
      const said = seen.lines.at(-1)!
      expect(said).toContain('LINGTAI_DATABASE_URL, exported into this process')
      expect(said).toContain('say SQLite and run Postgres')
      expect(said).not.toContain('secret')
      expect(seen.connected).toEqual([])
      expect(config(home)).toBeNull()
    })

    it('over a machine that already wrote postgres', async () => {
      const home = freshHome()
      expect(await initCommand([], world(home, { answers: [URL_] }).world)).toBe(0)
      const before = written(home)
      const { world: w, seen } = world(home, {})
      expect(await initCommand(['--store', 'sqlite'], w)).toBe(1)
      expect(seen.lines.at(-1)).toContain('already says database.store: postgres')
      expect(seen.lines.at(-1)).toContain('new, empty log')
      expect(written(home)).toEqual(before)
      expect(storeChoice({ LINGTAI_HOME: home })).toMatchObject({ store: 'postgres', url: URL_ })
    })

    it('over postgres written with no url, and over a url written before the store was (#186)', async () => {
      for (const [text, quoted] of [
        ['database:\n  store: postgres\n', 'already says database.store: postgres'],
        [`database:\n  url: ${URL_}\n`, 'names database.url: postgresql://me:***@db.example:5432/lingtai'],
        [`database:\n  store: postgress\n  url: ${URL_}\n`, 'no valid database.store beside it'],
      ] as const) {
        const home = freshHome()
        mkdirSync(home, { recursive: true })
        writeFileSync(configPath({ LINGTAI_HOME: home }), text)
        const before = written(home)
        const { world: w, seen } = world(home, {})
        expect(await initCommand(['--store', 'sqlite'], w)).toBe(1)
        expect(seen.lines.at(-1)).toContain(quoted)
        expect(seen.lines.at(-1)).toContain('lingtai init --store sqlite again')
        expect(seen.lines.join('\n')).not.toContain('secret')
        expect(seen.connected).toEqual([])
        expect(written(home)).toEqual(before)
      }
    })
  })

  describe('--store postgres', () => {
    it('with --database-url, is --database-url', async () => {
      const home = freshHome()
      const { world: w, seen } = world(home, {})
      expect(await initCommand(['--store', 'postgres', '--database-url', URL_], w)).toBe(0)
      expect(seen.asked).toEqual([])
      expect(config(home)).toBe(`database:\n  store: postgres\n  url: ${URL_}\n`)
    })

    it('--database-url alone, with no --store, still repoints a machine already settled on another database that still answers', async () => {
      const home = freshHome()
      expect(await initCommand(['--store', 'postgres', '--database-url', URL_], world(home, {}).world)).toBe(0)
      const newer = 'postgresql://me:pw@db.new.example:5432/lingtai'
      const { world: w, seen } = world(home, { answering: [URL_, newer] })
      expect(await initCommand(['--database-url', newer], w)).toBe(0)
      expect(seen.asked).toEqual([])
      expect(seen.connected).toEqual([newer])
      expect(config(home)).toBe(`database:\n  store: postgres\n  url: ${newer}\n`)
    })

    it('with an exported LINGTAI_DATABASE_URL instead, uses it and writes nothing for it', async () => {
      const home = freshHome()
      const { world: w } = world(home, { env: { LINGTAI_DATABASE_URL: URL_ } })
      expect(await initCommand(['--store', 'postgres'], w)).toBe(0)
      expect(config(home)).toBeNull()

      // Naming the same database is that same run; naming another is refused, never ignored.
      const same = world(home, { env: { LINGTAI_DATABASE_URL: URL_ } })
      expect(await initCommand(['--store', 'postgres', '--database-url', URL_], same.world)).toBe(0)
      const other = world(home, { env: { LINGTAI_DATABASE_URL: URL_ } })
      const elsewhere = 'postgresql://me:hunter2@elsewhere.example/lingtai'
      expect(await initCommand(['--store', 'postgres', '--database-url', elsewhere], other.world)).toBe(1)
      expect(other.seen.connected).toEqual([])
      expect(other.seen.lines.at(-1)).toContain('exported URL wins')
      expect(other.seen.lines.join('\n')).not.toMatch(/secret|hunter2/)
      expect(config(home)).toBeNull()
    })

    it('--database-url alone, naming another database than an exported LINGTAI_DATABASE_URL, is refused rather than ignored', async () => {
      const home = freshHome()
      const { world: w, seen } = world(home, { env: { LINGTAI_DATABASE_URL: URL_ } })
      const other = 'postgresql://me:pw@db.new.example:5432/lingtai'
      expect(await initCommand(['--database-url', other], w)).toBe(1)
      expect(seen.connected).toEqual([])
      expect(seen.lines.at(-1)).toContain('exported URL wins')
      expect(seen.lines.join('\n')).not.toContain('--store postgres')
      expect(config(home)).toBeNull()
    })

    it("with no URL, or an empty one, is a usage refusal — never the empty answer's SQLite", async () => {
      for (const argv of [
        ['--store', 'postgres'],
        ['--store', 'postgres', '--database-url', ''],
        ['--database-url', ''],
      ]) {
        const home = freshHome()
        const { world: w, seen } = world(home, { answers: [''] })
        expect(await initCommand(argv, w)).toBe(2)
        expect(seen.asked).toEqual([])
        expect(seen.connected).toEqual([])
        expect(config(home)).toBeNull()
      }
    })

    it('--database-url alone, given as the empty string, refuses rather than repointing a settled machine to SQLite', async () => {
      const home = freshHome()
      expect(await initCommand(['--store', 'postgres', '--database-url', URL_], world(home, {}).world)).toBe(0)
      const before = config(home)
      const { world: w, seen } = world(home, {})
      expect(await initCommand(['--database-url', ''], w)).toBe(2)
      expect(seen.asked).toEqual([])
      expect(seen.connected).toEqual([])
      expect(config(home)).toBe(before)
    })

    it('--database-url alone, given as the empty string beside an exported LINGTAI_DATABASE_URL, is the same usage refusal — never "unset it"', async () => {
      const home = freshHome()
      const { world: w, seen } = world(home, { env: { LINGTAI_DATABASE_URL: URL_ } })
      expect(await initCommand(['--database-url', ''], w)).toBe(2)
      expect(seen.connected).toEqual([])
      expect(seen.lines.at(-1)).toContain('takes a postgres:// URL')
      expect(seen.lines.join('\n')).not.toContain('exported URL wins')
      expect(config(home)).toBeNull()
    })

    it('whose URL does not answer refuses, rather than going on with the SQLite the file already says', async () => {
      const home = freshHome()
      expect(await initCommand(['--store', 'sqlite'], world(home, {}).world)).toBe(0)
      const before = written(home)
      const gone = 'postgresql://me@gone.example/lingtai'
      const { world: w, seen } = world(home, { answers: [''] })
      expect(await initCommand(['--store', 'postgres', '--database-url', gone], w)).toBe(1)
      expect(seen.connected).toEqual([gone])
      expect(seen.asked).toEqual([])
      expect(seen.boards).toBe(0)
      expect(written(home)).toEqual(before)
    })
  })

  it('--store takes sqlite or postgres and nothing else', async () => {
    const home = freshHome()
    const { world: w } = world(home, {})
    expect(await initCommand(['--store', 'mysql'], w)).toBe(2)
    expect(await initCommand(['--store'], w)).toBe(2)
    expect(config(home)).toBeNull()
  })
})
