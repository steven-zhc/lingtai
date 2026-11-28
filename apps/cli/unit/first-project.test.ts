import { type ProjectState } from '@lingtai/domain'
/**
 * `chooseFirstProject` (#394): the local branch against a Map-backed `files`
 * seam and a programmable `git`, and the GitHub branch against the real
 * `choose`/`listRepositories` fed a fake reader — no filesystem, no network,
 * so this is `unit/` by 0060 §1.
 */
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { type AppReader, GitHubFailed, type GhRun } from '@lingtai/github'
import { ProjectFiles } from '@lingtai/project'
import { type RecipeFiles } from '@lingtai/recipe'
import { listRepositories as list, type Picker, type SetupReader } from '@lingtai/setup'
import type { RuntimeFound } from '@lingtai/setup'
import { Effect } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { GitResult, RegisterLocalPayload } from '../src/first-project.ts'
import { chooseFirstProjectEffect, liveFirstProjectWorld } from '../src/first-project.ts'
import {
  type FirstProjectTestWorld,
  liftFirstProjectWorld,
  type PromiseFirstProjectWorld,
} from '../test/first-project-world.ts'

/** `chooseFirstProjectEffect`, run to its outcome, the way every test here awaited `chooseFirstProject`. */
const chooseFirstProject = (
  world: FirstProjectTestWorld,
  ...rest: DropFirst<Parameters<typeof chooseFirstProjectEffect>>
) => Effect.runPromise(chooseFirstProjectEffect(world, ...rest).pipe(Effect.provideService(ProjectFiles, world.files)))
type DropFirst<T extends readonly unknown[]> = T extends readonly [unknown, ...infer R] ? R : never

const before = process.env['NO_COLOR']
beforeAll(() => {
  process.env['NO_COLOR'] = '1'
})
afterAll(() => {
  if (before === undefined) delete process.env['NO_COLOR']
  else process.env['NO_COLOR'] = before
})

const HOME = '/home/me/.lingtai'

function mapFiles(initial: Record<string, string> = {}): RecipeFiles & { replaced: Record<string, string> } {
  const store = new Map(Object.entries(initial))
  const replaced: Record<string, string> = {}
  return {
    replaced,
    read: async (path) => store.get(path) ?? null,
    replace: async (path, text) => {
      store.set(path, text)
      replaced[path] = text
    },
  }
}

const project = (name: string, owner: string | null): ProjectState => ({
  project: name,
  owner,
  base: 'main',
  configHash: owner !== null ? 'hash' : null,
  fromSha: null,
  refused: null,
  paused: null,
  recipe: null,
  sandboxObserved: null,
  highestPr: null,
  version: 1,
  lastSeq: 1n,
})

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

/** `FirstProjectWorld.runtimes`, derived from the same ids `signedIn` answers — the two cannot disagree. */
function runtimesFrom(signedIn: readonly string[]): RuntimeFound[] {
  return (['claude-code', 'codex'] as const).map((id) => ({
    id,
    state: signedIn.includes(id) ? 'signed-in' : 'signed-out',
    signedIn: signedIn.includes(id),
    detail: signedIn.includes(id) ? 'signed in' : 'not signed in',
  }))
}

const EMPTY_SETUP_READER: SetupReader = { has: () => Effect.succeed(false), read: () => Effect.succeed(null) }

interface Harness {
  world: FirstProjectTestWorld
  asked: string[]
  logged: string[]
  registered: RegisterLocalPayload[]
  authWrites: string[]
  files: RecipeFiles & { replaced: Record<string, string> }
  removed: string[]
}

