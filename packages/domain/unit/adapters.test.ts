/**
 * `#487`'s writer-side adapters, each against the literal payload
 * `approve.ts` built by hand before this file existed — `waiverOf` and
 * `approvalOf` from `approve.ts:309-329`'s own append, `approvedMergeRefusedOf`
 * from `approve.ts:394-405`. Nothing else in the unit half reaches a success
 * through `approveHolding` (`wait-handlers-answer-as-today.test.ts`'s own
 * pins all stop at a refusal), so these are the only assertions on the
 * waiver, the grant and the approved-merge refusal's own shape.
 */
import { describe, expect, it } from 'vitest'

import { approvalOf, approvedMergeRefusedOf, waiverOf } from '../src/adapters.ts'

describe('waiverOf', () => {
  it('writes StepWaived for the gate named, with the approval as its reason', () => {
    const result = waiverOf({
      step: 'build',
      action: 'test',
      runId: 'pass-1',
      onSha: 'a'.repeat(40),
      by: 'human:steven',
      reason: 'flaky, waiving',
    })
    expect(result).toEqual({
      type: 'StepWaived',
      data: {
        step: 'build',
        action: 'test',
        runId: 'pass-1',
        onSha: 'a'.repeat(40),
        by: 'human:steven',
        reason: 'flaky, waiving',
      },
    })
  })
})

describe('approvalOf', () => {
  it('waives every refusing gate before granting the approval, in that order', () => {
    const result = approvalOf({
      refusing: [
        { step: 'build', action: 'install' },
        { step: 'build', action: 'test' },
      ],
      step: 'proposed',
      action: 'unfixed',
      runId: 'pass-2',
      onSha: 'b'.repeat(40),
      by: 'human:steven',
      note: 'waiving the known flake',
    })
    expect(result).toEqual([
      {
        type: 'StepWaived',
        data: {
          step: 'build',
          action: 'install',
          runId: 'pass-2',
          onSha: 'b'.repeat(40),
          by: 'human:steven',
          reason: 'waiving the known flake',
        },
      },
      {
        type: 'StepWaived',
        data: {
          step: 'build',
          action: 'test',
          runId: 'pass-2',
          onSha: 'b'.repeat(40),
          by: 'human:steven',
          reason: 'waiving the known flake',
        },
      },
      {
        type: 'ApprovalGranted',
        data: {
          step: 'proposed',
          action: 'unfixed',
          runId: 'pass-2',
          onSha: 'b'.repeat(40),
          by: 'human:steven',
          note: 'waiving the known flake',
        },
      },
    ])
  })

  it('grants the approval alone when nothing is refusing', () => {
    const result = approvalOf({
      refusing: [],
      step: 'proposed',
      action: 'unfixed',
      runId: 'pass-3',
      onSha: 'c'.repeat(40),
      by: 'human:steven',
      note: '',
    })
    expect(result).toEqual([
      {
        type: 'ApprovalGranted',
        data: {
          step: 'proposed',
          action: 'unfixed',
          runId: 'pass-3',
          onSha: 'c'.repeat(40),
          by: 'human:steven',
          note: '',
        },
      },
    ])
  })
})

describe('approvedMergeRefusedOf', () => {
  it('builds the Hold approve.ts wrote by hand, afterApproval: true, and the question beside it', () => {
    const { event, question } = approvedMergeRefusedOf({
      runId: 'pass-4',
      reason: 'dirty-base',
      raw: 'main not clean',
      branch: 'agent/4',
      base: 'main',
      paths: null,
      baseSha: null,
      headSha: null,
    })
    expect(event).toEqual({
      type: 'WorkItemBlocked',
      data: {
        hold: {
          _tag: 'MergeRefused',
          run: { runId: 'pass-4' },
          afterApproval: true,
          reason: 'dirty-base',
          why: "Lingtai's own checkout of main was not clean, so the merge was refused. Nothing is wrong with agent/4.",
          raw: 'main not clean',
          paths: null,
          baseSha: null,
          headSha: null,
        },
      },
    })
    expect(question).toBe('dirty-base: main not clean')
  })

  it('carries the integration refusal evidence through to paths/baseSha/headSha', () => {
    const { event } = approvedMergeRefusedOf({
      runId: 'pass-5',
      reason: 'conflict',
      raw: 'CONFLICT (content): a.ts',
      branch: 'agent/5',
      base: 'main',
      paths: ['a.ts'],
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    })
    expect(event.data.hold).toMatchObject({
      paths: ['a.ts'],
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    })
  })
})
