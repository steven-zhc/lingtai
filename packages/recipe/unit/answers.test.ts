/**
 * `landingChanges`, `refusalFixesChange`, `wallChange` and `budgetChange` (#399) —
 * the pure half of `apps/cli/src/landing.ts`'s writes, turning an answer into
 * `RecipeChange[]`. `packages/conductor/unit/conduct-a-whole-attempt.test.ts`
 * imports the same builder to pin that what it writes actually holds or
 * lands a pass; this file is about the shape of the change set alone.
 */
import { describe, expect, it } from 'vitest'

import {
  budgetChange,
  findingsJudgeChanges,
  followWriterJudgeChanges,
  kindsChanges,
  landingChanges,
  conflictResolutionsChange,
  refusalFixesChange,
  ticketsChange,
  wallChange,
} from '../src/answers.ts'

const HOLD = { name: 'hold every attempt', human: "Land this? The setup was answered 'hold'." }
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

  it('a branch sets branch.main and removes a hand-written hold', () => {
    expect(landingChanges({ land: 'release' }, [HAND_WRITTEN_HOLD])).toEqual([
      { path: ['branch', 'main'], value: 'release' },
      { path: ['steps', 'proposed'], value: [] },
    ])
  })

  it('a branch removes the hold beside a judge, and keeps the judge', () => {
    expect(landingChanges({ land: 'release' }, [JUDGE, HOLD])).toEqual([
      { path: ['branch', 'main'], value: 'release' },
      { path: ['steps', 'proposed'], value: [JUDGE] },
    ])
  })

  it('a branch with no hold to remove writes only branch.main', () => {
    expect(landingChanges({ land: 'release' }, [JUDGE])).toEqual([{ path: ['branch', 'main'], value: 'release' }])
    expect(landingChanges({ land: 'release' }, null)).toEqual([{ path: ['branch', 'main'], value: 'release' }])
  })

  it('a branch beside a hand-written hold still removes the hold at proposed', () => {
    expect(landingChanges({ land: 'develop' }, [HAND_WRITTEN_HOLD])).toEqual([
      { path: ['branch', 'main'], value: 'develop' },
      { path: ['steps', 'proposed'], value: [] },
    ])
  })
})

describe('the limits', () => {
  it('refusalFixesChange writes runtime.limits.attempt.refusalFixes', () => {
    expect(refusalFixesChange(0)).toEqual({ path: ['runtime', 'limits', 'attempt', 'refusalFixes'], value: 0 })
  })

  it('conflictResolutionsChange writes runtime.limits.attempt.conflictResolutions', () => {
    expect(conflictResolutionsChange(3)).toEqual({
      path: ['runtime', 'limits', 'attempt', 'conflictResolutions'],
      value: 3,
    })
  })

  it('wallChange writes runtime.limits.run.wall', () => {
    expect(wallChange('30m')).toEqual({ path: ['runtime', 'limits', 'run', 'wall'], value: '30m' })
  })

  it('budgetChange writes runtime.limits.run.usd, never runtime.budget', () => {
    expect(budgetChange(4)).toEqual({ path: ['runtime', 'limits', 'run', 'usd'], value: 4 })
  })

  it('budgetChange(null) removes runtime.limits.run.usd', () => {
    expect(budgetChange(null)).toEqual({ path: ['runtime', 'limits', 'run', 'usd'], value: undefined })
  })
})

describe('ticketsChange', () => {
  it('writes source.tickets', () => {
    expect(ticketsChange('db')).toEqual({ path: ['source', 'tickets'], value: 'db' })
    expect(ticketsChange('github')).toEqual({ path: ['source', 'tickets'], value: 'github' })
  })
})

describe('kindsChanges', () => {
  it('writes source.kinds when steps.claim declares no queue:', () => {
    expect(kindsChanges(['bug', 'feature'], null)).toEqual([{ path: ['source', 'kinds'], value: ['bug', 'feature'] }])
    expect(kindsChanges(['bug'], [{ name: 'take one', run: 'echo hi' }])).toEqual([
      { path: ['source', 'kinds'], value: ['bug'] },
    ])
  })

  it('rewrites queue.kinds in place when claim declares one, and leaves other entries and fields untouched', () => {
    const TAKE = { name: 'take one', queue: { kinds: ['bug'], exclude: ['agent:hold'] } }
    const OTHER = { name: 'something else', run: 'echo hi' }
    expect(kindsChanges(['feature', 'bug'], [OTHER, TAKE])).toEqual([
      {
        path: ['steps', 'claim'],
        value: [OTHER, { name: 'take one', queue: { kinds: ['feature', 'bug'], exclude: ['agent:hold'] } }],
      },
    ])
  })

  it('the order comes out as given', () => {
    expect(kindsChanges(['documentation', 'bug', 'feature'], null)).toEqual([
      { path: ['source', 'kinds'], value: ['documentation', 'bug', 'feature'] },
    ])
  })
})

describe('findingsJudgeChanges (#1448)', () => {
  const judge = { name: 'send findings back to the writer', judge: 'codex', when: 'findings' }
  it('appends the writer as the findings judge, after a hold', () => {
    const hold = { name: 'hold every attempt', human: 'x' }
    expect(findingsJudgeChanges('codex', [hold])).toEqual([{ path: ['steps', 'proposed'], value: [hold, judge] }])
    expect(findingsJudgeChanges('codex', null)).toEqual([{ path: ['steps', 'proposed'], value: [judge] }])
  })
  it('writes nothing for no writer, an implement-only writer, or a judge already there', () => {
    expect(findingsJudgeChanges(null, [])).toEqual([])
    expect(findingsJudgeChanges('copilot', [])).toEqual([])
    expect(findingsJudgeChanges('codex', [judge])).toEqual([])
  })
})

describe('followWriterJudgeChanges (#1523)', () => {
  const judge = (who: string) => ({ name: 'send findings back to the writer', judge: who, when: 'findings' })

  it('appends a judge naming the new writer where the recipe has none', () => {
    expect(followWriterJudgeChanges('codex', 'claude-code', [])).toEqual([
      { path: ['steps', 'proposed'], value: [judge('claude-code')] },
    ])
  })

  it('rewrites a judge that names the old writer', () => {
    expect(followWriterJudgeChanges('codex', 'claude-code', [judge('codex')])).toEqual([
      { path: ['steps', 'proposed', 0, 'judge'], value: 'claude-code' },
    ])
  })

  it('removes the judge when the new writer runs only at implement', () => {
    const hold = { name: 'hold', human: 'x' }
    expect(followWriterJudgeChanges('codex', 'copilot', [hold, judge('codex')])).toEqual([
      { path: ['steps', 'proposed'], value: [hold] },
    ])
  })

  it('writes nothing for an unchanged writer, nor for a judge a person pointed at another runtime', () => {
    expect(followWriterJudgeChanges('codex', 'codex', [judge('codex')])).toEqual([])
    expect(followWriterJudgeChanges('codex', 'claude-code', [judge('claude-code')])).toEqual([])
  })

  it('does not restore a judge an operator removed while the writer is unchanged', () => {
    expect(followWriterJudgeChanges('codex', 'codex', [])).toEqual([])
  })

  it('writes no judge for a writer that cannot judge', () => {
    expect(followWriterJudgeChanges('codex', 'copilot', [])).toEqual([])
  })
})