function harness(options: {
  answers?: (string | null)[]
  /** Answers by prompt instead of by order: it may never resolve, which is how a test holds a run at one question. */
  ask?: (prompt: string) => Promise<string | null>
  git?: GitPlan
  projects?: ProjectState[]
  files?: Record<string, string>
  signedIn?: string[]
  setupReader?: PromiseFirstProjectWorld['setupReader']
  exists?: PromiseFirstProjectWorld['exists']
  app?: PromiseFirstProjectWorld['github']['app']
  boardUrl?: string | null
  waitForApp?: PromiseFirstProjectWorld['github']['waitForApp']
  picker?: PromiseFirstProjectWorld['github']['picker']
  add?: PromiseFirstProjectWorld['github']['add']
  kept?: string
  history?: PromiseFirstProjectWorld['history']
  inFlight?: PromiseFirstProjectWorld['inFlight']
  auth?: () => 'app' | 'gh' | null
  ghStatus?: PromiseFirstProjectWorld['github']['ghStatus']
  writeAuth?: PromiseFirstProjectWorld['github']['writeAuth']
  gh?: GhRun
}): Harness {
  const answers = [...(options.answers ?? [])]
  const asked: string[] = []
  const logged: string[] = []
  const registered: RegisterLocalPayload[] = []
  const removed: string[] = []
  const authWrites: string[] = []
  const files = mapFiles(options.files ?? {})
  const signedIn = options.signedIn ?? ['claude-code']

  const world: PromiseFirstProjectWorld = {
    ask: async (prompt) => {
      asked.push(prompt)
      if (options.ask !== undefined) return options.ask(prompt)
      return answers.length > 0 ? answers.shift()! : null
    },
    log: (line) => logged.push(line),
    git: fakeGit(options.git ?? {}),
    exists: options.exists ?? (async () => true),
    projects: async () => options.projects ?? [],
    locker: { tryLock: async () => ({ ok: true as const, lock: { release: async () => {} } }) },
    files,
    by: 'human:me',
    store: createMemoryEventStore(),
    home: HOME,
    signedIn: async () => signedIn as never[],
    runtimes: async () => runtimesFrom(signedIn),
    setupReader: options.setupReader ?? (() => EMPTY_SETUP_READER),
    register: async (payload) => {
      registered.push(payload)
      return { line: `added ${payload.project}`, updated: false }
    },
    kept: options.kept ?? 'Nothing was written',
    history: options.history ?? (async () => []),
    inFlight: options.inFlight ?? (async () => []),
    removeMirror: async (project) => {
      removed.push(project)
    },
    github: {
      ...(options.auth === undefined ? {} : { auth: options.auth }),
      ...(options.gh === undefined ? {} : { gh: options.gh }),
      ghStatus: options.ghStatus ?? (async () => ({ ok: false, reason: 'missing', detail: 'gh is not installed' })),
      writeAuth:
        options.writeAuth ??
        (async (kind) => {
          authWrites.push(kind)
        }),
      app: options.app ?? (async () => ({ configured: false })),
      boardUrl: async () => options.boardUrl ?? null,
      waitForApp: options.waitForApp ?? (async () => ({ skipped: true })),
      picker: options.picker ?? (async () => ({ installations: [], installUrl: null })),
      add: options.add ?? (async () => ({ ok: false as const })),
    },
  }
  return { world: liftFirstProjectWorld(world), asked, logged, registered, files, authWrites, removed }
}

/** The App machine's list, run: the function lives in `@lingtai/setup` and is an Effect. */
async function listRepositories(o: {
  reader: AppReader
  projects: readonly ProjectState[]
  installUrl: string | null
}): Promise<Picker> {
  const out = await Effect.runPromise(
    list({ auth: 'app', projects: o.projects, app: { reader: o.reader, installUrl: o.installUrl } }),
  )
  if (out.kind !== 'app') throw new Error('expected the App list')
  return out.picker
}

