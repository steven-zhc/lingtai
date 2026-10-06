/**
 * `setRecipe` and `readRecipeKey` (#395): the writer around `editRecipe`
 * (#162). No filesystem — the file seam is a `Map`.
 */
import { describe, expect, it } from 'vitest'

import {
  type RecipeFiles,
  RecipeInvalidError,
  readRecipeKey,
  recipePath,
  resolveSource,
  setRecipe,
} from '../src/index.ts'

const HOME = '/home/me/.lingtai'

/** A comment above a top-level key, a trailing comment, a comment inside
 * `steps`, a block scalar `prompt:`, and `source.backoff`, which no test here
 * touches. */
const FIXTURE = `version: 2
# the repo this governs
repo:
  base: main
source:
  kinds: [bug]  # priority order
  # how long a backoff waits
  backoff: 2h
env:
  plantAt: .env.local
steps:
  design:
    # the architect reads the ticket before anything else runs
    - name: architect
      agent: claude-code
      prompt: |
        Read the ticket.
        Say what you plan to build.
  build:
    - name: test
      run: pnpm test
`

interface RecordingFiles extends RecipeFiles {
  replaced: { path: string; text: string }[]
}

function mapFiles(initial: Record<string, string> = {}): RecordingFiles {
  const store = new Map(Object.entries(initial))
  const replaced: { path: string; text: string }[] = []
  return {
    replaced,
    read: async (path) => store.get(path) ?? null,
    replace: async (path, text) => {
      replaced.push({ path, text })
      store.set(path, text)
    },
  }
}

const PATH = recipePath('app', HOME)

describe('setRecipe', () => {
  it('keeps every comment and every other key, byte for byte, setting steps.build on a recipe with comments', async () => {
    const files = mapFiles({ [PATH]: FIXTURE })
    const result = await setRecipe('app', [{ path: ['steps', 'build'], value: [{ name: 'lint', run: 'pnpm lint' }] }], {
      home: HOME,
      files,
    })

    const expected = `version: 2
# the repo this governs
repo:
  base: main
source:
  kinds: [bug]  # priority order
  # how long a backoff waits
  backoff: 2h
env:
  plantAt: .env.local
steps:
  design:
    # the architect reads the ticket before anything else runs
    - name: architect
      agent: claude-code
      prompt: |
        Read the ticket.
        Say what you plan to build.
  build:
    - name: lint
      run: pnpm lint
`
    expect(result).toEqual({ path: PATH, text: expected, written: true })
    expect(files.replaced).toEqual([{ path: PATH, text: expected }])
  })

  it('creates an absent file with only the keys set, and it resolves', async () => {
    const files = mapFiles()
    const changes = [
      { path: ['repo', 'base'], value: 'main' },
      { path: ['source', 'kinds'], value: ['bug'] },
      { path: ['env', 'plantAt'], value: '.env.local' },
      { path: ['steps', 'build'], value: [{ name: 'test', run: 'pnpm test' }] },
    ]
    const result = await setRecipe('app', changes, { home: HOME, files })

    expect(result.written).toBe(true)
    expect(result.text).toContain('version: 2')
    expect(result.text).not.toMatch(/discuss:/)
    expect(result.text).not.toMatch(/exclude:/)
    expect(result.text).not.toMatch(/backoff:/)
    expect(files.replaced).toEqual([{ path: PATH, text: result.text }])

    const resolved = resolveSource(result.text, 'main', PATH)
    expect(resolved.recipe.repo.base).toBe('main')
    expect(resolved.recipe.source.kinds).toEqual(['bug'])
    expect(resolved.recipe.env.plantAt).toBe('.env.local')
  })

  it('refuses a write the resolver would refuse, and leaves the file unchanged', async () => {
    const absent = mapFiles()
    await expect(
      setRecipe('app', [{ path: ['steps', 'build'], value: [{ name: 't', run: 'x' }] }], {
        home: HOME,
        files: absent,
      }),
    ).rejects.toThrow(RecipeInvalidError)
    expect(absent.replaced).toEqual([])

    const misspelled = mapFiles({ [PATH]: FIXTURE })
    await expect(
      setRecipe('app', [{ path: ['steps', 'merg'], value: [] }], { home: HOME, files: misspelled }),
    ).rejects.toThrow(RecipeInvalidError)
    expect(misspelled.replaced).toEqual([])

    const emptied = mapFiles({ [PATH]: FIXTURE })
    await expect(
      setRecipe('app', [{ path: ['source', 'kinds'], value: [] }], { home: HOME, files: emptied }),
    ).rejects.toThrow(RecipeInvalidError)
    expect(emptied.replaced).toEqual([])
  })

  it('is a no-op when a change sets the value the file already has', async () => {
    const files = mapFiles({ [PATH]: FIXTURE })
    const result = await setRecipe('app', [{ path: ['repo', 'base'], value: 'main' }], { home: HOME, files })

    expect(result).toEqual({ path: PATH, text: FIXTURE, written: false })
    expect(files.replaced).toEqual([])
  })
})

describe('readRecipeKey', () => {
  it('returns the current value for a written key', async () => {
    const files = mapFiles({ [PATH]: FIXTURE })
    expect(await readRecipeKey('app', ['source', 'kinds'], { home: HOME, files })).toEqual(['bug'])
  })

  it('returns null for an unwritten key, and null for an absent file', async () => {
    const files = mapFiles({ [PATH]: FIXTURE })
    expect(await readRecipeKey('app', ['runtime', 'agent'], { home: HOME, files })).toBeNull()
    expect(await readRecipeKey('app', ['source', 'kinds'], { home: HOME, files: mapFiles() })).toBeNull()
  })
})
