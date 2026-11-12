/**
 * **The implementer is an Effect in the pass's own fiber** (#1057).
 *
 * An interruption during `implement` aborts the agent, waits for it to settle,
 * and only then lets the hook socket go; it records no receipt, and
 * `stoppedBy` stays `interrupted` so the worktree's finalizer keeps a dirty tree.
 *
 * Unit by [0060](../../../doc/decisions-archive/0060-the-gate-runs-unit-tests.md) §1.
 */
import type { Runtime } from '@lingtai/agent'
import { resolveRecipe } from '@lingtai/recipe'
import { Effect, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import { runOnce } from '../src/conduct.ts'
import {
  fakeGitHub,
  fakePorts,
  memoryStore,
  project,
  refusingRuntime,
  streams,
  withPorts,
} from '../test/one-attempt.ts'

const eventsOf = (store: ReturnType<typeof memoryStore>) =>
  [...streams(store)].flatMap(([id, events]) => events.map((e) => ({ id, ...e })))

describe('the implementer in the pass’s fiber', () => {
  it('aborts the agent, waits for it to settle, then unregisters the run, and keeps the dirty tree', async () => {
    const store = memoryStore()
    const did: string[] = []
    const ports = fakePorts(did, store)
    const log: string[] = []

    // The hook server's `unregister` and the worktree's git, wrapped to say so.
    const serve = ports.agent.serve
    ports.agent.serve = ((o: Parameters<typeof serve>[0]) =>
      Effect.map(serve(o), (server) => ({
        ...server,
        unregister: (runId: string) => {
          log.push('unregistered')
          return server.unregister(runId)
        },
      }))) as typeof serve
    const git = ports.repo.git
    ports.repo.git = ((args: string[]) =>
      args[0] === 'status' ? Effect.succeed(' M src/fix.ts\n') : git(args)) as typeof git

    let entered!: () => void
    const isEntered = new Promise<void>((resolve) => (entered = resolve))
    const runtime: Runtime = {
      ...refusingRuntime,
      run: async (request) => {
        if (request.runId.includes(':judge:') || request.runId.includes(':fix:')) return refusingRuntime.run(request)
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
    const client = fakeGitHub([])
    const fiber = Effect.runFork(
      runOnce({
        recipe: () => resolveRecipe((p, r) => client.fileAt(p, r), project.base ?? 'main'),
        project,
        client,
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
      }).pipe(Effect.provide(withPorts(ports))),
    )
    await isEntered
    await Effect.runPromise(Fiber.interrupt(fiber))
    log.push('interrupted')

    expect(log).toEqual(['started', 'aborted', 'settled', 'unregistered', 'interrupted'])
    const events = eventsOf(store)
    expect(events.filter((e) => e.type === 'RunProposedCompletion')).toEqual([])
    expect(events.filter((e) => e.type === 'RunSpent')).toEqual([])
    expect(did.some((line) => /kept the dirty tree.*stopped by interrupted/.test(line))).toBe(true)
  })
})