describe('chooseFirstProject — the GitHub branch (#394)', () => {
  interface FakeInstallation {
    id: number
    account: string
    repositories: string[]
  }

  function fakeReader(installations: FakeInstallation[]) {
    return {
      async request<T>(method: string, path: string, as: 'app' | number): Promise<T> {
        if (method !== 'GET') throw new Error(`wrote to GitHub: ${method} ${path}`)
        const url = new URL(path, 'https://api.github.com')
        if (url.pathname === '/app/installations' && as === 'app') {
          return installations.map((i) => ({
            id: i.id,
            permissions: {
              issues: 'write',
              contents: 'write',
              pull_requests: 'write',
              workflows: 'write',
              checks: 'read',
              statuses: 'read',
              metadata: 'read',
            },
            account: { login: i.account },
            repository_selection: 'selected',
            html_url: `https://github.com/settings/installations/${i.id}`,
          })) as T
        }
        if (url.pathname === '/installation/repositories' && typeof as === 'number') {
          const found = installations.find((i) => i.id === as)!
          return {
            repositories: found.repositories.map((name) => ({ name, owner: { login: found.account }, private: true })),
          } as T
        }
        throw new GitHubFailed(404, path, 'Not Found')
      },
    }
  }

  it('reaches waitForApp, then choose, then add, when no App is configured yet', async () => {
    const reader = fakeReader([{ id: 7, account: 'acme', repositories: ['widget'] }])
    const picker = await listRepositories({ reader, projects: [], installUrl: null })

    const added: unknown[] = []
    const { world, logged, authWrites } = harness({
      answers: ['create'],
      boardUrl: 'http://127.0.0.1:17820',
      waitForApp: async () => ({ made: { slug: 'lingtai-steven', owner: 'steven-zhc' } }),
      picker: async () => picker,
      add: async (options, log) => {
        added.push(options)
        log('installation 7 on acme (selected)')
        return { ok: true, updated: false, warnings: [], reach: { kind: 'gh', login: 'me' } }
      },
    })

    const result = await chooseFirstProject(world, { github: 'acme/widget', 'github-auth': 'app' })

    expect(result).toEqual({
      ok: true,
      project: 'github',
      app: { made: { slug: 'lingtai-steven', owner: 'steven-zhc' } },
      slug: 'acme/widget',
      updated: false,
      warnings: [],
      reach: { kind: 'gh', login: 'me' },
    })
    // Written once the App answered, not before.
    expect(authWrites).toEqual(['app'])
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ slug: 'acme/widget' })
    expect(logged).not.toContain('installation 7 on acme (selected)')
  })

  it('a repository the App cannot see is refused by name, and add is never called', async () => {
    const reader = fakeReader([{ id: 7, account: 'acme', repositories: ['widget'] }])
    const picker = await listRepositories({ reader, projects: [], installUrl: null })
    let addCalled = false

    const { world } = harness({
      app: async () => ({ configured: true, ok: true, slug: 'lingtai-steven', owner: 'steven-zhc' }),
      picker: async () => picker,
      add: async () => {
        addCalled = true
        return { ok: true, updated: false, warnings: [], reach: { kind: 'gh', login: 'me' } }
      },
    })

    const result = await chooseFirstProject(world, { github: 'acme/other' })

    expect(result).toEqual({ refused: expect.stringContaining('acme/other') })
    expect(addCalled).toBe(false)
  })

  it('a repository the App can see but the installation is missing permissions for names the gap and the fix, and add is never called (#394)', async () => {
    const scopedReader = {
      async request<T>(method: string, path: string, as: 'app' | number): Promise<T> {
        if (method !== 'GET') throw new Error(`wrote to GitHub: ${method} ${path}`)
        const url = new URL(path, 'https://api.github.com')
        if (url.pathname === '/app/installations' && as === 'app') {
          return [
            {
              id: 7,
              // `issues` is read, not write — one gap, same shape as a scoped
              // fine-grained token (#394 finding: the detail `add()` would
              // have printed must survive a refusal that never calls `add`).
              permissions: {
                issues: 'read',
                contents: 'write',
                pull_requests: 'write',
                workflows: 'write',
                checks: 'read',
                statuses: 'read',
                metadata: 'read',
              },
              account: { login: 'acme' },
              repository_selection: 'selected',
              html_url: 'https://github.com/settings/installations/7',
            },
          ] as T
        }
        if (url.pathname === '/installation/repositories' && typeof as === 'number') {
          return { repositories: [{ name: 'widget', owner: { login: 'acme' }, private: true }] } as T
        }
        throw new GitHubFailed(404, path, 'Not Found')
      },
    }
    const picker = await listRepositories({ reader: scopedReader, projects: [], installUrl: null })
    let addCalled = false

    const { world } = harness({
      app: async () => ({ configured: true, ok: true, slug: 'lingtai-steven', owner: 'steven-zhc' }),
      picker: async () => picker,
      add: async () => {
        addCalled = true
        return { ok: true, updated: false, warnings: [], reach: { kind: 'gh', login: 'me' } }
      },
    })

    const result = await chooseFirstProject(world, { github: 'acme/widget' })

    expect(result).toEqual({
      refused: expect.stringContaining(
        'The App can see acme/widget, but its installation on acme is missing permissions.\n' +
          'the installation is missing permissions:\n' +
          '  issues: have read, need write — reading work items, writing lingtai:* labels and comments\n' +
          "1. If the App does not ask for them yet, add them at the App's permissions page" +
          " (github.com/settings/apps, or the organisation's equivalent).\n" +
          '2. Then accept the new permissions on the installation: https://github.com/settings/installations/7.',
      ),
    })
    expect(addCalled).toBe(false)
  })

  it('an already-configured App with no slug reports "already", asking nothing', async () => {
    const { world, asked } = harness({
      app: async () => ({ configured: true, ok: true, slug: 'lingtai-steven', owner: 'steven-zhc' }),
    })

    const result = await chooseFirstProject(world, { project: 'github' })

    expect(result).toEqual({ ok: true, project: 'github', app: 'already' })
    expect(asked).toEqual([])
  })

  it('a failed registration is not logged by the add callback — only returned, so the caller prints it once (#394 finding 7)', async () => {
    const reader = fakeReader([{ id: 7, account: 'acme', repositories: ['widget'] }])
    const picker = await listRepositories({ reader, projects: [], installUrl: null })

    const { world, logged } = harness({
      app: async () => ({ configured: true, ok: true, slug: 'lingtai-steven', owner: 'steven-zhc' }),
      picker: async () => picker,
      add: async (_options, log) => {
        log('installation 7 on acme (selected)')
        log('the installation is missing permissions:')
        return { ok: false as const }
      },
    })

    const result = await chooseFirstProject(world, { github: 'acme/widget' })

    expect(result).toEqual({
      refused: 'installation 7 on acme (selected)\nthe installation is missing permissions:',
    })
    // Not logged during the call — only returned, so a caller that prints
    // `refused` is the one and only place these lines are shown.
    expect(logged).toEqual([])
  })

  it("a successful registration prints none of what add logged: that is the card's, not a dump (#755)", async () => {
    const reader = fakeReader([{ id: 7, account: 'acme', repositories: ['widget'] }])
    const picker = await listRepositories({ reader, projects: [], installUrl: null })

    const { world, logged } = harness({
      app: async () => ({ configured: true, ok: true, slug: 'lingtai-steven', owner: 'steven-zhc' }),
      picker: async () => picker,
      add: async (_options, log) => {
        log('added acme/widget')
        return { ok: true, updated: false, warnings: [], reach: { kind: 'gh', login: 'me' } }
      },
    })

    const result = await chooseFirstProject(world, { github: 'acme/widget' })

    expect(result).toMatchObject({ ok: true, project: 'github' })
    expect(logged).toEqual([])
    expect(result).toMatchObject({ updated: false, warnings: [] })
  })

  it('--github-app given beside a slug, with an App already configured, is refused rather than silently discarded (#394 finding 8)', async () => {
    let addCalled = false
    const { world } = harness({
      app: async () => ({ configured: true, ok: true, slug: 'lingtai-steven', owner: 'steven-zhc' }),
      add: async () => {
        addCalled = true
        return { ok: true, updated: false, warnings: [], reach: { kind: 'gh', login: 'me' } }
      },
    })

    const result = await chooseFirstProject(world, { github: 'acme/widget', 'github-app': 'create' })

    expect(result).toEqual({
      refused: expect.stringContaining('--github-app create, but a GitHub App is already configured here'),
    })
    expect(addCalled).toBe(false)
  })

  it('--tickets or --kinds against a GitHub project is refused rather than silently discarded (#396 fix round)', async () => {
    let addCalled = false
    const { world: worldWithTickets } = harness({
      app: async () => ({ configured: true, ok: true, slug: 'lingtai-steven', owner: 'steven-zhc' }),
      add: async () => {
        addCalled = true
        return { ok: true, updated: false, warnings: [], reach: { kind: 'gh', login: 'me' } }
      },
    })
    const ticketsResult = await chooseFirstProject(worldWithTickets, {
      project: 'github',
      kinds: 'bug,documentation',
      tickets: 'db',
    })
    expect(ticketsResult).toEqual({
      refused: expect.stringContaining('--tickets db, but a GitHub project asks neither question here'),
    })
    expect(addCalled).toBe(false)

    const { world: worldWithKinds } = harness({
      app: async () => ({ configured: true, ok: true, slug: 'lingtai-steven', owner: 'steven-zhc' }),
    })
    const kindsResult = await chooseFirstProject(worldWithKinds, { project: 'github', kinds: 'bug,documentation' })
    expect(kindsResult).toEqual({
      refused: expect.stringContaining('--kinds bug,documentation, but a GitHub project asks neither question here'),
    })
  })

  it("askRecipe's own flags against a GitHub project with no slug are refused rather than silently discarded (#431 fix round, finding 2)", async () => {
    let addCalled = false
    const { world } = harness({
      app: async () => ({ configured: true, ok: true, slug: 'lingtai-steven', owner: 'steven-zhc' }),
      add: async () => {
        addCalled = true
        return { ok: true, updated: false, warnings: [], reach: { kind: 'gh', login: 'me' } }
      },
    })
    const result = await chooseFirstProject(world, {
      project: 'github',
      'refusal-fixes': '3',
      agent: 'claude-code',
      budget: '9',
    })
    expect(result).toEqual({
      refused: expect.stringContaining("--agent claude-code, but a GitHub project asks none of askRecipe's questions"),
    })
    expect(addCalled).toBe(false)
  })

  it('a registered project is re-registered rather than refused as already onboarded (#394 finding 2)', async () => {
    const reader = fakeReader([{ id: 7, account: 'acme', repositories: ['widget'] }])
    const picker = await listRepositories({ reader, projects: [project('widget', 'acme')], installUrl: null })

    let addCalled = false
    const { world } = harness({
      app: async () => ({ configured: true, ok: true, slug: 'lingtai-steven', owner: 'steven-zhc' }),
      picker: async () => picker,
      add: async (options, log) => {
        addCalled = true
        log('updated')
        return { ok: true, updated: false, warnings: [], reach: { kind: 'gh', login: 'me' } }
      },
    })

    const result = await chooseFirstProject(world, { github: 'acme/widget' })

    expect(result).toMatchObject({ ok: true, project: 'github', slug: 'acme/widget' })
    expect(addCalled).toBe(true)
  })

  it('still asks local-or-github when an App is already configured — unlike init, add never forces github (#394 finding 5)', async () => {
    const { world, asked } = harness({
      app: async () => ({ configured: true, ok: true, slug: 'lingtai-steven', owner: 'steven-zhc' }),
      answers: ['local'],
    })

    const result = await chooseFirstProject(world, {})

    expect(asked.some((q) => q.includes('a GitHub project'))).toBe(true)
    // No --local directory was given either, so the local branch's own
    // question refuses by naming its flag — but reaching it at all is
    // finding 5's claim: a configured App no longer silently forces github.
    expect(result).toEqual({ refused: expect.stringContaining('the directory needs an answer') })
  })
})

