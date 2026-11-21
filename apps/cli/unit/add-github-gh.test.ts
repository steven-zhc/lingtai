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

import { askBeforeGithubAddEffect, type AskBeforeGithubAddDeps } from '../src/add-github.ts'

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
  return { deps, calls }
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

  it('refuses with run lingtai init when nothing is configured and there is no terminal', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { deps, calls } = depsFor({ auth: () => null, interactive: () => false })
    expect(await askBeforeGithubAdd(SLUG, {}, deps)).toBe(1)
    expect(calls.writes).toBe(0)
    expect(String(error.mock.calls[0]?.[0])).toContain('lingtai init')
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
