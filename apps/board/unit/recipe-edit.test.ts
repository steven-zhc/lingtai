import { resolveLocalRecipe, type RecipeFiles } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { hashOf, saveRecipeText } from '../src/lib/recipe-edit'

const home = '/fake/home'
const path = `${home}/proj/recipe.yml`
const machine = `${home}/config.yml`
const GOOD = '# keep me\nversion: 2\nrepo:\n  base: main\nsource:\n  kinds: [bug]\nenv:\n  plantAt: .env.local\n'

function run(files: Map<string, string>, draft: string, loaded?: string) {
  const replace = vi.fn(async (p: string, t: string) => void files.set(p, t))
  const fs: RecipeFiles = { read: async (p) => files.get(p) ?? null, replace }
  const result = Effect.runPromise(
    saveRecipeText({
      files: fs,
      path,
      machineAt: machine,
      draft,
      loaded: loaded ?? hashOf(files.get(path) ?? null),
      check: (d) =>
        resolveLocalRecipe('proj', {
          home,
          base: 'main',
          signedIn: async () => ['claude-code'],
          read: async (p) => (p === path ? d : (files.get(p) ?? null)),
        }),
    }),
  )
  return { result, replace }
}

describe('saving a recipe', () => {
  it('refuses one that does not resolve and leaves the file alone', async () => {
    const files = new Map([[path, GOOD]])
    const { result, replace } = run(files, GOOD + 'bogus_key: 1\n')
    const r = await result
    expect(r.ok).toBe(false)
    expect(r.problems?.join('\n') + r.detail).toMatch(/bogus_key/)
    expect(replace).not.toHaveBeenCalled()
    expect(files.get(path)).toBe(GOOD)
  })

  it('writes one that resolves, as typed, with comments and LF endings', async () => {
    const files = new Map([[path, GOOD]])
    const draft = GOOD.replace('keep me', 'changed comment').replace(/\n/g, '\r\n')
    const { result, replace } = run(files, draft)
    expect((await result).ok).toBe(true)
    expect(replace).toHaveBeenCalledTimes(1)
    expect(files.get(path)).toBe(draft.replace(/\r\n/g, '\n'))
  })

  it('writes nothing when nothing changed', async () => {
    const files = new Map([[path, GOOD]])
    const { result, replace } = run(files, GOOD.replace(/\n/g, '\r\n'))
    expect((await result).detail).toBe('nothing changed')
    expect(replace).not.toHaveBeenCalled()
  })

  it('refuses when the file changed since the page loaded, or went away', async () => {
    const files = new Map([[path, GOOD]])
    const stale = run(files, GOOD + '# more\n', hashOf('something else'))
    expect((await stale.result).ok).toBe(false)
    expect(stale.replace).not.toHaveBeenCalled()
    const gone = run(new Map(), GOOD, hashOf(GOOD))
    expect((await gone.result).ok).toBe(false)
    expect(gone.replace).not.toHaveBeenCalled()
  })

  it('names config.yml when the machine file is at fault', async () => {
    const files = new Map([
      [path, GOOD],
      [machine, 'runtime: {}\n'],
    ])
    const { result, replace } = run(files, GOOD + '# edit\n')
    const r = await result
    expect(r.ok).toBe(false)
    expect(r.detail).toContain(machine)
    expect(replace).not.toHaveBeenCalled()
  })
})

describe('saving a recipe, the sequences that lost work', () => {
  it('validates an unchanged draft, so a recipe the resolver rejects is not called fine', async () => {
    const bad = GOOD + 'bogus_key: 1\n'
    const { result, replace } = run(new Map([[path, bad]]), bad)
    const r = await result
    expect(r.ok).toBe(false)
    expect(r.problems?.join('\n') + r.detail).toMatch(/bogus_key/)
    expect(replace).not.toHaveBeenCalled()
  })

  it('refuses the second of two tabs that loaded the same text', async () => {
    const files = new Map([[path, GOOD]])
    const loaded = hashOf(GOOD)
    const a = run(files, GOOD + '# a\n', loaded)
    const b = run(files, GOOD + '# b\n', loaded)
    const [ra, rb] = await Promise.all([a.result, b.result])
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1)
    expect(files.get(path)).toBe(GOOD + '# a\n')
  })
})