describe('chooseFirstProject — contradicting flags are refused (#394)', () => {
  it('--local and --github together', async () => {
    const { world } = harness({})
    const result = await chooseFirstProject(world, { local: '/repo', mode: 'solo', github: 'acme/widget' })
    expect(result).toEqual({ refused: expect.stringContaining('--local /repo and --github acme/widget') })
  })

  it('--local with --project github', async () => {
    const { world } = harness({})
    const result = await chooseFirstProject(world, { local: '/repo', mode: 'solo', project: 'github' })
    expect(result).toEqual({ refused: expect.stringContaining('--project github names the other kind') })
  })

  it('--local with --github-app', async () => {
    const { world } = harness({})
    const result = await chooseFirstProject(world, { local: '/repo', mode: 'solo', 'github-app': 'create' })
    expect(result).toEqual({ refused: expect.stringContaining('creates no GitHub App') })
  })

  it('--github with --project local', async () => {
    const { world } = harness({})
    const result = await chooseFirstProject(world, { github: 'acme/widget', project: 'local' })
    expect(result).toEqual({ refused: expect.stringContaining('--project local names the other kind') })
  })
  /**
   * `lingtai add --local --base main` parses `--local` as '' — and `git` run in
   * '' runs in this process's own directory, so this registered whatever
   * repository the shell sat in (#394's review).
   */
  it('--local with no directory is refused before git is asked anything', async () => {
    // No git planned: `fakeGit` throws on any call, so a refusal is proof none was made.
    const { world, registered, files } = harness({})
    const result = await chooseFirstProject(world, { local: '', main: 'main' })
    expect(result).toEqual({ refused: expect.stringContaining('--local needs the directory') })
    expect(registered).toEqual([])
    expect(files.replaced).toEqual({})
  })

  it('--github with no repository is refused', async () => {
    const { world } = harness({})
    const result = await chooseFirstProject(world, { github: '' })
    expect(result).toEqual({ refused: expect.stringContaining('--github needs the repository') })
  })

  /**
   * #399: `--land` and `--main` are different questions, and naming both with
   * different branches must not have one silently overrule the other. On the
   * local branch, without this, the base question writes `repo.base: main`
   * and `askLanding` inside `askRecipe` later overwrites it with `develop`
   * (the second pass's finding 1) — so this has to be refused before the base
   * question is even asked, and nothing may be registered.
   */
  it('--main and --land naming different branches on the local branch is refused before anything is asked', async () => {
    const { world, asked, registered, files } = harness({})
    const result = await chooseFirstProject(world, { local: '/repo', mode: 'solo', main: 'main', land: 'develop' })
    expect(result).toEqual({
      refused: expect.stringContaining('--land develop and --main main name two different branches'),
    })
    expect(asked).toEqual([])
    expect(registered).toEqual([])
    expect(files.replaced).toEqual({})
  })

  it('--land hold does not contradict --main, since hold names no branch', async () => {
    const { world } = harness({
      git: {
        '/repo::rev-parse --show-toplevel': ok('/repo\n'),
        '/repo::rev-parse --verify refs/heads/lingtai-base^{commit}': ok('abc123f\n'),
      },
      answers: [...RECIPE_FLOW_DEFAULTS],
    })
    const result = await chooseFirstProject(world, { local: '/repo', mode: 'solo', main: 'lingtai-base', land: 'hold' })
    expect(result).not.toEqual({
      refused: expect.stringContaining('name two different branches'),
    })
  })
})

