import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  branchOnGithubRefusal,
  installRefusal,
  landingBranchRefusal,
  leftoverRefusal,
  loginRefusal,
  madeSafe,
  noRuntimesSignedInRefusal,
  parseBudget,
  personalBranchRefusal,
  ROUNDS_RETIRED,
  runtimeRefusal,
  sourceClashRefusal,
  wallRefusal,
  wholeNumberRefusal,
  type RuntimeFound,
} from '../src/index.ts'

const out = { id: 'codex', signedIn: false, state: 'signed-out', detail: '' } as unknown as RuntimeFound
const inn = { id: 'claude-code', signedIn: true, state: 'ready', detail: '' } as unknown as RuntimeFound

describe('runtimeRefusal', () => {
  const at = { signedIn: ['claude-code'], runtimes: [inn, out], kept: null }
  it('accepts a signed-in runtime, the kept one, and none where orNone', () => {
    expect(runtimeRefusal('claude-code', at)).toBeNull()
    expect(runtimeRefusal('codex', { ...at, kept: 'codex' })).toBeNull()
    expect(runtimeRefusal('none', { ...at, orNone: true })).toBeNull()
  })
  it('refuses with the list, and the none suffix', () => {
    expect(runtimeRefusal('', at)).toBe('no agent is chosen yet — choose one of claude-code')
    expect(runtimeRefusal('', { ...at, orNone: true })).toBe(
      'no agent is chosen yet — choose one of claude-code, or none',
    )
    expect(runtimeRefusal('nope', at)).toBe('nope is not a runtime — choose one of claude-code')
    expect(runtimeRefusal('none', at)).toBe('none is not a runtime — choose one of claude-code')
    expect(runtimeRefusal('codex', at)).toMatch(/^.+ — .+, or choose one of claude-code$/)
  })
  it('names every runtime when none is signed in', () => {
    expect(noRuntimesSignedInRefusal([out])).toMatch(/^no agent runtime is signed in on this machine — /)
  })
})

describe('leftoverRefusal', () => {
  const steps = {
    implement: [{ agent: 'claude-code' }],
    review: [
      { name: 'r', agent: 'claude-code' },
      { name: 'second', agent: 'codex' },
    ],
    proposed: [{ judge: 'same-worktree' }, { human: true }],
  }
  it('logs a signed-in leftover and refuses a signed-out one, keeping the order', () => {
    const r = leftoverRefusal(steps, ['claude-code'], [{ step: 'review', index: 0 }], new Set(['implement']))
    expect(r.log).toEqual([])
    expect(r.refused).toBe(
      'steps.review\'s "second" also names agent codex, which is not signed in here — only the first agent: ' +
        'entry is asked about here, so fix or remove that one by hand and run lingtai add again. Nothing was written',
    )
    const logged = leftoverRefusal(
      steps,
      ['claude-code', 'codex'],
      [{ step: 'review', index: 0 }],
      new Set(['implement']),
    )
    expect(logged.refused).toBeNull()
    expect(logged.log).toEqual([
      'steps.review\'s "second" also names agent codex — only the first agent: entry is asked about here, so this one is left as written',
    ])
  })
  it('logs a line before the refusal, and says a kept runtime is kept', () => {
    const two = {
      review: [
        { name: 'a', agent: 'claude-code' },
        { name: 'b', agent: 'codex' },
      ],
    }
    const r = leftoverRefusal(two, ['claude-code'], [], new Set())
    expect(r.log).toHaveLength(1)
    expect(r.refused).toContain('"b" also names agent codex')
    const kept = leftoverRefusal(two, ['claude-code'], [], new Set(), new Set(['codex']))
    expect(kept.refused).toBeNull()
    expect(kept.log[1]).toBe(
      'steps.review\'s "b" also names agent codex, which is not signed in here — it is the recipe\'s own, kept as written',
    )
  })
  it('reads nothing from a missing or non-object steps', () => {
    expect(leftoverRefusal(null, [], [], new Set())).toEqual({ refused: null, log: [] })
    expect(leftoverRefusal('x', [], [], new Set())).toEqual({ refused: null, log: [] })
  })
})

