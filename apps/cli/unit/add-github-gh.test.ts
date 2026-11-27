/**
 * `askBeforeGithubAdd` on a `gh` machine (#708): the saved login's access is
 * checked where the App check is on an App machine, before a recipe answer is
 * written, and the App is never consulted.
 */
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { ProjectFiles } from '@lingtai/project'
import type { RecipeFiles } from '@lingtai/recipe'
import type { SetupReader } from '@lingtai/setup'
import { applySetup } from '@lingtai/setup'
import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDocument } from 'yaml'

import { askBeforeGithubAddEffect, type AskBeforeGithubAddDeps } from '../src/add-github.ts'
import { githubEntryFor } from '../src/machine-askers.ts'

const fx = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (e) => e })

/** `askBeforeGithubAdd` writes nothing (#968); `applySetup` does, just before the registration — done here in its place. */
type TestDeps = AskBeforeGithubAddDeps & { files: RecipeFiles }

async function askBeforeGithubAdd(
  slug: string,
  flags: Record<string, string>,
  { files, ...deps }: TestDeps,
  buildFlags?: readonly string[],
) {
  const result = await Effect.runPromise(
    askBeforeGithubAddEffect(slug, flags, deps, buildFlags).pipe(Effect.provideService(ProjectFiles, files)),
  )
  if (typeof result === 'object') {
    await Effect.runPromise(
      applySetup({ by: 'human:me', store: createMemoryEventStore() }, result.answers, Effect.void).pipe(
        Effect.provideService(ProjectFiles, files),
      ),
    )
  }
  return result
}

const SLUG = 'acme/widgets'
const PREVIOUS_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...PREVIOUS_ENV }
  vi.restoreAllMocks()
})

function depsFor(over: Partial<TestDeps>) {
  const calls = { check: 0, picker: 0, writes: 0, reach: [] as unknown[] }
  const store: Record<string, string> = {}
  const reader: SetupReader = { has: () => Effect.succeed(false), read: () => Effect.succeed(null) }
  const deps: TestDeps = {
    check: () =>
      Effect.sync(() => {
        calls.check++
        return null
      }),
    auth: () => 'gh',
    interactive: () => true,
    ghAccess: () => fx(async () => ({ login: 'sam', defaultBranch: 'main' })),
    picker: () =>
      fx(async () => {
        calls.picker++
        throw new Error('no picker')
      }),
    files: {
      read: async (path) => store[path] ?? null,
      replace: async (path, text) => {
        calls.writes++
        store[path] = text
      },
    },
    reader: (_o, _r, reach) =>
      fx(async () => {
        calls.reach.push(reach)
        return reader
      }),
    ask: async () => '',
    runtimes: () => fx(async () => [{ id: 'claude-code', state: 'signed-in', signedIn: true, detail: 'signed in' }]),
    history: () => Effect.succeed([]),
    ...over,
  }
  return { deps, calls, store }
}

describe('askBeforeGithubAdd on a gh machine (#708)', () => {
  it('adds with no installation call, no picker and the repository read through gh', async () => {
    // A full App is configured too, and is not the auth: `gh` wins.
    process.env['LINGTAI_GITHUB_APP_ID'] = '1'
    process.env['LINGTAI_GITHUB_APP_PRIVATE_KEY'] = 'x'
    const { deps, calls } = depsFor({})
    const code = await askBeforeGithubAdd(SLUG, { main: 'main', mode: 'solo', install: 'none' }, deps, ['none'])
    expect(typeof code).toBe('object')
    expect(calls.check).toBe(0)
    expect(calls.picker).toBe(0)
    expect(calls.writes).toBeGreaterThan(0)
    expect(calls.reach).toEqual([{ kind: 'gh' }])
  })

  it('refuses by name and writes nothing when the access check refuses', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { deps, calls } = depsFor({
      ghAccess: (_slug, log) =>
        fx(async () => {
          log('gh is signed in as sam without workflow — run `gh auth refresh --hostname github.com --scopes workflow`')
          return null
        }),
    })
    const code = await askBeforeGithubAdd(SLUG, {}, deps)
    expect(code).toBe(1)
    expect(calls.writes).toBe(0)
    expect(calls.check).toBe(0)
    expect(String(error.mock.calls[0]?.[0])).toContain('--scopes workflow')
  })

  it('refuses naming --github-auth gh when nothing is configured and there is no terminal', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { deps, calls } = depsFor({ auth: () => null, interactive: () => false })
    expect(await askBeforeGithubAdd(SLUG, {}, deps)).toBe(1)
    expect(calls.writes).toBe(0)
    expect(String(error.mock.calls[0]?.[0])).toContain('--github-auth gh')
  })

  it('refuses a refused github.auth by name before anything is written', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { deps, calls } = depsFor({
      auth: () => {
        throw new Error('github.auth is "foo"')
      },
    })
    expect(await askBeforeGithubAdd(SLUG, {}, deps)).toBe(1)
    expect(calls.writes).toBe(0)
    expect(String(error.mock.calls[0]?.[0])).toContain('github.auth')
  })
})

