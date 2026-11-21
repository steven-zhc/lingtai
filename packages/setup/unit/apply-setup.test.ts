import { emptyProject, projectStream, type ProjectState } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { recipePath, ProjectFiles } from '@lingtai/project'
import { type RecipeChange, type RecipeFiles, resolveSource } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { alreadyAdded, alreadyAddedSentence, applySetup, previewSetup } from '../src/apply-setup.ts'

const HOME = '/home/me/.lingtai'
const path = recipePath('repo', HOME)
const CHANGES: RecipeChange[] = [
  { path: ['branch', 'main'], value: 'main' },
  { path: ['repo', 'remote'], value: '/repo' },
  { path: ['env', 'plantAt'], value: '.env.local' },
  { path: ['source', 'kinds'], value: ['bug'] },
]

const WHO = () => ({ by: 'human:me', store: createMemoryEventStore() })

function countingFiles(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const events: string[] = []
  const files: RecipeFiles = {
    read: (p) => Promise.resolve(store.get(p) ?? null),
    replace: (p, text) => {
      events.push('replace')
      store.set(p, text)
      return Promise.resolve()
    },
  }
  return { files, store, events }
}

describe('applySetup (#968)', () => {
  it('turns the answers into one write, the recipe resolves, and registration runs after it', async () => {
    const { files, store, events } = countingFiles()
    const register = Effect.sync(() => {
      events.push('register')
      return 'registered'
    })
    const done = await Effect.runPromise(
      applySetup({ home: HOME, ...WHO() }, { project: 'repo', changes: CHANGES }, register).pipe(
        Effect.provideService(ProjectFiles, files),
      ),
    )
    expect(events).toEqual(['replace', 'register'])
    expect(done.registered).toBe('registered')
    const resolved = resolveSource(store.get(path)!, path, path).recipe
    expect(resolved.branch.main).toBe('main')
    expect(resolved.env.plantAt).toBe('.env.local')
  })

  it('writes nothing and registers nothing when the answers do not resolve', async () => {
    const { files, store, events } = countingFiles()
    const register = Effect.sync(() => {
      events.push('register')
    })
    await expect(
      Effect.runPromise(
        applySetup(
          { home: HOME, ...WHO() },
          { project: 'repo', changes: [{ path: ['branch', 'main'], value: 'main' }] },
          register,
        ).pipe(Effect.provideService(ProjectFiles, files)),
      ),
    ).rejects.toThrow()
    expect(store.size).toBe(0)
    expect(events).toEqual([])
  })

  it('leaves the recipe when the registration fails, and a rerun over it is not refused', async () => {
    const { files, store } = countingFiles()
    await expect(
      Effect.runPromise(
        applySetup(
          { home: HOME, ...WHO() },
          { project: 'repo', changes: CHANGES },
          Effect.fail(new Error('append failed')),
        ).pipe(Effect.provideService(ProjectFiles, files)),
      ),
    ).rejects.toThrow('append failed')
    expect(store.has(path)).toBe(true)
    const again = await Effect.runPromise(
      applySetup({ home: HOME, ...WHO() }, { project: 'repo', changes: CHANGES }, Effect.succeed('ok')).pipe(
        Effect.provideService(ProjectFiles, files),
      ),
    )
    expect(again.registered).toBe('ok')
  })

  it('previewSetup shows the text applySetup writes, without writing', async () => {
    const { files, store } = countingFiles()
    const text = await Effect.runPromise(
      previewSetup({ home: HOME }, { project: 'repo', changes: CHANGES }).pipe(
        Effect.provideService(ProjectFiles, files),
      ),
    )
    expect(store.size).toBe(0)
    expect(resolveSource(text, path, path).recipe.repo?.remote).toBe('/repo')
  })

  it('a draft keeps every change and writes nothing to its base', async () => {
    const { files, store } = countingFiles()
    const { draftRecipe, ProjectFiles } = await import('@lingtai/project')
    const more: RecipeChange[] = [{ path: ['source', 'kinds'], value: ['bug', 'feature'] }]
    const draft = await Effect.runPromise(
      draftRecipe('repo', { home: HOME }).pipe(Effect.provideService(ProjectFiles, files)),
    )
    await Effect.runPromise(draft.set(CHANGES))
    await Effect.runPromise(draft.set(more))
    expect(store.size).toBe(0)
    expect(draft.changes()).toEqual([...CHANGES, ...more])
  })

  it('alreadyAdded matches the name in any case, and the sentence names the recipe', () => {
    const state: ProjectState = { ...emptyProject, project: 'Repo', base: 'main', version: 1 }
    expect(alreadyAdded([state], 'repo')).toBe(state)
    expect(alreadyAdded([state], 'other')).toBeUndefined()
    expect(alreadyAddedSentence('repo', HOME)).toContain(path)
  })
})

describe('applySetup — who (#1177)', () => {
  it('writes the file, then appends one event naming the caller, then registers', async () => {
    const { files, events } = countingFiles()
    const store = createMemoryEventStore()
    const append = store.append.bind(store)
    store.append = ((...args: Parameters<typeof append>) => {
      events.push('append')
      return append(...args)
    }) as typeof store.append
    await Effect.runPromise(
      applySetup(
        { home: HOME, by: 'human:me', store },
        { project: 'repo', changes: CHANGES },
        Effect.sync(() => void events.push('register')),
      ).pipe(Effect.provideService(ProjectFiles, files)),
    )
    expect(events).toEqual(['replace', 'append', 'register'])
    const read = await store.read(projectStream('repo'))
    expect(read.map((e) => [e.type, (e.data as { by: string }).by])).toEqual([['ProjectRecipeChanged', 'human:me']])
  })

  it('previewSetup appends nothing', async () => {
    // previewSetup takes no store and no `by`: all it could reach is the port, and the port is never written.
    const { files, store, events } = countingFiles()
    await Effect.runPromise(
      previewSetup({ home: HOME }, { project: 'repo', changes: CHANGES }).pipe(
        Effect.provideService(ProjectFiles, files),
      ),
    )
    expect(events).toEqual([])
    expect(store.size).toBe(0)
  })
})

describe('applySetup — the registration fails (#968)', () => {
  it('leaves the recipe it wrote and returns the registration’s error', async () => {
    const { files, store } = countingFiles()
    await expect(
      Effect.runPromise(
        applySetup(
          { home: HOME, ...WHO() },
          { project: 'repo', changes: CHANGES },
          Effect.fail(new Error('refused')),
        ).pipe(Effect.provideService(ProjectFiles, files)),
      ),
    ).rejects.toThrow('refused')
    expect(store.get(path)).toContain('main: main')
  })
})
