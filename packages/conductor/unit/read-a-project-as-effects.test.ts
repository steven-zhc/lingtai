/**
 * The Effects behind the project faces answer what the promises always did, on
 * the path where it matters: a defect is still an answer (#64, #134), and a
 * recipe that will not resolve is a typed failure rather than a defect (#1068).
 */
import type { ProjectState } from '@lingtai/domain'
import { projectStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { ProjectFiles, recipePath } from '@lingtai/project'
import { type RecipeFiles, sourceHashOf } from '@lingtai/recipe'
import { Cause, Effect, Exit } from 'effect'
import { describe, expect, it } from 'vitest'

import { projectFilterEffect } from '../src/filter.ts'
import { currentRecipeEffect } from '../src/projects.ts'

const state = { project: 'lingtai', owner: null, base: 'main' } as ProjectState

describe('projectFilterEffect', () => {
  it('answers { ok: false, problem } for a recipe seam that dies', async () => {
    const filter = await Effect.runPromise(
      projectFilterEffect(
        state,
        () => Effect.die(new Error('unused')),
        () => Effect.die(new Error('the seam blew up')),
      ),
    )

    expect(filter).toEqual({ project: 'lingtai', ok: false, problem: 'the seam blew up' })
  })
})

describe('currentRecipeEffect', () => {
  it('fails with a typed failure carrying the rejection’s message, not a defect', async () => {
    const exit = await Effect.runPromiseExit(
      currentRecipeEffect(state, undefined, undefined, {
        store: createMemoryEventStore(),
        host: 'skip',
        signedIn: async () => ['claude-code'],
      }).pipe(
        Effect.provideService(ProjectFiles, {
          read: () => Promise.reject(new Error('disk on fire')),
          replace: () => Promise.resolve(),
        }),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    expect(Cause.hasDies(exit.cause)).toBe(false)
    expect(Cause.hasFails(exit.cause)).toBe(true)
    expect((Cause.squash(exit.cause) as Error).message).toContain('disk on fire')
  })
})

describe('currentRecipeEffect records through loadProject (#1176)', () => {
  const HOME = '/h'
  const V1 = 'version: 2\nbranch:\n  main: main\nsource:\n  kinds: [bug]\nenv:\n  plantAt: .env.local\n'
  const V2 = `${V1}# edited by hand\n`

  it('records a file edited between two reads once, by file, and nothing on a third', async () => {
    const path = recipePath('lingtai', HOME)
    const map = new Map<string, string>([[path, V1]])
    const files: RecipeFiles = {
      read: async (p) => map.get(p) ?? null,
      replace: async (p, text) => void map.set(p, text),
    }
    const store = createMemoryEventStore()
    const read = () =>
      Effect.runPromise(
        currentRecipeEffect(state, undefined, undefined, {
          home: HOME,
          store,
          host: 'skip',
          signedIn: async () => ['claude-code'],
        }).pipe(Effect.provideService(ProjectFiles, files)),
      )
    const changed = async () =>
      (await store.read(projectStream('lingtai'))).filter((e) => e.type === 'ProjectRecipeChanged')

    await read()
    map.set(path, V2)
    await read()
    await read()

    const events = await changed()
    expect(events).toHaveLength(2)
    expect(events[1]?.data).toMatchObject({ by: 'file', sourceHash: sourceHashOf(V2) })
  })
})
