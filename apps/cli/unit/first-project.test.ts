/**
 * `chooseFirstProject` (#394): the local branch against a Map-backed `files`
 * seam and a programmable `git`, and the GitHub branch against the real
 * `choose`/`listRepositories` fed a fake reader — no filesystem, no network,
 * so this is `unit/` by 0060 §1.
 */
import { listRepositories } from '@lingtai/conductor/pick-repository'
import type { ProjectState } from '@lingtai/domain'
import { GitHubError } from '@lingtai/github'
import type { RecipeFiles } from '@lingtai/recipe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { FirstProjectWorld, GitResult, RegisterLocalPayload } from '../src/first-project.ts'
import { chooseFirstProject } from '../src/first-project.ts'

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
  version: 1,
  lastSeq: 1n,
})

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
const fail = (stderr: string): GitResult => ({ ok: false, stdout: '', stderr })

interface Harness {
  world: FirstProjectWorld
  asked: string[]
  logged: string[]
  registered: RegisterLocalPayload[]
  files: RecipeFiles & { replaced: Record<string, string> }
}

function harness(options: {
  answers?: (string | null)[]
  git?: GitPlan
  projects?: ProjectState[]
  files?: Record<string, string>
  signedIn?: string[]
  app?: FirstProjectWorld['github']['app']
  boardUrl?: string | null
  waitForApp?: FirstProjectWorld['github']['waitForApp']
  picker?: FirstProjectWorld['github']['picker']
  add?: FirstProjectWorld['github']['add']
  kept?: string
}): Harness {
  const answers = [...(options.answers ?? [])]
  const asked: string[] = []
  const logged: string[] = []
  const registered: RegisterLocalPayload[] = []
  const files = mapFiles(options.files ?? {})

  const world: FirstProjectWorld = {
    ask: async (prompt) => {
      asked.push(prompt)
      return answers.length > 0 ? answers.shift()! : null
    },
    log: (line) => logged.push(line),
    git: fakeGit(options.git ?? {}),
    projects: async () => options.projects ?? [],
    files,
    home: HOME,
    signedIn: async () => (options.signedIn ?? ['claude-code']) as never[],
    register: async (payload) => {
      registered.push(payload)
      return `added ${payload.project}`
    },
    kept: options.kept ?? 'Nothing was written',
    github: {
      app: options.app ?? (async () => ({ configured: false })),
      boardUrl: async () => options.boardUrl ?? null,
      waitForApp: options.waitForApp ?? (async () => ({ skipped: true })),
      picker: options.picker ?? (async () => ({ installations: [], installUrl: null })),
      add: options.add ?? (async () => 1),
    },
  }
  return { world, asked, logged, registered, files }
}

