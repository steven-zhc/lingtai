/**
 * `PipelineOptions.waived` (#465, 0120 §6): the first action in the step's
 * list carrying each waived name is never called, its result is
 * `Waived{waitId}`, and everything else in the step runs as it would have.
 *
 * **A list, since this file's own blocker finding**: two actions that each
 * stop the pass on their own have to clear together, once each has its own
 * approval, or a continuation that remembers only the latest loops between
 * them forever.
 */
import { describe, expect, it } from 'vitest'

import { runActionPipeline, type Action, type ActionContext, type ActionResult } from '../src/action.ts'

const context: ActionContext = { runId: 'pass-abc', onSha: 'a'.repeat(40), cwd: '/tmp/wt', env: {} }

function recordingAction(name: string, calls: string[], result: ActionResult): Action {
  return {
    name,
    kind: 'run',
    yields: 'verdict',
    run: async () => {
      calls.push(name)
      return result
    },
  }
}

const PASSED: ActionResult = { verdict: 'passed', evidence: 'ok', findings: [] }
const FAILED: ActionResult = { verdict: 'failed', evidence: 'refused', findings: [] }

describe('runActionPipeline with a waiver', () => {
  it('never calls the named action, and marks it waived', async () => {
    const calls: string[] = []
    const result = await runActionPipeline({
      step: 'merge',
      actions: [recordingAction('human:land', calls, FAILED)],
      context,
      emit: () => {},
      waived: [{ name: 'human:land', waitId: 'wait-1' as never }],
    })
    expect(calls).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.results).toEqual([
      { action: 'human:land', verdict: 'waived', evidence: '', findings: [], waitId: 'wait-1' },
    ])
  })

  it('runs every other action in the step, before and after the waived one', async () => {
    const calls: string[] = []
    const result = await runActionPipeline({
      step: 'merge',
      actions: [
        recordingAction('run:pnpm-test', calls, PASSED),
        recordingAction('human:land', calls, FAILED),
        recordingAction('merge:lane', calls, { verdict: 'passed', evidence: 'merged', findings: [], merged: 'sha-2' }),
      ],
      context,
      emit: () => {},
      waived: [{ name: 'human:land', waitId: 'wait-1' as never }],
    })
    expect(calls).toEqual(['run:pnpm-test', 'merge:lane'])
    expect(result.ok).toBe(true)
    expect(result.results.map((r) => ({ action: r.action, verdict: r.verdict }))).toEqual([
      { action: 'run:pnpm-test', verdict: 'passed' },
      { action: 'human:land', verdict: 'waived' },
      { action: 'merge:lane', verdict: 'passed' },
    ])
  })

  it('waives only the first action with that name — a second entry under the same name still runs', async () => {
    const calls: string[] = []
    const result = await runActionPipeline({
      step: 'merge',
      actions: [recordingAction('watch:ci', calls, PASSED), recordingAction('watch:ci', calls, PASSED)],
      context,
      emit: () => {},
      waived: [{ name: 'watch:ci', waitId: 'wait-1' as never }],
    })
    expect(calls).toEqual(['watch:ci'])
    expect(result.results.map((r) => r.verdict)).toEqual(['waived', 'passed'])
  })

  it('an unmatched waiver name changes nothing', async () => {
    const calls: string[] = []
    const result = await runActionPipeline({
      step: 'merge',
      actions: [recordingAction('run:pnpm-test', calls, PASSED)],
      context,
      emit: () => {},
      waived: [{ name: 'human:land', waitId: 'wait-1' as never }],
    })
    expect(calls).toEqual(['run:pnpm-test'])
    expect(result.results[0]?.verdict).toBe('passed')
  })

  /**
   * **The blocker finding itself, at the pipeline's own layer**: two actions
   * that each stop the pass, each with its own approval, clear together in
   * one visit rather than one at a time.
   */
  it('waives two actions at once, each by its own waiver — the step clears in one visit', async () => {
    const calls: string[] = []
    const result = await runActionPipeline({
      step: 'proposed',
      actions: [recordingAction('tamper', calls, FAILED), recordingAction('approval', calls, FAILED)],
      context,
      emit: () => {},
      waived: [
        { name: 'tamper', waitId: 'wait-1' as never },
        { name: 'approval', waitId: 'wait-2' as never },
      ],
    })
    expect(calls).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.results).toEqual([
      { action: 'tamper', verdict: 'waived', evidence: '', findings: [], waitId: 'wait-1' },
      { action: 'approval', verdict: 'waived', evidence: '', findings: [], waitId: 'wait-2' },
    ])
  })
})
