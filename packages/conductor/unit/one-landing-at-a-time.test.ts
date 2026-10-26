/**
 * **Two passes reaching `merge` together land one after the other, and the
 * second re-checks on the moved base** (#639).
 *
 * Two `runPass` walks share one lane, as two passes in a conductor do. The fake
 * `land` answers like `integrate`: `base-moved` when main moved since this
 * pass's fork and the files overlap, otherwise it advances main. The route a
 * `base-moved` takes is #593's (`a-base-that-moved.test.ts`); this file claims
 * only that the lane puts the second landing behind the first.
 */
import type { Action, ActionContext, ActionResult } from '@lingtai/actions'
import { STEPS } from '@lingtai/domain'
import { StepMap } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'

import { createLandingLane } from '../src/landing-lane.ts'
import { runPass, type PassEvent, type StepBodies, type StepEnding } from '../src/pass.ts'

const PASSED: ActionResult = { verdict: 'passed', evidence: 'green', findings: [] }
const bodies = Object.fromEntries(
  STEPS.map((step) => [step, async (): Promise<StepEnding> => ({ ending: 'passed' })]),
) as unknown as StepBodies
const recipe = { steps: StepMap.parse({ merge: [{ name: 'land', merge: { strategy: 'merge-commit' } }] }) }

const latch = () => {
  let open!: () => void
  const promise = new Promise<void>((r) => (open = r))
  return { promise, open }
}

async function race(secondFiles: string[]) {
  const lane = createLandingLane()
  const origin = { main: 'm0', touched: new Set<string>() }
  const order: string[] = []
  const holdFirst = latch()
  const secondAtMerge = latch()

  const walk = (name: string, files: string[], hold?: Promise<void>, atMerge?: () => void) => {
    const fork = origin.main
    const events: PassEvent[] = []
    let visits = 0
    const land: Action = {
      name: 'land',
      kind: 'merge',
      yields: 'merge',
      run: async () => {
        visits++
        atMerge?.()
        return lane.through(
          'p:main',
          { runId: name, issue: name },
          { onWait: async () => void order.push(`${name}:wait`) },
          async (): Promise<ActionResult> => {
            order.push(`${name}:begin`)
            if (hold) await hold
            const moved = origin.main !== fork && files.some((f) => origin.touched.has(f))
            if (moved && visits === 1) {
              order.push(`${name}:base-moved`)
              return {
                verdict: 'failed',
                evidence: 'moved',
                findings: [],
                because: 'base-moved',
                baseMoved: { paths: files, fromSha: fork, toSha: origin.main },
              }
            }
            origin.main = `m-${name}`
            for (const f of files) origin.touched.add(f)
            order.push(`${name}:landed`)
            return { ...PASSED, merged: origin.main }
          },
        )
      },
    }
    const actionsAt = (step: string, actions: readonly { name: string }[]): Action[] => {
      if (step === 'merge') return [land]
      if (step === 'admit')
        return [{ name: 'cut', kind: 'worktree', yields: 'worktree', run: async (c) => ({ ...PASSED, head: c.onSha }) }]
      if (step === 'implement')
        return [{ name: 'w', kind: 'agent', yields: 'commit', run: async () => ({ ...PASSED, head: 'c0ffee0' }) }]
      return actions.map((a) => ({ name: a.name, kind: 'run', yields: 'verdict', run: async () => PASSED }) as Action)
    }
    const context: ActionContext = { runId: name, onSha: 'abc1234def', cwd: '/nowhere', env: {} }
    return runPass({
      recipe,
      context,
      emit: (e) => void events.push(e),
      bodies,
      actionsAt: actionsAt as never,
      ceilings: { rounds: 2, restarts: 0, restartsSpent: 0 },
      mergeBase: async (toSha) => ({ head: `merged-${toSha}` }),
    }).then((result) => ({ result, steps: events.flatMap((e) => (e.type === 'StepStarted' ? [e.data.step] : [])) }))
  }

  const first = walk('a', ['lib/x.ts'], holdFirst.promise)
  const second = walk('b', secondFiles, undefined, secondAtMerge.open)
  await secondAtMerge.promise
  holdFirst.open()
  const [a, b] = await Promise.all([first, second])
  return { order, a, b }
}

describe('two passes reaching merge together', () => {
  it('re-reviews the second when main moved under its files', async () => {
    const { order, b } = await race(['lib/x.ts'])
    expect(order.indexOf('b:begin')).toBeGreaterThan(order.indexOf('a:landed'))
    expect(order).toContain('b:base-moved')
    expect(b.steps.slice(b.steps.indexOf('merge'))).toEqual(['merge', 'build', 'review', 'proposed', 'merge'])
    expect(b.result.end).toMatchObject({ _tag: 'Landed' })
  })

  it('lands the second without a second build when the files are disjoint', async () => {
    const { order, b } = await race(['notes/y.md'])
    expect(order.indexOf('b:begin')).toBeGreaterThan(order.indexOf('a:landed'))
    expect(order).not.toContain('b:base-moved')
    expect(b.steps.filter((s) => s === 'build')).toHaveLength(1)
    expect(b.result.end).toMatchObject({ _tag: 'Landed' })
  })
})
