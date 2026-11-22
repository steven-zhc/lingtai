/**
 * Which step a `BranchSynced` records (#1352): a clean merge is the build's, a conflict's resolution is the sync step's own, and
 * a resolution made once `sync` is recorded — an agent amending a merge that built red — is the build's, so the next serve does
 * not build the old merge again.
 */
import { describe, expect, it } from 'vitest'

import { emptyPr, syncedStep, syncedTransition } from '../src/pr.ts'
import type { PrState } from '../src/pr.ts'

const walking: PrState = { ...emptyPr, status: 'in-progress' }
const synced: PrState = { ...walking, steps: [{ step: 'sync', headSha: 'a'.repeat(40) }] }

describe('syncedStep', () => {
  it('records a clean merge at build, and a resolution at sync while sync is not yet recorded', () => {
    expect(syncedStep(walking, 'clean')).toBe('build')
    expect(syncedStep(walking, 'resolved')).toBe('sync')
    expect(syncedStep(walking, 'already')).toBe('sync')
  })

  it('records a resolution at build once sync is recorded, and a second one appends nothing', () => {
    expect(syncedStep(synced, 'resolved')).toBe('build')
    const data = { mainCommit: 'b'.repeat(40), head: 'c'.repeat(40), how: 'resolved' } as const
    expect(syncedTransition(synced, data)).not.toBeNull()
    const built: PrState = { ...synced, steps: [...synced.steps, { step: 'build', headSha: data.head }] }
    expect(syncedTransition(built, data)).toBeNull()
  })
})
