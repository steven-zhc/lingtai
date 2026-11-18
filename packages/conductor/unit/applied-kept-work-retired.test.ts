/** #1244: no attempt carries another's work, so `RunAppliedKeptWork` is never appended again and is still read. */
import { RETIRED, parsePayload } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { expect, it } from 'vitest'

const data = {
  fromRunId: 'pass-1',
  arm: 'agent/7-attempt-1',
  sha: 'a'.repeat(40),
  parentSha: 'b'.repeat(40),
  applied: ['a.ts'],
  leftOut: [],
  unapplied: null,
}

it('RunAppliedKeptWork is retired: the payload still parses, and store.append refuses it', async () => {
  expect(RETIRED.has('RunAppliedKeptWork')).toBe(true)
  expect(parsePayload('RunAppliedKeptWork', data)).toMatchObject({ applied: ['a.ts'] })
  const store = createMemoryEventStore()
  await expect(store.append('pass-1', 0, [{ type: 'RunAppliedKeptWork', actor: 'conductor', data }])).rejects.toThrow()
})
