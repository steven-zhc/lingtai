/**
 * Reconcile's stream read answers `[]` when the chooser refuses (#1076).
 *
 * Unit, by 0060 §1: a memory log, and no store written down.
 */
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect, Exit } from 'effect'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { releaseForeignClaimsEffect } from '../src/reconcile.ts'

const KEY = 'LINGTAI_TEST_DATABASE_URL'
let saved: string | undefined

beforeEach(() => {
  saved = process.env[KEY]
  delete process.env[KEY]
})
afterEach(() => {
  if (saved === undefined) delete process.env[KEY]
  else process.env[KEY] = saved
})

it('answers [] when this machine wrote no choice', async () => {
  const exit = await Effect.runPromiseExit(
    releaseForeignClaimsEffect({ store: createMemoryEventStore(), projects: [{ project: 'p' }] } as never),
  )
  expect(Exit.isSuccess(exit) && exit.value).toEqual([])
})
