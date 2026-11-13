/**
 * **The pass loop is the run's own fiber** (#1053): what `runAttemptEffect` does
 * with a defect and with an interruption. A defect in a step is a verdict
 * (*did-not-finish: threw*); an interruption is never one.
 *
 * Unit by 0060 §1: no timer, no process, no store but the array `emit` pushes to.
 */
import type { ActionContext, ActionPort, ActionResult } from '@lingtai/actions'
import { StepMap } from '@lingtai/recipe'
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import { NOT_BUILT_YET, runAttemptEffect, type AttemptEvent, type AttemptPortOptions } from '../src/run-attempt.ts'

const context: ActionContext = { runId: 'pass-1', onSha: 'abc1234def', cwd: '/nowhere', env: {} }
const recipe: AttemptPortOptions['recipe'] = { steps: StepMap.parse({}) }
const PASSED: ActionResult = { verdict: 'passed', evidence: 'green', findings: [] }

describe('the catch in a step', () => {
  it('ends the visit did-not-finish: threw when a body rejects', async () => {
    const result = await Effect.runPromise(
      runAttemptEffect({
        recipe,
        context,
        emit: () => Effect.void,
        actionsAt: () => [],
        bodies: {
          ...NOT_BUILT_YET,
          implement: () => Effect.die(new Error('the agent runtime raised')),
        },
      }),
    )
    expect(result.stopped).toMatchObject({
      step: 'implement',
      ending: {
        ending: 'did-not-finish',
        because: 'threw',
        detail: expect.stringContaining('the agent runtime raised'),
      },
    })
  })

  it('ends interrupted, with no StepEnded, when the pass is interrupted inside an action', async () => {
    const events: AttemptEvent[] = []
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const never = yield* Deferred.make<void>()
        const waiting: ActionPort = {
          name: 'wait forever',
          kind: 'run',
          yields: 'verdict',
          run: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(never)
              return PASSED
            }),
        }
        const fiber = yield* Effect.forkChild(
          runAttemptEffect({
            recipe,
            context,
            emit: (event) =>
              Effect.sync(() => {
                events.push(event)
              }),
            actionsAt: (step) => (step === 'admit' ? [waiting] : []),
          }),
        )
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }),
    )
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(events.map((e) => e.type)).toEqual(['StepStarted'])
  })
})
