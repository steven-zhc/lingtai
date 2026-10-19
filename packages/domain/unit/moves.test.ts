/**
 * `doc/design/the-waiting-lane.md`'s table, read back as tests: one `it` per
 * row of that table, for `allowedMoves`.
 */
import { describe, expect, it } from 'vitest'

import { Hold } from '../src/hold.ts'
import { allowedMoves } from '../src/moves.ts'

const run = { runId: 'pass-1' }
const unpushedRun = { runId: 'pass-1', unpushed: { branch: 'agent/run-1', said: 'nothing to push' } }

// Populated by `parseHold` below, so "every Hold tag is covered above" checks
// the tags the describe below actually exercised — never a literal that
// could drift from them, and never passing on an updated literal nobody
// wrote an `it` for.
const allowedMovesTags = new Set<string>()

function parseHold(input: unknown, exercised: Set<string>): Hold {
  const hold = Hold.parse(input)
  exercised.add(hold._tag)
  return hold
}

describe('allowedMoves', () => {
  const parse = (input: unknown) => parseHold(input, allowedMovesTags)

  it('Question: Requeue, Close, Answer', () => {
    const hold = parse({ _tag: 'Question', question: 'which design?', by: 'steven' })
    expect(allowedMoves(hold)).toEqual([{ _tag: 'Requeue' }, { _tag: 'Close' }, { _tag: 'Answer' }])
  })

  it('Judgement.Asked: Requeue, Close — never Approve', () => {
    const hold = parse({ _tag: 'Asked', run, step: 'implement', question: 'rename to X or Y?' })
    expect(allowedMoves(hold)).toEqual([{ _tag: 'Requeue' }, { _tag: 'Close' }])
  })

  it('Judgement.Human at proposed: Approve, Requeue, Close', () => {
    const hold = parse({ _tag: 'Human', run, step: 'proposed', source: 'declared', question: 'ship it?' })
    expect(allowedMoves(hold)).toEqual([{ _tag: 'Approve' }, { _tag: 'Requeue' }, { _tag: 'Close' }])
  })

  it('Judgement.Human at merge (injected by --no-merge): Approve, Requeue, Close', () => {
    const hold = parse({ _tag: 'Human', run, step: 'merge', source: 'injected', question: 'land it?' })
    expect(allowedMoves(hold)).toEqual([{ _tag: 'Approve' }, { _tag: 'Requeue' }, { _tag: 'Close' }])
  })

  it('Judgement.Declined: Approve, Requeue, BodyAndRequeue, Close', () => {
    const hold = parse({ _tag: 'Declined', run, step: 'implement', said: 'nothing here answers the finding' })
    expect(allowedMoves(hold)).toEqual([
      { _tag: 'Approve' },
      { _tag: 'Requeue' },
      { _tag: 'BodyAndRequeue' },
      { _tag: 'Close' },
    ])
  })

  it('Judgement.Routed: Requeue, Close, plus Approve when not unpushed', () => {
    const hold = parse({
      _tag: 'Routed',
      run,
      when: 'findings',
      why: 'the cold review found something',
      raw: null,
      findings: [],
      paths: null,
      baseSha: null,
      headSha: null,
    })
    expect(allowedMoves(hold)).toEqual([{ _tag: 'Approve' }, { _tag: 'Requeue' }, { _tag: 'Close' }])
  })

  it('Judgement.Routed: no Approve when unpushed', () => {
    const hold = parse({
      _tag: 'Routed',
      run: unpushedRun,
      when: 'findings',
      why: 'the cold review found something',
      raw: null,
      findings: [],
      paths: null,
      baseSha: null,
      headSha: null,
    })
    expect(allowedMoves(hold)).toEqual([{ _tag: 'Requeue' }, { _tag: 'Close' }])
  })

  it('Failure.MergeRefused (the pass producer, hold-of.ts): Requeue, Close, plus Approve when not unpushed', () => {
    const hold = parse({
      _tag: 'MergeRefused',
      run,
      reason: 'conflict',
      why: 'apps/web/foo.ts conflicts',
      paths: ['apps/web/foo.ts'],
      baseSha: 'abc',
      headSha: 'def',
      raw: 'CONFLICT ...',
      afterApproval: false,
    })
    expect(allowedMoves(hold)).toEqual([{ _tag: 'Approve' }, { _tag: 'Requeue' }, { _tag: 'Close' }])
  })

  it('Failure.MergeRefused (the pass producer): no Approve when unpushed', () => {
    const hold = parse({
      _tag: 'MergeRefused',
      run: unpushedRun,
      reason: 'conflict',
      why: 'apps/web/foo.ts conflicts',
      paths: ['apps/web/foo.ts'],
      baseSha: 'abc',
      headSha: 'def',
      raw: 'CONFLICT ...',
      afterApproval: false,
    })
    expect(allowedMoves(hold)).toEqual([{ _tag: 'Requeue' }, { _tag: 'Close' }])
  })

  it('Failure.MergeRefused (the approval producer, approve.ts): no Approve — the approval is already spent', () => {
    const hold = parse({
      _tag: 'MergeRefused',
      run,
      reason: 'conflict',
      why: 'apps/web/foo.ts conflicts',
      paths: ['apps/web/foo.ts'],
      baseSha: 'abc',
      headSha: 'def',
      raw: 'CONFLICT ...',
      afterApproval: true,
    })
    expect(allowedMoves(hold)).toEqual([{ _tag: 'Requeue' }, { _tag: 'Close' }])
  })

  it('Failure.Ceiling: Requeue, Close — never Approve', () => {
    const hold = parse({
      _tag: 'Ceiling',
      run,
      kind: 'out-of-turns',
      detail: 'ran out of turns',
      turns: 150,
      costUsd: null,
    })
    expect(allowedMoves(hold)).toEqual([{ _tag: 'Requeue' }, { _tag: 'Close' }])
  })

  it('Failure.DidNotFinish: Requeue, Close — never Approve', () => {
    const hold = parse({ _tag: 'DidNotFinish', run, step: 'implement', why: 'the agent crashed', raw: null })
    expect(allowedMoves(hold)).toEqual([{ _tag: 'Requeue' }, { _tag: 'Close' }])
  })

  it('Failure.SetupRefused, lifts: by-itself: Requeue, Close', () => {
    const hold = parse({
      _tag: 'SetupRefused',
      run,
      step: 'prepared',
      lifts: 'by-itself',
      why: 'usage limit',
      raw: null,
    })
    expect(allowedMoves(hold)).toEqual([{ _tag: 'Requeue' }, { _tag: 'Close' }])
  })

  it('Failure.SetupRefused, lifts: person: Requeue, Close', () => {
    const hold = parse({
      _tag: 'SetupRefused',
      run,
      step: 'prepared',
      lifts: 'person',
      why: 'no runtime for this tier',
      raw: null,
    })
    expect(allowedMoves(hold)).toEqual([{ _tag: 'Requeue' }, { _tag: 'Close' }])
  })

  it('Failure.CheckRed: Requeue, Close, plus Approve when not unpushed', () => {
    const hold = parse({ _tag: 'CheckRed', run, step: 'build', why: 'pnpm test failed', raw: 'FAIL ...' })
    expect(allowedMoves(hold)).toEqual([{ _tag: 'Approve' }, { _tag: 'Requeue' }, { _tag: 'Close' }])
  })

  it('Failure.CheckRed: no Approve when unpushed', () => {
    const hold = parse({
      _tag: 'CheckRed',
      run: unpushedRun,
      step: 'build',
      why: 'pnpm test failed',
      raw: 'FAIL ...',
    })
    expect(allowedMoves(hold)).toEqual([{ _tag: 'Requeue' }, { _tag: 'Close' }])
  })

  it('every Hold tag is covered above', () => {
    const tags = Hold.options.map((option) => option.shape._tag.value)
    // Against `allowedMovesTags`, not a literal copy of this list: a `Hold`
    // tag added without a fixture in the describe above shows up here as a
    // tag `Hold.options` has and `allowedMovesTags` doesn't, so this goes red
    // rather than passing on an updated literal nobody wrote an `it` for.
    expect(new Set(tags)).toEqual(allowedMovesTags)
  })
})
