/**
 * The action pipeline and the small action kinds as Effects (#1041): the promise
 * shapes are faces over one Effect implementation, and the two failure routes
 * the faces must keep — a throwing action is a `failed` verdict, a rejecting
 * `emit` is an escape — survive the move.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

import { context, ROOT_CONTEXT, type Context, type ContextManager } from '@opentelemetry/api'
import { Effect } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  fromPromiseAction,
  promiseAction,
  runActionPipeline,
  runActionPipelineEffect,
  type Action,
  type ActionContext,
  type ActionPort,
  type ActionResult,
} from '../src/action.ts'
import { newSink, withSink } from '../src/spans.ts'
import { createWorktreeAction, makeWorktreeAction, type WorktreeActionDeps } from '../src/worktree-action.ts'

const ctx: ActionContext = { runId: 'pass-abc', onSha: 'a'.repeat(40), cwd: '/tmp/wt', env: {} }
const PASSED: ActionResult = { verdict: 'passed', evidence: 'ok', findings: [] }

const port = (name: string, run: () => Effect.Effect<ActionResult>): ActionPort => ({
  name,
  kind: 'run',
  yields: 'verdict',
  run,
})

describe('promiseAction and fromPromiseAction', () => {
  it('hands a factory-built action back as its own port', () => {
    const p = port('p', () => Effect.succeed(PASSED))
    expect(fromPromiseAction(promiseAction(p))).toBe(p)
  })

  it('copies name, kind and yields, and runs through the port', async () => {
    const p = port('p', () => Effect.succeed(PASSED))
    const a = promiseAction(p)
    expect([a.name, a.kind, a.yields]).toEqual(['p', 'run', 'verdict'])
    expect(await a.run(ctx)).toEqual(PASSED)
  })

  it('runs a hand-written action through its own run', async () => {
    let calls = 0
    const fake: Action = {
      name: 'fake',
      kind: 'run',
      yields: 'verdict',
      run: async () => {
        calls += 1
        return PASSED
      },
    }
    const lifted = fromPromiseAction(fake)
    expect(lifted).not.toBe(fake)
    expect(await Effect.runPromise(lifted.run(ctx))).toEqual(PASSED)
    expect(calls).toBe(1)
  })

  it('turns a hand-written action that throws synchronously into a failed verdict', async () => {
    const fake: Action = {
      name: 'sync',
      kind: 'run',
      yields: 'verdict',
      run: () => {
        throw new Error('sync boom')
      },
    }
    const result = await runActionPipeline({ step: 'build', actions: [fake], context: ctx, emit: () => {} })
    expect(result.results[0]).toMatchObject({ verdict: 'failed', evidence: 'the sync action threw: sync boom' })
  })
})

describe('runActionPipeline', () => {
  it('turns a rejecting dep into a failed verdict and skips what follows', async () => {
    const deps: WorktreeActionDeps = { cut: () => Promise.reject(new Error('boom')) }
    const after: Action = { name: 'after', kind: 'run', yields: 'verdict', run: async () => PASSED }
    const result = await runActionPipeline({
      step: 'admit',
      actions: [createWorktreeAction({ name: 'wt', base: 'main', submodules: false }, deps), after],
      context: ctx,
      emit: () => {},
    })
    expect(result.ok).toBe(false)
    expect(result.failedAt).toBe('wt')
    expect(result.results).toEqual([
      { action: 'wt', verdict: 'failed', evidence: 'the wt action threw: boom', findings: [] },
    ])
    expect(result.skipped).toEqual(['after'])
  })

  it('rejects with the very error an emit rejected with', async () => {
    const error = new Error('append refused')
    const spent: Action = {
      name: 'spends',
      kind: 'run',
      yields: 'verdict',
      run: async () => ({ ...PASSED, spent: { cost: 1 } as never }),
    }
    await expect(
      runActionPipeline({
        step: 'build',
        actions: [spent],
        context: ctx,
        emit: () => Promise.reject(error),
      }),
    ).rejects.toBe(error)
  })

  it('runs the same pipeline as an Effect, over ports', async () => {
    const result = await Effect.runPromise(
      runActionPipelineEffect({
        step: 'build',
        actions: [port('one', () => Effect.succeed(PASSED)), port('two', () => Effect.die(new Error('x')))],
        context: ctx,
        emit: () => {},
      }),
    )
    expect(result.failedAt).toBe('two')
    expect(result.results[1]!.evidence).toBe('the two action threw: x')
  })
})

describe('the deps of create<Kind>Action', () => {
  it('reads the dep when the action runs, not when it is built', async () => {
    const deps: WorktreeActionDeps = { cut: async () => ({ notCut: 'original' }) }
    const action = createWorktreeAction({ name: 'wt', base: 'main', submodules: false }, deps)
    deps.cut = async () => ({ head: 'b'.repeat(40), where: '/wt' })
    expect((await action.run(ctx)).verdict).toBe('passed')
  })

  it('make<Kind>Action takes Effect deps', async () => {
    const action = makeWorktreeAction(
      { name: 'wt', base: 'main', submodules: false },
      { cut: () => Effect.succeed({ asked: 'which?' }) },
    )
    expect(await Effect.runPromise(action.run(ctx))).toMatchObject({ verdict: 'needs-approval', evidence: 'which?' })
  })
})

describe('two passes at once (0122)', () => {
  // `@opentelemetry/api` ships no context manager of its own.
  const storage = new AsyncLocalStorage<Context>()
  const manager: ContextManager = {
    active: () => storage.getStore() ?? ROOT_CONTEXT,
    with: (c, fn, thisArg, ...args) => storage.run(c, () => fn.call(thisArg, ...args)),
    bind: (_c, target) => target,
    enable() {
      return this
    },
    disable() {
      return this
    },
  }
  beforeAll(() => {
    context.setGlobalContextManager(manager)
  })
  afterAll(() => {
    context.disable()
  })

  it('reports a failed action only to the sink of the pass it ran in', async () => {
    const failing = newSink()
    const passing = newSink()
    const slow = (name: string, result: ActionResult) =>
      port(name, () => Effect.promise(() => new Promise<void>((r) => setTimeout(r, 5))).pipe(Effect.as(result)))
    const pass = (sink: ReturnType<typeof newSink>, actions: ActionPort[]) =>
      context.with(withSink(context.active(), sink), () =>
        runActionPipeline({
          step: 'build',
          actions: actions.map((a) => promiseAction(a)),
          context: ctx,
          emit: () => {},
        }),
      )
    await Promise.all([
      pass(failing, [slow('a', { verdict: 'failed', evidence: 'no', findings: [] })]),
      pass(passing, [slow('b', PASSED), slow('c', PASSED)]),
    ])
    expect(failing.errored).toBe(true)
    expect(passing.errored).toBe(false)
  })
})
