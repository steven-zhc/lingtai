import { emptyProject, type ProjectState } from '@lingtai/domain'
import { type RecipeChange, type RecipeFiles, recipePath, resolveSource } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { alreadyAdded, alreadyAddedSentence, applySetup, draftFiles, previewSetup } from '../src/apply-setup.ts'

const HOME = '/home/me/.lingtai'
const path = recipePath('repo', HOME)
const CHANGES: RecipeChange[] = [
  { path: ['repo', 'base'], value: 'main' },
  { path: ['repo', 'remote'], value: '/repo' },
  { path: ['env', 'plantAt'], value: '.env.local' },
  { path: ['source', 'kinds'], value: ['bug'] },
]

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
      applySetup({ home: HOME, files }, { project: 'repo', changes: CHANGES }, register),
    )
    expect(events).toEqual(['replace', 'register'])
    expect(done.registered).toBe('registered')
    const resolved = resolveSource(store.get(path)!, path, path).recipe
    expect(resolved.repo.base).toBe('main')
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
          { home: HOME, files },
          { project: 'repo', changes: [{ path: ['repo', 'base'], value: 'main' }] },
          register,
        ),
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
          { home: HOME, files },
          { project: 'repo', changes: CHANGES },
          Effect.fail(new Error('append failed')),
        ),
      ),
    ).rejects.toThrow('append failed')
    expect(store.has(path)).toBe(true)
    const again = await Effect.runPromise(
      applySetup({ home: HOME, files }, { project: 'repo', changes: CHANGES }, Effect.succeed('ok')),
    )
    expect(again.registered).toBe('ok')
  })

  it('previewSetup shows the text applySetup writes, without writing', async () => {
    const { files, store } = countingFiles()
    const text = await Effect.runPromise(previewSetup({ home: HOME, files }, { project: 'repo', changes: CHANGES }))
    expect(store.size).toBe(0)
    expect(resolveSource(text, path, path).recipe.repo.remote).toBe('/repo')
  })

  it('a draft keeps every change and writes nothing to its base', async () => {
    const { files, store } = countingFiles()
    const draft = draftFiles(files, path)
    const { setRecipeEffect } = await import('@lingtai/recipe')
    const more: RecipeChange[] = [{ path: ['source', 'kinds'], value: ['bug', 'feature'] }]
    await Effect.runPromise(setRecipeEffect('repo', CHANGES, { home: HOME, files: draft }))
    await Effect.runPromise(setRecipeEffect('repo', more, { home: HOME, files: draft }))
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

describe('applySetup — the registration fails (#968)', () => {
  it('leaves the recipe it wrote and returns the registration’s error', async () => {
    const { files, store } = countingFiles()
    await expect(
      Effect.runPromise(
        applySetup({ home: HOME, files }, { project: 'repo', changes: CHANGES }, Effect.fail(new Error('refused'))),
      ),
    ).rejects.toThrow('refused')
    expect(store.get(path)).toContain('base: main')
  })
})
