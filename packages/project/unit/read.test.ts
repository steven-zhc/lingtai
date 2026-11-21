/**
 * `recipeText` and `recipeValue` (0128 §6, §7, #1178), on the memory store and a `Map`-backed port
 * provided as `ProjectFiles`: a read records a declaration the log has not seen, and never writes the file.
 */
import { projectStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { EventStore } from '@lingtai/event-store/store'
import { type RecipeFiles } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { ProjectFiles, changeRecipe, recipePath, recipeText, recipeValue } from '../src/index.ts'

const HOME = '/h'
const P = 'app'
const PATH = recipePath(P, HOME)
const SEED = [
  { path: ['branch', 'main'], value: 'main' },
  { path: ['env', 'plantAt'], value: '.env.local' },
  { path: ['source', 'kinds'], value: ['bug'] },
]

function port() {
  const map = new Map<string, string>()
  const writes: string[] = []
  const files: RecipeFiles = {
    read: async (path) => map.get(path) ?? null,
    replace: async (path, text) => {
      writes.push(path)
      map.set(path, text)
    },
  }
  return { map, writes, files }
}

const read = (store: EventStore, files: RecipeFiles) =>
  recipeText(P, { home: HOME, store }).pipe(Effect.provideService(ProjectFiles, files))

const recorded = async (store: EventStore) =>
  (await store.read(projectStream(P))).filter((e) => e.type === 'ProjectRecipeChanged')

describe('recipeText', () => {
  it('records an edit once, by file, and records nothing on the read after', async () => {
    const store = createMemoryEventStore()
    const { files, map, writes } = port()
    await Effect.runPromise(
      changeRecipe(P, { changes: SEED }, { by: 'human:t', store, home: HOME }).pipe(
        Effect.provideService(ProjectFiles, files),
      ),
    )
    const written = writes.length
    expect(written).toBe(1)

    // 1. The file is what the log has: the text comes back and nothing is appended.
    expect(await Effect.runPromise(read(store, files))).toBe(map.get(PATH))
    expect(await recorded(store)).toHaveLength(1)

    // 2. A hand edit between two reads is one `ProjectRecipeChanged { by: 'file' }`.
    map.set(PATH, `${map.get(PATH)}# edited by hand\n`)
    expect(await Effect.runPromise(read(store, files))).toContain('# edited by hand')
    const after = await recorded(store)
    expect(after).toHaveLength(2)
    expect((after[1]!.data as { by: string }).by).toBe('file')

    // 3. Read again, unchanged: nothing more.
    await Effect.runPromise(read(store, files))
    expect(await recorded(store)).toHaveLength(2)
    expect(writes).toHaveLength(written)
  })

  it('answers null for a missing file, appends nothing and writes nothing', async () => {
    const store = createMemoryEventStore()
    const { files, writes } = port()
    expect(await Effect.runPromise(read(store, files))).toBeNull()
    expect(await recorded(store)).toEqual([])
    expect(writes).toEqual([])
  })

  it('returns text the declaration check refuses, and records nothing', async () => {
    const store = createMemoryEventStore()
    const { files, map } = port()
    map.set(PATH, 'version: 2\nrepo: [not, a, mapping]\n')
    expect(await Effect.runPromise(read(store, files))).toBe('version: 2\nrepo: [not, a, mapping]\n')
    expect(await recorded(store)).toEqual([])
  })

  it('fails with the error of an unreadable file, never an empty recipe', async () => {
    const store = createMemoryEventStore()
    const files: RecipeFiles = {
      read: async () => {
        throw new Error('EACCES')
      },
      replace: async () => {},
    }
    await expect(Effect.runPromise(read(store, files))).rejects.toThrow()
  })
})

describe('recipeValue', () => {
  it('is what the file says, and null for an unwritten key or no file', async () => {
    const store = createMemoryEventStore()
    const { files } = port()
    const value = (keyPath: string[]) =>
      Effect.runPromise(recipeValue(P, keyPath, { home: HOME, store }).pipe(Effect.provideService(ProjectFiles, files)))
    expect(await value(['source', 'kinds'])).toBeNull()
    await Effect.runPromise(
      changeRecipe(P, { changes: SEED }, { by: 'human:t', store, home: HOME }).pipe(
        Effect.provideService(ProjectFiles, files),
      ),
    )
    expect(await value(['source', 'kinds'])).toEqual(['bug'])
    expect(await value(['runtime', 'agent'])).toBeNull()
  })
})
