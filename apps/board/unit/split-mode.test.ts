import type { SplitProgress } from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

import { splitModeOf } from '../src/lib/split-mode.ts'

const plan = { children: [], blockedBy: [] }
const at = (state: 'writing' | 'failed' | 'interrupted' | 'done'): SplitProgress => ({
  state,
  plan,
  children: [],
  links: [],
})

describe('splitModeOf', () => {
  it('is editable with Create all before the first click', () => {
    expect(splitModeOf({ state: 'idle' }, 'github')).toEqual({
      editable: true,
      locked: false,
      button: 'create',
      unavailable: false,
    })
  })

  it('shows the plan and says splitting is not available where tickets are in the database', () => {
    expect(splitModeOf({ state: 'idle' }, 'db')).toMatchObject({ editable: false, button: null, unavailable: true })
  })

  it('is locked, with no button, exactly while the log says writing', () => {
    expect(splitModeOf(at('writing'), 'github')).toEqual({
      editable: false,
      locked: true,
      button: null,
      unavailable: false,
    })
    for (const state of ['failed', 'interrupted', 'done'] as const)
      expect(splitModeOf(at(state), 'github').locked).toBe(false)
  })

  it('offers Retry on failed and interrupted, and never makes the plan editable again', () => {
    for (const state of ['failed', 'interrupted'] as const)
      expect(splitModeOf(at(state), 'github')).toMatchObject({ editable: false, button: 'retry' })
  })
})