describe('chooseFirstProject — the local branch (#394)', () => {
  it('--local <dir> with an origin registers once, with owner: null and both repo.base and repo.remote written', async () => {
    const { world, registered, files } = harness({
      git: {
        '/repo::rev-parse --show-toplevel': ok('/repo\n'),
        '/repo::remote get-url origin': ok('https://github.com/acme/widget.git\n'),
        '/repo::symbolic-ref --short refs/remotes/origin/HEAD': ok('origin/main\n'),
        '/repo::rev-parse --verify main^{commit}': ok('abc123f\n'),
      },
      projects: [],
      // The base question has no --base flag: an empty line at the terminal
      // takes the detected default ("main", from symbolic-ref above).
      answers: [''],
    })

    const result = await chooseFirstProject(world, { local: '/repo' })

    expect(result).toEqual({
      ok: true,
      project: 'local',
      name: 'repo',
      remote: 'https://github.com/acme/widget.git',
      base: 'main',
    })
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({
      project: 'repo',
      owner: null,
      base: 'main',
      fromSha: 'abc123f',
    })

    const path = `${HOME}/repo/recipe.yml`
    expect(files.replaced[path]).toContain('base: main')
    expect(files.replaced[path]).toContain('remote: https://github.com/acme/widget.git')
  })

  it('a relative origin is written absolute, resolved against the toplevel', async () => {
    const { world, files } = harness({
      git: {
        '/home/me/repos/widget::rev-parse --show-toplevel': ok('/home/me/repos/widget\n'),
        '/home/me/repos/widget::remote get-url origin': ok('../bare/widget.git\n'),
        '/home/me/repos/widget::symbolic-ref --short refs/remotes/origin/HEAD': ok('origin/main\n'),
        '/home/me/repos/widget::rev-parse --verify main^{commit}': ok('deadbee\n'),
      },
      answers: [''],
    })

    const result = await chooseFirstProject(world, { local: '/home/me/repos/widget' })

    expect(result).toMatchObject({ ok: true, remote: '/home/me/repos/bare/widget.git' })
    const path = `${HOME}/widget/recipe.yml`
    expect(files.replaced[path]).toContain('remote: /home/me/repos/bare/widget.git')
  })

  it('a directory that is not a git repository is refused by name, and nothing is written', async () => {
    const { world, registered, files } = harness({
      git: { '/nope::rev-parse --show-toplevel': fail('fatal: not a git repository') },
    })

    const result = await chooseFirstProject(world, { local: '/nope' })

    expect(result).toEqual({ refused: expect.stringContaining('/nope is not a git repository') })
    expect(registered).toEqual([])
    expect(files.replaced).toEqual({})
  })

  it('a repository with no origin is refused by name, naming the merge lane, and nothing is written', async () => {
    const { world, registered, files } = harness({
      git: {
        '/repo::rev-parse --show-toplevel': ok('/repo\n'),
        '/repo::remote get-url origin': fail('fatal: No such remote'),
      },
    })

    const result = await chooseFirstProject(world, { local: '/repo' })

    expect(result).toEqual({ refused: expect.stringContaining('merge-action.ts:47') })
    expect(registered).toEqual([])
    expect(files.replaced).toEqual({})
  })

  it('a name already taken by an owner is refused by name, and nothing is written', async () => {
    const { world, registered, files } = harness({
      git: {
        '/repo::rev-parse --show-toplevel': ok('/repo\n'),
        '/repo::remote get-url origin': ok('https://github.com/acme/widget.git\n'),
      },
      projects: [project('repo', 'someone-else')],
    })

    const result = await chooseFirstProject(world, { local: '/repo' })

    expect(result).toEqual({ refused: expect.stringContaining('someone-else/repo') })
    expect(registered).toEqual([])
    expect(files.replaced).toEqual({})
  })

  it('a name already taken by an owner, differing only in case, is refused by name — a case-insensitive filesystem resolves them to one file (#394 finding 4)', async () => {
    const { world, registered, files } = harness({
      git: {
        '/code/myapp::rev-parse --show-toplevel': ok('/code/myapp\n'),
        '/code/myapp::remote get-url origin': ok('https://github.com/me/myapp.git\n'),
      },
      projects: [project('MyApp', 'acme')],
    })

    const result = await chooseFirstProject(world, { local: '/code/myapp' })

    expect(result).toEqual({ refused: expect.stringContaining('acme/myapp') })
    expect(registered).toEqual([])
    expect(files.replaced).toEqual({})
  })

  it('an owner: null project of the same name with a different repo.remote is refused by name, naming both remotes', async () => {
    const path = `${HOME}/repo/recipe.yml`
    const { world, registered } = harness({
      git: {
        '/repo::rev-parse --show-toplevel': ok('/repo\n'),
        '/repo::remote get-url origin': ok('https://github.com/acme/widget.git\n'),
      },
      projects: [project('repo', null)],
      files: { [path]: 'version: 2\nrepo:\n  base: main\n  remote: https://github.com/other/thing.git\n' },
    })

    const result = await chooseFirstProject(world, { local: '/repo' })

    expect(result).toEqual({
      refused: expect.stringContaining('https://github.com/other/thing.git'),
    })
    expect(registered).toEqual([])
  })

  it('an owner: null project of the same name with no repo.remote recorded is refused by name, never silently re-pointed (#394 finding 1)', async () => {
    const path = `${HOME}/widget/recipe.yml`
    const { world, registered, files } = harness({
      git: {
        '/code/widget::rev-parse --show-toplevel': ok('/code/widget\n'),
        '/code/widget::remote get-url origin': ok('https://github.com/acme/widget.git\n'),
      },
      // Registered before owners were recorded, as a GitHub project — no
      // `repo.remote` was ever written for it, since the schema makes the
      // key optional (`recipe.ts`).
      projects: [project('widget', null)],
      files: { [path]: 'version: 2\nrepo:\n  base: main\n' },
    })

    const result = await chooseFirstProject(world, { local: '/code/widget' })

    expect(result).toEqual({ refused: expect.stringContaining('already registered with no repo.remote recorded') })
    expect(registered).toEqual([])
    expect(files.replaced).toEqual({})
  })

  it('no agent signed in is refused by name, before anything is written', async () => {
    const { world, registered, files } = harness({
      git: {
        '/repo::rev-parse --show-toplevel': ok('/repo\n'),
        '/repo::remote get-url origin': ok('https://github.com/acme/widget.git\n'),
        '/repo::symbolic-ref --short refs/remotes/origin/HEAD': ok('origin/main\n'),
        '/repo::rev-parse --verify main^{commit}': ok('abc123f\n'),
      },
      signedIn: [],
      answers: [''],
    })

    const result = await chooseFirstProject(world, { local: '/repo' })

    expect(result).toEqual({ refused: expect.stringContaining('no agent runtime is signed in') })
    expect(registered).toEqual([])
    expect(files.replaced).toEqual({})
  })

  it('--base answers the base question without a TTY, validated against the directory', async () => {
    const { world, registered } = harness({
      git: {
        '/repo::rev-parse --show-toplevel': ok('/repo\n'),
        '/repo::remote get-url origin': ok('https://github.com/acme/widget.git\n'),
        '/repo::symbolic-ref --short refs/remotes/origin/HEAD': ok('origin/main\n'),
        '/repo::rev-parse --verify develop^{commit}': ok('cafefee\n'),
      },
    })

    const result = await chooseFirstProject(world, { local: '/repo', base: 'develop' })

    expect(result).toMatchObject({ ok: true, base: 'develop' })
    expect(registered[0]).toMatchObject({ base: 'develop', fromSha: 'cafefee' })
  })

  it('the directory question reports the caller\'s kept clause, not "Nothing was written" (#394)', async () => {
    // No --local: the project-kind question is asked first (answered
    // 'local'), then the directory question — the one under test — gets no
    // answer at all, so it refuses by name.
    const { world } = harness({ kept: 'the store chosen above is kept', answers: ['local'] })

    const result = await chooseFirstProject(world, {})

    expect(result).toEqual({
      refused: expect.stringContaining(
        'the directory needs an answer: pass --local <dir>. the store chosen above is kept',
      ),
    })
  })

  it('the base branch question reports the caller\'s kept clause, not "Nothing was written" (#394)', async () => {
    const { world } = harness({
      kept: 'the store chosen above is kept',
      git: {
        '/repo::rev-parse --show-toplevel': ok('/repo\n'),
        '/repo::remote get-url origin': ok('https://github.com/acme/widget.git\n'),
        '/repo::symbolic-ref --short refs/remotes/origin/HEAD': ok('origin/main\n'),
      },
    })

    const result = await chooseFirstProject(world, { local: '/repo' })

    expect(result).toEqual({
      refused: expect.stringContaining(
        'the base branch needs an answer: pass --base <branch>. the store chosen above is kept',
      ),
    })
  })
})

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
            permissions: { issues: 'write', contents: 'write', pull_requests: 'write', metadata: 'read' },
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
        throw new GitHubError(404, path, 'Not Found')
      },
    }
  }

  it('reaches waitForApp, then choose, then add, when no App is configured yet', async () => {
    const reader = fakeReader([{ id: 7, account: 'acme', repositories: ['widget'] }])
    const picker = await listRepositories({ reader, projects: [], installUrl: null })

    const added: unknown[] = []
    const { world, logged } = harness({
      answers: ['create'],
      boardUrl: 'http://127.0.0.1:17820',
      waitForApp: async () => ({ made: { slug: 'lingtai-steven', owner: 'steven-zhc' } }),
      picker: async () => picker,
      add: async (options, log) => {
        added.push(options)
        log('installation 7 on acme (selected)')
        return 0
      },
    })

    const result = await chooseFirstProject(world, { github: 'acme/widget' })

    expect(result).toEqual({
      ok: true,
      project: 'github',
      app: { made: { slug: 'lingtai-steven', owner: 'steven-zhc' } },
      slug: 'acme/widget',
    })
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ slug: 'acme/widget' })
    expect(logged).toContain('installation 7 on acme (selected)')
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
        return 0
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
              permissions: { issues: 'read', contents: 'write', pull_requests: 'write', metadata: 'read' },
              account: { login: 'acme' },
              repository_selection: 'selected',
              html_url: 'https://github.com/settings/installations/7',
            },
          ] as T
        }
        if (url.pathname === '/installation/repositories' && typeof as === 'number') {
          return { repositories: [{ name: 'widget', owner: { login: 'acme' }, private: true }] } as T
        }
        throw new GitHubError(404, path, 'Not Found')
      },
    }
    const picker = await listRepositories({ reader: scopedReader, projects: [], installUrl: null })
    let addCalled = false

    const { world } = harness({
      app: async () => ({ configured: true, ok: true, slug: 'lingtai-steven', owner: 'steven-zhc' }),
      picker: async () => picker,
      add: async () => {
        addCalled = true
        return 0
      },
    })

    const result = await chooseFirstProject(world, { github: 'acme/widget' })

    expect(result).toEqual({
      refused: expect.stringContaining(
        'The App can see acme/widget, but its installation on acme is missing permissions.\n' +
          'the installation is missing permissions:\n' +
          '  issues: have read, need write — reading work items, writing agent:* labels and comments\n' +
          "Grant them on the installation's page: https://github.com/settings/installations/7",
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
        return 1
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

  it('a successful registration is logged once, after add returns', async () => {
    const reader = fakeReader([{ id: 7, account: 'acme', repositories: ['widget'] }])
    const picker = await listRepositories({ reader, projects: [], installUrl: null })

    const { world, logged } = harness({
      app: async () => ({ configured: true, ok: true, slug: 'lingtai-steven', owner: 'steven-zhc' }),
      picker: async () => picker,
      add: async (_options, log) => {
        log('added acme/widget')
        return 0
      },
    })

    const result = await chooseFirstProject(world, { github: 'acme/widget' })

    expect(result).toMatchObject({ ok: true, project: 'github' })
    expect(logged).toEqual(['added acme/widget'])
  })

  it('--github-app given beside a slug, with an App already configured, is refused rather than silently discarded (#394 finding 8)', async () => {
    let addCalled = false
    const { world } = harness({
      app: async () => ({ configured: true, ok: true, slug: 'lingtai-steven', owner: 'steven-zhc' }),
      add: async () => {
        addCalled = true
        return 0
      },
    })

    const result = await chooseFirstProject(world, { github: 'acme/widget', 'github-app': 'create' })

    expect(result).toEqual({
      refused: expect.stringContaining('--github-app create, but a GitHub App is already configured here'),
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
        return 0
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
    const result = await chooseFirstProject(world, { local: '/repo', github: 'acme/widget' })
    expect(result).toEqual({ refused: expect.stringContaining('--local /repo and --github acme/widget') })
  })

  it('--local with --project github', async () => {
    const { world } = harness({})
    const result = await chooseFirstProject(world, { local: '/repo', project: 'github' })
    expect(result).toEqual({ refused: expect.stringContaining('--project github names the other kind') })
  })

  it('--local with --github-app', async () => {
    const { world } = harness({})
    const result = await chooseFirstProject(world, { local: '/repo', 'github-app': 'create' })
    expect(result).toEqual({ refused: expect.stringContaining('creates no GitHub App') })
  })

  it('--github with --project local', async () => {
    const { world } = harness({})
    const result = await chooseFirstProject(world, { github: 'acme/widget', project: 'local' })
    expect(result).toEqual({ refused: expect.stringContaining('--project local names the other kind') })
  })
})
