/**
 * The Effects behind the project faces answer what the promises always did, on
 * the path where it matters: a defect is still an answer (#64, #134), and a
 * recipe that will not resolve is a typed failure rather than a defect (#1068).
 */
import type { ProjectState } from '@lingtai/domain'
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
        read: () => Promise.reject(new Error('disk on fire')),
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    expect(Cause.hasDies(exit.cause)).toBe(false)
    expect(Cause.hasFails(exit.cause)).toBe(true)
    expect((Cause.squash(exit.cause) as Error).message).toContain('disk on fire')
  })
})