describe('liveFirstProjectWorld kept (#402 review)', () => {
  const ask = async () => null
  const log = () => {}

  it('says nothing was written when the caller wrote nothing', () => {
    expect(liveFirstProjectWorld({ ask, log }).kept).toBe('Nothing was written')
  })

  it("carries the caller's sentence when the caller already wrote answers", () => {
    expect(liveFirstProjectWorld({ ask, log, kept: 'The answers given above are kept' }).kept).toBe(
      'The answers given above are kept',
    )
  })
})

describe('runGithubBranch on a gh machine (#708)', () => {
  it('asks no App question, needs no board and no picker, and hands add no installation', async () => {
    const calls = { app: 0, board: 0, wait: 0, picker: 0, added: [] as unknown[] }
    const h = harness({
      app: async () => {
        calls.app++
        return { configured: false }
      },
      waitForApp: async () => {
        calls.wait++
        return { skipped: true }
      },
      picker: async () => {
        calls.picker++
        throw new Error('no picker')
      },
      add: async (options) => {
        calls.added.push(options)
        return { ok: true, updated: false, warnings: [], reach: { kind: 'gh', login: 'me' } }
      },
    })
    h.world.github.auth = () => 'gh'
    h.world.github.boardUrl = liftPort(async () => {
      calls.board++
      return null
    })
    const result = await chooseFirstProject(h.world, { github: 'acme/widgets' })
    expect(result).toEqual({
      ok: true,
      project: 'github',
      app: 'already',
      slug: 'acme/widgets',
      auth: 'gh',
      updated: false,
      warnings: [],
      reach: { kind: 'gh', login: 'me' },
    })
    expect(calls).toMatchObject({ app: 0, board: 0, wait: 0, picker: 0 })
    expect(calls.added).toEqual([{ slug: 'acme/widgets', installation: undefined, base: undefined }])
  })

  it("refuses another owner's repository of a registered project's name, and registers nothing", async () => {
    let added = 0
    const h = harness({
      projects: [project('widgets', 'acme')],
      add: async () => {
        added++
        return { ok: true, updated: false, warnings: [], reach: { kind: 'gh', login: 'me' } }
      },
    })
    h.world.github.auth = () => 'gh'
    const result = await chooseFirstProject(h.world, { github: 'other/widgets' })
    expect(result).toMatchObject({ refused: expect.stringContaining('already acme/widgets') })
    expect(added).toBe(0)
  })

  it('re-registers the same owner, in any case', async () => {
    let added = 0
    const h = harness({
      projects: [project('widgets', 'Acme')],
      add: async () => {
        added++
        return { ok: true, updated: false, warnings: [], reach: { kind: 'gh', login: 'me' } }
      },
    })
    h.world.github.auth = () => 'gh'
    const result = await chooseFirstProject(h.world, { github: 'acme/widgets' })
    expect(result).toMatchObject({ ok: true })
    expect(added).toBe(1)
  })

  it('refuses --github-app create, which has no App to create here', async () => {
    const h = harness({})
    h.world.github.auth = () => 'gh'
    const result = await chooseFirstProject(h.world, { github: 'acme/widgets', 'github-app': 'create' })
    expect(result).toMatchObject({ refused: expect.stringContaining('github.auth is gh') })
  })
})
