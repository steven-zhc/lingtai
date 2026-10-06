/**
 * `landingChanges`, `roundsChange`, `wallChange` and `budgetChange` (#399) —
 * the pure half of `apps/cli/src/landing.ts`'s writes, turning an answer into
 * `RecipeChange[]`. `packages/conductor/unit/conduct-a-whole-pass.test.ts`
 * imports the same builder to pin that what it writes actually holds or
 * lands a pass; this file is about the shape of the change set alone.
 */
import { describe, expect, it } from 'vitest'

import { budgetChange, landingChanges, roundsChange, wallChange } from '../src/answers.ts'

const HOLD = { name: 'hold every pass', human: "Land this? The setup was answered 'hold'." }
const HAND_WRITTEN_HOLD = { name: 'approval', human: 'Merge this? It is my own code.' }
const JUDGE = { name: 'the lines or the approach', judge: 'claude-code', when: 'findings' }

describe('landingChanges', () => {
  it('"hold" on a file with nothing at proposed appends the one entry', () => {
    expect(landingChanges({ land: 'hold' }, null)).toEqual([{ path: ['steps', 'proposed'], value: [HOLD] }])
  })

  it('"hold" never writes steps.merge', () => {
    const changes = landingChanges({ land: 'hold' }, null)
    expect(changes.some((c) => c.path[0] === 'merge' || c.path[1] === 'merge')).toBe(false)
  })

  it('"hold" beside a judge keeps it and appends the hold', () => {
    expect(landingChanges({ land: 'hold' }, [JUDGE])).toEqual([{ path: ['steps', 'proposed'], value: [JUDGE, HOLD] }])
  })

  it('"hold" where a human: is already there writes nothing', () => {
    expect(landingChanges({ land: 'hold' }, [HAND_WRITTEN_HOLD])).toEqual([])
    expect(landingChanges({ land: 'hold' }, [HOLD])).toEqual([])
  })

  it('a branch sets repo.base and removes a hand-written hold', () => {
    expect(landingChanges({ land: 'release' }, [HAND_WRITTEN_HOLD])).toEqual([
      { path: ['repo', 'base'], value: 'release' },
      { path: ['steps', 'proposed'], value: [] },
    ])
  })

  it('a branch removes the hold beside a judge, and keeps the judge', () => {
    expect(landingChanges({ land: 'release' }, [JUDGE, HOLD])).toEqual([
      { path: ['repo', 'base'], value: 'release' },
      { path: ['steps', 'proposed'], value: [JUDGE] },
    ])
  })

  it('a branch with no hold to remove writes only repo.base', () => {
    expect(landingChanges({ land: 'release' }, [JUDGE])).toEqual([{ path: ['repo', 'base'], value: 'release' }])
    expect(landingChanges({ land: 'release' }, null)).toEqual([{ path: ['repo', 'base'], value: 'release' }])
  })

  it("a branch writes steps.admit's worktree.base, not repo.base, when admit declares one", () => {
    const CUT_THE_TREE = { name: 'cut the tree', worktree: { base: 'main', submodules: false } }
    expect(landingChanges({ land: 'develop' }, null, [CUT_THE_TREE])).toEqual([
      {
        path: ['steps', 'admit'],
        value: [{ name: 'cut the tree', worktree: { base: 'develop', submodules: false } }],
      },
    ])
  })

  it('a branch beside a worktree admit still removes a hand-written hold at proposed', () => {
    const CUT_THE_TREE = { name: 'cut the tree', worktree: { base: 'main', submodules: false } }
    expect(landingChanges({ land: 'develop' }, [HAND_WRITTEN_HOLD], [CUT_THE_TREE])).toEqual([
      {
        path: ['steps', 'admit'],
        value: [{ name: 'cut the tree', worktree: { base: 'develop', submodules: false } }],
      },
      { path: ['steps', 'proposed'], value: [] },
    ])
  })
})

describe('the limits', () => {
  it('roundsChange writes runtime.limits.rounds', () => {
    expect(roundsChange(0)).toEqual({ path: ['runtime', 'limits', 'rounds'], value: 0 })
  })

  it('wallChange writes runtime.limits.wall', () => {
    expect(wallChange('30m')).toEqual({ path: ['runtime', 'limits', 'wall'], value: '30m' })
  })

  it('budgetChange writes runtime.limits.usd, never runtime.budget', () => {
    expect(budgetChange(4)).toEqual({ path: ['runtime', 'limits', 'usd'], value: 4 })
  })

  it('budgetChange(null) removes runtime.limits.usd', () => {
    expect(budgetChange(null)).toEqual({ path: ['runtime', 'limits', 'usd'], value: undefined })
  })
})
