/**
 * **The judge is an Effect in the pass's own fiber** (#1054).
 *
 * An interruption aborts the judge's agent and waits for it to settle before it
 * continues, and is neither a crash nor a `RunSpent`; a `Runtime.run` that
 * rejects is the made-up crash outcome, held for a person with no `RunSpent`.
 *
 * Unit by [0060](../../../doc/decisions-archive/0060-the-gate-runs-unit-tests.md) §1.
 */
import type { Runtime } from '@lingtai/agent'
import { resolveRecipe } from '@lingtai/recipe'
import { Effect, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import { runOnce } from '../src/conduct.ts'
import {
  JUDGED_BY_AN_AGENT,
  fakeGitHub,
  fakePorts,
  memoryStore,
  once,
  project,
  refusingRuntime,
  streams,
  withPorts,
} from '../test/one-attempt.ts'

const MANY_ROUNDS = JUDGED_BY_AN_AGENT.replace('rounds: 2, restarts: 0', 'rounds: 9, restarts: 3')

const argsFor = (runtime: Runtime, store: ReturnType<typeof memoryStore>) => ({
  project,
  client: fakeGitHub([], MANY_ROUNDS),
  runtime,
  issue: 7,
  hookBinary: '/tmp/fake/lingtai-hook',
  prompt: 'fix {{issue}}',
  merge: false,
  home: '/tmp/fake-home',
  store,
})

const eventsOf = (store: ReturnType<typeof memoryStore>) =>
  [...streams(store)].flatMap(([id, events]) => events.map((e) => ({ id, ...e })))

describe('the judge in the pass’s fiber', () => {
  it('aborts the agent, waits for it to settle, and only then finishes the interruption', async () => {
    const store = memoryStore()
    const ports = fakePorts([], store)
    const log: string[] = []
    let entered!: () => void
    const isEntered = new Promise<void>((resolve) => (entered = resolve))
    const runtime: Runtime = {
      ...refusingRuntime,
      run: async (request) => {
        if (!request.runId.includes(':judge:')) return refusingRuntime.run(request)
        log.push('started')
        entered()
        let settle!: () => void
        const mayRelease = new Promise<void>((resolve) => (settle = resolve))
        request.signal?.addEventListener('abort', () => {
          log.push('aborted')
          settle()
        })
        await mayRelease
        log.push('settled')
        return refusingRuntime.run(request)
      },
    }
    const options = argsFor(runtime, store)
    const fiber = Effect.runFork(
      runOnce({
        recipe: () => resolveRecipe((p, r) => options.client.fileAt(p, r), options.project.base ?? 'main'),
        ...options,
      }).pipe(Effect.provide(withPorts(ports))),
    )
    await isEntered
    await Effect.runPromise(Fiber.interrupt(fiber))
    log.push('interrupted')

    expect(log).toEqual(['started', 'aborted', 'settled', 'interrupted'])
    const events = eventsOf(store)
    expect(
      events.filter((e) => e.type === 'RunSpent' && (e.data as { for: { _tag: string } }).for._tag === 'Judge'),
    ).toEqual([])
    expect(events.filter((e) => e.id.startsWith('acct-'))).toEqual([])
  })

  it('makes a crash of the judge’s runtime a held verdict with no RunSpent', async () => {
    const store = memoryStore()
    const ports = fakePorts([], store)
    const runtime: Runtime = {
      ...refusingRuntime,
      run: async (request) => {
        if (request.runId.includes(':judge:')) throw new Error('the judge fell over')
        return refusingRuntime.run(request)
      },
    }
    const result = await once(argsFor(runtime, store), ports)
    if (result.ok !== 'held') throw new Error(`the pass did not hold: ${JSON.stringify(result)}`)
    const events = eventsOf(store)
    expect(JSON.stringify(events, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).toContain('the judge fell over')
    expect(
      events.filter((e) => e.type === 'RunSpent' && (e.data as { for: { _tag: string } }).for._tag === 'Judge'),
    ).toEqual([])
  })
})
