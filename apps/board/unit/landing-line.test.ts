import { flakyClaim } from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

import { landingLineOf } from '../src/lib/landing-line.ts'
import type { StepVerdict } from '../src/lib/task.ts'

const v = (step: string, onSha: string | null, over: Partial<StepVerdict> = {}): StepVerdict => ({
  step,
  state: 'passed',
  stale: false,
  evidence: null,
  onSha,
  findings: [],
  ...over,
})
const HEAD = 'aaaaaaa1111'

describe('landingLineOf', () => {
  it('writes no sha where it equals the head', () => {
    const l = landingLineOf({ steps: [v('build:test', HEAD), v('review:x', HEAD)], headSha: HEAD, mergeCommit: 'm' })
    expect(l.items).toEqual([
      { step: 'build', ok: true, state: 'passed', onSha: null },
      { step: 'review', ok: true, state: 'passed', onSha: null },
    ])
  })
  it('writes a differing sha, and ignores steps before build', () => {
    const l = landingLineOf({
      steps: [v('implement:a', 'zzz'), v('build:test', HEAD), v('review:x', 'f3fa0b6')],
      headSha: HEAD,
      mergeCommit: 'm',
    })
    expect(l.items.map((i) => [i.step, i.onSha])).toEqual([
      ['build', null],
      ['review', 'f3fa0b6'],
    ])
  })
  it('counts flaky findings on build and names the tests', () => {
    const f = { file: '', line: null, claim: flakyClaim('a > b', 'pnpm test'), failureScenario: '', severity: 'minor' }
    const l = landingLineOf({ steps: [v('build:test', HEAD, { findings: [f] })], headSha: HEAD, mergeCommit: 'm' })
    expect(l.flaky).toEqual({ count: 1, tests: ['a > b'] })
  })
  it('shows a state word for a step that is not passed, and nothing for a missing step', () => {
    const l = landingLineOf({
      steps: [v('build:install', HEAD), v('build:test', HEAD, { state: 'failed' })],
      headSha: HEAD,
      mergeCommit: 'm',
    })
    expect(l.items).toEqual([{ step: 'build', ok: false, state: 'failed', onSha: null }])
  })
  it('a verdict with no onSha shows no sha; disagreeing actions show the one that differs', () => {
    expect(landingLineOf({ steps: [v('build:t', null)], headSha: HEAD, mergeCommit: 'm' }).items[0]!.onSha).toBeNull()
    const l = landingLineOf({ steps: [v('build:a', HEAD), v('build:b', 'bbbbbbb')], headSha: HEAD, mergeCommit: 'm' })
    expect(l.items[0]!.onSha).toBe('bbbbbbb')
  })
})