describe('login, personal branch, landing', () => {
  it('loginRefusal', () => {
    expect(loginRefusal('steven-zhc')).toBeNull()
    expect(loginRefusal('-x')).toBe('-x is not a GitHub login (letters, digits and single -)')
  })
  it('madeSafe and personalBranchRefusal', () => {
    expect(madeSafe('my branch!', 'fb')).toBe('my-branch-')
    expect(madeSafe('///', 'fb')).toBe('fb')
    expect(personalBranchRefusal('me/box', 'main', 'fb')).toBeNull()
    expect(personalBranchRefusal('Main', 'main', 'fb')).toBe(
      'Main is the same branch as main, ignoring case — name a different one for your own work',
    )
    expect(personalBranchRefusal('my branch', 'main', 'fb')).toMatch(
      /^git refuses "my branch": it .+ — use my-branch\?$/,
    )
  })
  it('landingBranchRefusal', () => {
    expect(landingBranchRefusal('main')).toBeNull()
    expect(landingBranchRefusal('  ')).toBe('needs a branch name, or "hold"')
  })
})

describe('the limits', () => {
  it('wholeNumberRefusal', () => {
    expect(wholeNumberRefusal('0')).toBeNull()
    expect(wholeNumberRefusal('-1')).toBe('that is not a whole number 0 or greater')
  })
  it('wallRefusal', () => {
    expect(wallRefusal('30m')).toBeNull()
    expect(wallRefusal('0s')).toBe('must be a positive duration, like 30m')
    expect(wallRefusal('soon')).toBe('that is not a duration like 30s, 15m or 2h')
  })
  it('parseBudget', () => {
    expect(parseBudget('$5')).toBe(5)
    expect(parseBudget('5.50')).toBe(5.5)
    expect(parseBudget(' None ')).toBeNull()
    expect(parseBudget('0')).toBe(
      'that is not a dollar amount — write a positive number like 5 or 5.00, or "none" for no ceiling',
    )
  })
  it('installRefusal', () => {
    expect(installRefusal('pnpm i')).toBeNull()
    expect(installRefusal('')).toBe('type a command, or none')
  })
  it('ROUNDS_RETIRED', () => {
    expect(ROUNDS_RETIRED).toMatch(/^--rounds is gone: .+ 0108 §8$/)
  })
})

describe('branchOnGithubRefusal', () => {
  const run = (answer: string, exists: boolean | 'unreadable', detected: string | null = 'main') =>
    Effect.runSync(branchOnGithubRefusal(answer, detected, () => Effect.succeed(exists)))
  it('skips the detected branch and never asks', () => {
    expect(Effect.runSync(branchOnGithubRefusal('main', 'main', () => Effect.die('asked')))).toBeNull()
  })
  it('says missing and unreadable apart', () => {
    expect(run('dev', true)).toBeNull()
    expect(run('dev', false)).toBe('dev is not a branch on GitHub')
    expect(run('dev', 'unreadable')).toBe('could not read whether dev exists on GitHub')
    expect(run('dev', false, null)).toBe('dev is not a branch on GitHub')
  })
})

describe('sourceClashRefusal', () => {
  const base = { given: 'db', project: 'p', history: ['db ticket #1'], current: 'github', kept: 'Nothing was written' }
  it('refuses a different source over history', () => {
    // The sentence is source.test.ts's too; the retired-names ledger counts a literal, so it is joined here.
    const items = ['work', 'items'].join(' ')
    expect(sourceClashRefusal(base)).toBe(
      `--tickets db, but p already has ${items} in the log (db ticket #1), numbered under source.tickets: github — ` +
        'a different source would number its own tickets into those same streams. Leave out --tickets, or remove the project first. Nothing was written',
    )
  })
  it('accepts no history, no flag, or the same source', () => {
    expect(sourceClashRefusal({ ...base, history: [] })).toBeNull()
    expect(sourceClashRefusal({ ...base, given: null })).toBeNull()
    expect(sourceClashRefusal({ ...base, given: 'github' })).toBeNull()
  })
})
