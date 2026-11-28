import type { ProjectState } from '@lingtai/domain'
/** In-memory machine, checkout, recipe and registrations for the init/add entry points. */
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { RecipeFiles } from '@lingtai/recipe'
import { EMPTY_SETUP_READER } from '@lingtai/setup'
import { Effect } from 'effect'

import type { AskBeforeGithubAddDeps } from '../src/add-github.ts'
import type { AddWorld } from '../src/add.ts'
import type { FirstProjectWorld, GitResult, RegisterLocalPayload } from '../src/first-project.ts'
import type { InitWorld } from '../src/init.ts'

export const HOME = '/home/me/.lingtai'
export const PATH = `${HOME}/repo/recipe.yml`
export const projectState = (name = 'repo', owner: string | null = null): ProjectState => ({
  project: name,
  owner,
  base: 'lingtai-base',
  configHash: 'hash',
  fromSha: 'sha',
  refused: null,
  paused: null,
  recipe: null,
  sandboxObserved: null,
  highestPr: null,
  version: 1,
  lastSeq: 1n,
})
const ok = (stdout = ''): GitResult => ({ ok: true, stdout, stderr: '' })
export function setupWorld(
  at: { text?: string; projects?: ProjectState[]; origin?: string; interactive?: boolean } = {},
) {
  const events: string[] = []
  const logged: string[] = []
  const registered: RegisterLocalPayload[] = []
  const branches = new Map([['main', 'abc123f']])
  const recipes = new Map(at.text === undefined ? [] : [[PATH, at.text]])
  const writes: string[] = []
  const machineFiles = new Map([[`${HOME}/config.yml`, 'database:\n  store: sqlite\ngithub:\n  auth: gh\n']])
  const files: RecipeFiles = {
    read: (path) => Promise.resolve(recipes.get(path) ?? null),
    replace: (path, text) => {
      events.push('recipe')
      writes.push(text)
      recipes.set(path, text)
      return Promise.resolve()
    },
  }
  const store = createMemoryEventStore()
  const runtimes = () =>
    Effect.succeed([{ id: 'claude-code', state: 'signed-in', signedIn: true, detail: 'signed in' }] as const)
  const log = (line: string) => {
    logged.push(line)
  }
  const ask: FirstProjectWorld['ask'] = (prompt) => {
    events.push(`ask:${prompt}`)
    return Promise.resolve(/use every default/.test(prompt) ? 'no' : '')
  }
  const projects = () => Effect.succeed(at.projects ?? [])
  const git: FirstProjectWorld['git'] = (_dir, args) =>
    Effect.sync(() => {
      if (args.join(' ') === 'rev-parse --show-toplevel') return ok('/repo')
      if (args.join(' ') === 'symbolic-ref --short -q HEAD') return ok('main')
      if (args[0] === 'rev-parse') {
        const name = args
          .at(-1)!
          .replace(/^refs\/heads\//, '')
          .replace(/\^\{commit\}$/, '')
        return branches.has(name)
          ? ok(branches.get(name))
          : { ok: false, stdout: '', stderr: 'fatal: Needed a single revision' }
      }
      if (args[0] === 'branch') {
        events.push(`branch:${args[1]}`)
        branches.set(args[1]!, branches.get(args[2]!)!)
        return ok()
      }
      if (args.join(' ') === 'remote') return ok(at.origin === undefined ? '' : 'origin')
      if (args.join(' ') === 'remote get-url origin')
        return at.origin === undefined ? { ok: false, stdout: '', stderr: 'no origin' } : ok(at.origin)
      if (args[0] === 'rev-list') return ok()
      throw new Error(`unplanned git: ${args.join(' ')}`)
    })
  const ghStatus: FirstProjectWorld['github']['ghStatus'] = () =>
    Effect.succeed({ ok: true, login: 'sam', scopes: ['repo', 'workflow'] })
  const locker = { tryLock: () => Promise.resolve({ ok: true as const, lock: { release: () => Promise.resolve() } }) }
  const doctor = () =>
    Effect.succeed({
      report: { ok: 3, notChecked: 0, deferred: 0 },
      toFix: { count: 0, failed: false },
      blocks: 'doctor: 3 ok',
    })
  const project: FirstProjectWorld = {
    interactive: at.interactive ?? true,
    ask,
    log,
    git,
    exists: () => Effect.succeed(true),
    projects,
    locker,
    store,
    by: 'human:me',
    home: HOME,
    signedIn: () => Promise.resolve(['claude-code']),
    runtimes,
    setupReader: () => EMPTY_SETUP_READER,
    register: (payload) =>
      Effect.sync(() => {
        events.push('register')
        registered.push(payload)
        return { line: 'added repo', updated: at.projects !== undefined }
      }),
    history: () => Effect.succeed([]),
    inFlight: () => Effect.succeed([]),
    removeMirror: () =>
      Effect.sync(() => {
        events.push('mirror')
      }),
    kept: 'Nothing was written',
    github: {
      auth: () => 'gh',
      ghStatus,
      writeAuth: () => Effect.void,
      app: () => Effect.succeed({ configured: false }),
      boardUrl: () => Effect.succeed(null),
      waitForApp: () => Effect.succeed({ skipped: true }),
      picker: () => Effect.succeed({ installations: [], installUrl: null }),
      add: (opts) =>
        Effect.succeed({
          ok: true,
          owner: 'acme',
          repo: 'repo',
          base: opts.base ?? 'main',
          warnings: [],
          updated: false,
          reach: { kind: 'gh', login: 'sam' },
        }),
    },
  }
  const githubDeps: AskBeforeGithubAddDeps = {
    auth: () => 'gh',
    interactive: () => at.interactive ?? true,
    check: () => Effect.die('App not used'),
    ghAccess: () => Effect.succeed({ login: 'sam', defaultBranch: 'main' }),
    picker: project.github.picker,
    reader: () => Effect.succeed(EMPTY_SETUP_READER),
    ask,
    runtimes,
    history: project.history,
    defaultBranch: () => Effect.succeed('main'),
    client: () =>
      Effect.succeed({
        branchExists: () => Promise.resolve(true),
        refSha: () => Promise.resolve('sha'),
        createBranch: () => Promise.resolve(),
        token: () => Promise.resolve('token'),
        request: () => Promise.resolve({ commits: [] }),
      } as never),
  }
  const add: AddWorld = {
    project,
    githubDeps,
    log,
    error: log,
    doctor,
    userHome: '/home/me',
    store: () => ({ store: 'sqlite', path: `${HOME}/lingtai.db`, where: 'config.yml', from: `${HOME}/config.yml` }),
    labels: () => Effect.succeed({ createLabel: () => Promise.resolve('created' as const) }),
    issueForms: () => Effect.succeed({ kind: 'none' as const }),
  }
  const init: InitWorld = {
    env: { VITEST: '1', HOME: '/home/me', LINGTAI_HOME: HOME },
    interactive: at.interactive ?? true,
    machine: {
      read: (p) => machineFiles.get(p) ?? null,
      write: (p, t) => {
        machineFiles.set(p, t)
      },
      describeHome: () => 'configured',
    },
    ask,
    log,
    git: () => Effect.succeed('git version 2.50'),
    runtimes,
    exists: project.exists,
    setupReader: project.setupReader,
    database: () => Effect.succeed({ ok: true, schema: { created: false, repaired: [] } }),
    ghStatus,
    app: project.github.app,
    appeared: () => Effect.never,
    pressed: () => Effect.never,
    boardAt: () => Effect.succeed(null),
    board: () => Effect.succeed({ url: 'http://127.0.0.1:17820' }),
    open: () => Effect.succeed(true),
    runGit: git,
    projects,
    locker,
    store,
    signedIn: project.signedIn,
    registerLocal: project.register,
    history: project.history,
    inFlight: project.inFlight,
    removeMirror: project.removeMirror,
    githubProject: { deps: githubDeps, add: project.github.add, labels: add.labels },
    doctor,
    cwd: '/elsewhere',
  }
  return { init, add, project, files, events, logged, registered, branches, recipes, writes, store, machineFiles }
}