/** The machine list's GitHub entry over a world whose `gh` is signed in as `me`, answering the question with `answer`. */
function authDep(answer: string, written: string[], asked: { message: string; defaultValue: string }[]) {
  return (flags: Record<string, string>) =>
    githubEntryFor(
      {
        ask: async (_prompt, shape) => {
          asked.push({ message: shape!.message, defaultValue: shape!.defaultValue })
          return answer
        },
        log: () => {},
        env: {},
        machine: {
          read: () => null,
          write: (_path, text) => void written.push(String(parseDocument(text).getIn(['github', 'auth']))),
        },
        path: '/h/.lingtai/config.yml',
        interactive: true,
        app: () => Effect.succeed({ configured: false }),
        ghStatus: () => Effect.succeed({ ok: true, login: 'me', scopes: ['repo', 'workflow'] }),
        recipes: () => Effect.succeed([]),
        run: () => Promise.resolve({ code: 0 }),
      },
      flags,
      'Nothing was written',
    )
}

describe('askBeforeGithubAdd asks how this machine reaches GitHub before it reads the repository (#1487)', () => {
  it('asks with gh as the default naming the login, writes gh, checks access and seeds main from the default branch', async () => {
    const written: string[] = []
    const asked: { message: string; defaultValue: string }[] = []
    const { deps, calls, store } = depsFor({
      auth: () => null,
      ghAccess: () => fx(async () => ({ login: 'me', defaultBranch: 'trunk' })),
      githubAuth: authDep('gh', written, asked),
    })
    const code = await askBeforeGithubAdd(SLUG, { mode: 'solo', install: 'none' }, deps, ['none'])
    expect(typeof code).toBe('object')
    expect(asked).toHaveLength(1)
    expect(asked[0]!.defaultValue).toBe('gh')
    expect(asked[0]!.message).toContain('signed in as me')
    expect(written).toEqual(['gh'])
    expect(calls.reach).toEqual([{ kind: 'gh' }])
    expect(Object.values(store).join('\n')).toMatch(/main: trunk/)
  })

  it('stops, writing nothing, when the question is refused', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const written: string[] = []
    const { deps, calls } = depsFor({
      auth: () => null,
      githubAuth: () => Effect.succeed({ refused: 'cancelled. Nothing was written' }),
    })
    expect(await askBeforeGithubAdd(SLUG, {}, deps)).toBe(1)
    expect(written).toEqual([])
    expect(calls.writes).toBe(0)
    expect(String(error.mock.calls[0]?.[0])).toContain('Nothing was written')
  })

  it('refuses an app answer with no App and no --main, naming --main and --github-auth gh', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { deps, calls } = depsFor({ auth: () => null, githubAuth: authDep('app', [], []) })
    expect(await askBeforeGithubAdd(SLUG, {}, deps)).toBe(1)
    expect(calls.writes).toBe(0)
    const said = String(error.mock.calls[0]?.[0])
    expect(said).toContain('no GitHub App is configured here yet')
    expect(said).toContain('--main')
    expect(said).toContain('--github-auth gh')
  })

  it('refuses --github-auth app the same way, without asking', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const asked: { message: string; defaultValue: string }[] = []
    const { deps } = depsFor({ auth: () => null, githubAuth: authDep('gh', [], asked) })
    expect(await askBeforeGithubAdd(SLUG, { 'github-auth': 'app' }, deps)).toBe(1)
    expect(asked).toEqual([])
    expect(String(error.mock.calls[0]?.[0])).toContain('no GitHub App is configured here yet')
  })

  it('carries the default branch read’s own message when an App machine cannot read it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.env['LINGTAI_GITHUB_APP_ID'] = '1'
    process.env['LINGTAI_GITHUB_APP_PRIVATE_KEY'] = 'x'
    const { deps, calls } = depsFor({
      auth: () => 'app',
      check: () => Effect.succeed({ id: 7 } as never),
      defaultBranch: () => Effect.fail(new Error('GitHub did not answer: connect ETIMEDOUT')),
    })
    expect(await askBeforeGithubAdd(SLUG, {}, deps)).toBe(1)
    expect(calls.writes).toBe(0)
    const said = String(error.mock.calls[0]?.[0])
    expect(said).toContain('connect ETIMEDOUT')
    expect(said).toContain('--main')
    expect(said).toContain('Nothing was written')
  })
})

describe('add owner/repo on a machine whose github.auth is none (#1522)', () => {
  it('asks the GitHub entry and refuses none as its answer, by name, writing nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const written: string[] = []
    const { deps, calls } = depsFor({
      auth: () => null,
      githubAuth: authDep('none', written, []),
    })
    expect(await askBeforeGithubAdd(SLUG, { 'github-auth': 'none' }, deps)).toBe(1)
    expect(written).toEqual([])
    expect(calls.writes).toBe(0)
    expect(String(error.mock.calls[0]?.[0])).toContain('none is not one')
  })
})
