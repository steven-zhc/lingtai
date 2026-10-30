import type { BlockDiagnosis } from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

import { describeWaitLines } from '../src/task-view.js'

const diagnosis = (over: Partial<BlockDiagnosis> = {}): BlockDiagnosis =>
  ({
    what: 'the branch does not merge',
    done: null,
    raw: 'CONFLICT',
    recommendation: { action: 'requeue', why: 'develop has moved' },
    ...over,
  }) as BlockDiagnosis

describe('describeWaitLines', () => {
  it('says only what was diagnosed, never who is needed', () => {
    for (const d of [diagnosis(), diagnosis({ done: 'two rounds ran' })]) {
      const text = describeWaitLines({ diagnosis: d }).map((l) => l.text)
      for (const t of text) {
        expect(t).not.toContain('judgement is needed')
        expect(t).not.toContain('needs acknowledging')
      }
    }
  })

  it('returns what, did, rec in that order, and skips did when null', () => {
    expect(describeWaitLines({ diagnosis: diagnosis({ done: 'x' }) }).map((l) => l.part)).toEqual([
      'what',
      'did',
      'rec',
    ])
    expect(describeWaitLines({ diagnosis: diagnosis() }).map((l) => l.part)).toEqual(['what', 'rec'])
  })

  it('is empty for a null diagnosis', () => {
    expect(describeWaitLines({ diagnosis: null })).toEqual([])
  })
})
