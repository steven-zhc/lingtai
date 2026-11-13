/**
 * **Whatever a recipe read does, the pass answers `stage: 'recipe'`** (#1082). The read is
 * `currentRecipeEffect` when no `options.recipe` is handed in, and a daemon restarted onto a
 * recipe it cannot read must take nothing at all rather than crash every pass: a failure
 * (an invalid recipe) and a defect (a read that dies) are answered the same way, carrying the
 * message. `Effect.result` would have seen only the first.
 */
import { Effect } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runOnce } from '../src/conduct.ts'
import { currentRecipeEffect } from '../src/projects.ts'
import { fakeGitHub, fakePorts, memoryStore, project, runtime, withPorts } from '../test/one-attempt.ts'

vi.mock('../src/projects.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/projects.ts')>()),
  currentRecipeEffect: vi.fn(),
}))

const pass = () => {
  const store = memoryStore()
  const did: string[] = []
  return Effect.runPromise(
    runOnce({
      project,
      client: fakeGitHub([]),
      runtime,
      issue: 7,
      hookBinary: '/tmp/fake/lingtai-hook',
      prompt: 'fix {{issue}}',
      home: '/tmp/fake-home',
      store,
    }).pipe(Effect.provide(withPorts(fakePorts(did, store)))),
  ).then((result) => ({ result, did }))
}

describe('a recipe read that does not answer', () => {
  beforeEach(() => vi.mocked(currentRecipeEffect).mockReset())

  it('that fails (an invalid recipe) stops the pass at the recipe, with its message', async () => {
    vi.mocked(currentRecipeEffect).mockReturnValue(Effect.fail(new Error('recipe.yml: steps.build is not a list')))
    const { result, did } = await pass()
    expect(result).toMatchObject({
      ok: false,
      ticketId: null,
      stage: 'recipe',
      detail: 'recipe.yml: steps.build is not a list',
    })
    expect(did).toEqual([])
  })

  it('that dies (a defect) stops the pass at the recipe too, with its message', async () => {
    vi.mocked(currentRecipeEffect).mockReturnValue(Effect.die(new Error('the read blew up')))
    const { result, did } = await pass()
    expect(result).toMatchObject({ ok: false, ticketId: null, stage: 'recipe', detail: 'the read blew up' })
    expect(did).toEqual([])
  })
})
