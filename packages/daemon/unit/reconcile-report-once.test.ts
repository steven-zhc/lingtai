/**
 * An orphan with no `RunStarted` is appended to `Reconciled` once (#925, 0111 §11). Unit, by 0060 §1: a memory log,
 * and findings built by hand — the test asserts on `stream` and `once`, never on the sentence.
 */
import { parsePayload } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { CONTROL_STREAM } from '../src/control.ts'
import { type Finding, unreported, withoutReported } from '../src/reconcile.ts'

const mystery = (stream: string, actual: string): Finding => ({
  stream,
  expected: 'e',
  actual,
  action: 'reported',
  path: `/p/${actual}`,
  once: true,
})
const lag = (stream: string, actual: string): Finding => ({
  stream,
  expected: 'e',
  actual,
  action: 'reported',
  path: '',
})

async function seeded(findings: Finding[]) {
  const store = createMemoryEventStore()
  await store.append(CONTROL_STREAM, 0, [
    {
      type: 'Reconciled',
      actor: 'conductor',
      data: parsePayload('Reconciled', {
        findings: findings.map((f) => ({ stream: f.stream, expected: f.expected, actual: f.actual, action: f.action })),
      }),
    },
  ])
  return store
}

describe('unreported', () => {
  it('drops a once finding an earlier Reconciled reported, and keeps what differs', async () => {
    const earlier = await (await seeded([mystery('r1', 'a')])).readTypes(CONTROL_STREAM, ['Reconciled'])
    const kept = unreported([mystery('r1', 'a'), mystery('r2', 'a'), mystery('r1', 'b')], earlier)
    expect(kept.map((f) => `${f.stream}/${f.actual}`)).toEqual(['r2/a', 'r1/b'])
  })

  it('keeps it when the earlier finding was removed, or when the read failed', async () => {
    const removed = { ...mystery('r1', 'a'), action: 'removed' as const }
    const earlier = await (await seeded([removed])).readTypes(CONTROL_STREAM, ['Reconciled'])
    expect(unreported([mystery('r1', 'a')], earlier)).toHaveLength(1)
    expect(unreported([mystery('r1', 'a')], null)).toHaveLength(1)
  })

  it('never drops a finding without once, even with identical text earlier', async () => {
    const earlier = await (await seeded([lag('p', 'behind')])).readTypes(CONTROL_STREAM, ['Reconciled'])
    expect(unreported([lag('p', 'behind')], earlier)).toHaveLength(1)
  })

  it('keeps the worktree and the log of one run id as two findings', async () => {
    const earlier = await (await seeded([mystery('r1', 'worktree')])).readTypes(CONTROL_STREAM, ['Reconciled'])
    const kept = unreported([mystery('r1', 'worktree'), mystery('r1', 'log')], earlier)
    expect(kept.map((f) => f.actual)).toEqual(['log'])
  })
})

describe('withoutReported', () => {
  it('returns nothing when everything was already reported, and says how many', async () => {
    const store = await seeded([mystery('r1', 'a')])
    const lines: string[] = []
    expect(await withoutReported(store, [mystery('r1', 'a')], (l) => lines.push(l))).toEqual([])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('1 orphan(s) already reported')
  })

  it('suppresses nothing and says so when the read throws', async () => {
    const store = {
      readTypes: async () => {
        throw new Error('store down')
      },
    }
    const lines: string[] = []
    const found = [mystery('r1', 'a')]
    expect(await withoutReported(store, found, (l) => lines.push(l))).toEqual(found)
    expect(lines).toEqual([expect.stringContaining('could not read earlier Reconciled: store down')])
  })
})
