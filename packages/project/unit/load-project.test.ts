/**
 * `loadProject` (0128 §6, #1175), on the memory store and a `Map`-backed port provided as `ProjectFiles`.
 * Every row of the table; the refusing rows assert no event and no write.
 */
import { projectStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { EventStore } from '@lingtai/event-store/store'
import { RecipeFailed, RecipeInvalidError, RecipeMissingError, type RecipeFiles, sourceHashOf } from '@lingtai/recipe'
import { skipSandboxHost } from '@lingtai/recipe/test/sandbox-host'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { ProjectFiles, loadProject, recipePath, recordFileRecipe } from '../src/index.ts'

const HOME = '/h'
const P = 'app'
const PATH = recipePath(P, HOME)
const A = 'version: 2\nrepo:\n  base: main\nsource:\n  kinds: [bug]\nenv:\n  plantAt: .env.local\n'
const B = `${A}# edited\n`

function port(initial: Record<string, string>, failRead = false) {
  const map = new Map(Object.entries(initial))
  const writes: string[] = []
  const files: RecipeFiles = {
    read: async (path) => {
      if (failRead) throw new Error('EACCES')
      return map.get(path) ?? null
    },
    replace: async (path, text) => {
      writes.push(path)
      map.set(path, text)
    },
  }
  return { map, writes, files }
}

const load = (store: EventStore, files: RecipeFiles, signed: ('claude-code' | 'codex')[] = ['claude-code']) =>
  loadProject(P, { home: HOME, store, ...skipSandboxHost, signedIn: async () => signed }).pipe(
    Effect.provideService(ProjectFiles, files),
  )

const events = async (store: EventStore) => (await store.read(projectStream(P))).map((e) => e.type)

describe('loadProject', () => {
  it('records the first declaration, by file, and resolves it', async () => {
    const store = createMemoryEventStore()
    const { files, writes } = port({ [PATH]: A })
    const { state, recipe } = await Effect.runPromise(load(store, files))
    expect(await events(store)).toEqual(['ProjectRecipeChanged'])
    expect(state.recipe?.sourceHash).toBe(sourceHashOf(A))
    expect(recipe.recipe.branch.main).toBe('main')
    expect(writes).toEqual([])
  })

  it('appends nothing when the hash is on record, and again on a second load', async () => {
    const store = createMemoryEventStore()
    const { files, writes } = port({ [PATH]: A })
    await Effect.runPromise(load(store, files))
    await Effect.runPromise(load(store, files))
    expect(await events(store)).toEqual(['ProjectRecipeChanged'])
    expect(writes).toEqual([])
  })

  it('records an edit and resolves the file’s source', async () => {
    const store = createMemoryEventStore()
    const { files, map, writes } = port({ [PATH]: A })
    await Effect.runPromise(load(store, files))
    map.set(PATH, B)
    const { state, recipe } = await Effect.runPromise(load(store, files))
    expect(await events(store)).toEqual(['ProjectRecipeChanged', 'ProjectRecipeChanged'])
    expect(state.recipe?.source).toBe(B)
    expect(recipe.source).toBe(B)
    expect(writes).toEqual([])
  })

  it('treats CRLF as the same declaration', async () => {
    const store = createMemoryEventStore()
    const { files, map } = port({ [PATH]: A })
    await Effect.runPromise(load(store, files))
    map.set(PATH, A.replace(/\n/g, '\r\n'))
    await Effect.runPromise(load(store, files))
    expect(await events(store)).toEqual(['ProjectRecipeChanged'])
  })

  it('records nothing when a signed-in runtime changes between two loads', async () => {
    const store = createMemoryEventStore()
    const { files } = port({ [PATH]: A })
    await Effect.runPromise(load(store, files, ['claude-code']))
    await Effect.runPromise(load(store, files, ['codex']))
    expect(await events(store)).toEqual(['ProjectRecipeChanged'])
  })

  it('records the edit of a recipe the host then refuses to resolve, and fails the resolve', async () => {
    const store = createMemoryEventStore()
    const { files } = port({ [PATH]: A })
    const exit = await Effect.runPromise(load(store, files, ['claude-code', 'codex']).pipe(Effect.flip))
    expect(exit).toBeInstanceOf(Error)
    expect(await events(store)).toEqual(['ProjectRecipeChanged'])
  })

  it('fails with RecipeMissingError for a missing file, appending and writing nothing', async () => {
    const store = createMemoryEventStore()
    const { files, writes } = port({})
    const err = await Effect.runPromise(load(store, files).pipe(Effect.flip))
    expect(err).toBeInstanceOf(RecipeMissingError)
    expect(await events(store)).toEqual([])
    expect(writes).toEqual([])
  })

  it('fails with RecipeFailed (read) for an unreadable file, never falling back to the recorded source', async () => {
    const store = createMemoryEventStore()
    await Effect.runPromise(load(store, port({ [PATH]: A }).files))
    const { files, writes } = port({ [PATH]: B }, true)
    const err = await Effect.runPromise(load(store, files).pipe(Effect.flip))
    expect(err).toBeInstanceOf(RecipeFailed)
    expect((err as RecipeFailed).operation).toBe('read')
    expect(await events(store)).toEqual(['ProjectRecipeChanged'])
    expect(writes).toEqual([])
  })

  it('fails with RecipeInvalidError for an invalid declaration, appending and writing nothing', async () => {
    const store = createMemoryEventStore()
    const { files, writes } = port({ [PATH]: `${A}nonsense: 1\n` })
    const err = await Effect.runPromise(load(store, files).pipe(Effect.flip))
    expect(err).toBeInstanceOf(RecipeInvalidError)
    expect(await events(store)).toEqual([])
    expect(writes).toEqual([])
  })

  it('fails on a failed store read, appending nothing', async () => {
    const real = createMemoryEventStore()
    const broken = {
      ...real,
      read: async () => {
        throw new Error('down')
      },
    } as EventStore
    const { files, writes } = port({ [PATH]: A })
    const err = await Effect.runPromise(load(broken, files).pipe(Effect.flip))
    expect((err as Error).message).toContain('down')
    expect(await events(real)).toEqual([])
    expect(writes).toEqual([])
  })

  it('two passes at once record one edit', async () => {
    const store = createMemoryEventStore()
    const seen = { sourceHash: sourceHashOf(A), source: A, by: 'file' as const }
    await Effect.runPromise(
      Effect.all([recordFileRecipe(P, seen, store), recordFileRecipe(P, seen, store)], { concurrency: 2 }),
    )
    expect(await events(store)).toEqual(['ProjectRecipeChanged'])
  })

  it('a read delayed past another reader’s newer edit does not record its older observation over it', async () => {
    const store = createMemoryEventStore()
    const { files, map } = port({ [PATH]: A })
    await Effect.runPromise(load(store, files))
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let first = true
    const slow: RecipeFiles = {
      replace: files.replace,
      read: async (path) => {
        const text = await files.read(path)
        if (first) {
          first = false
          await held
        }
        return text
      },
    }
    const delayed = Effect.runPromise(load(store, slow))
    await new Promise((r) => setTimeout(r, 10))
    map.set(PATH, B)
    await Effect.runPromise(load(store, files))
    release()
    await delayed
    await Effect.runPromise(load(store, files))
    const recorded = (await store.read(projectStream(P))).map((e) => (e.data as { sourceHash: string }).sourceHash)
    expect(recorded).toEqual([sourceHashOf(A), sourceHashOf(B)])
  })
})
