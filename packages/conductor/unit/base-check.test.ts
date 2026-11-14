/**
 * **A check's result on a base commit is read off the log, or run once and
 * recorded there** (#743, 0108 §13). Over fakes for the cut, the plant, the
 * removal and the runner, and the memory store — no `git`, no directory.
 */
import type { CommandOutcome, RunCommandOptions } from '@lingtai/actions'
import { integrationStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { type BaseCheckQuestion, createBaseCheck } from '../src/base-check.ts'

const SHA = 'a'.repeat(40)
const stream = integrationStream('proj', 'main')

const outcome = (over: Partial<CommandOutcome> = {}): CommandOutcome => ({
  ok: true,
  evidence: '',
  timedOut: false,
  durationMs: 12,
  exitCode: 0,
  ...over,
})

let tree = freshTree()
beforeEach(() => {
  tree = freshTree()
})
function freshTree() {
  return { cut: vi.fn(async () => {}), plant: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
}

function question(over: Partial<BaseCheckQuestion> = {}): BaseCheckQuestion {
  return {
    project: 'proj',
    base: 'main',
    baseSha: SHA,
    command: 'pnpm typecheck',
    prepared: [{ run: 'pnpm install', env: { REGISTRY_TOKEN: 't' }, timeoutMs: 9000 }],
    env: {},
    runId: 'pass-1',
    signal: new AbortController().signal,
    timeoutMs: 1000,
    tree,
    ...over,
  }
}

function setup(run?: (o: RunCommandOptions) => Promise<CommandOutcome>) {
  const store = createMemoryEventStore()
  const calls: string[] = []
  const runner = vi.fn(run ?? (async () => outcome()))
  const deps = {
    store,
    run: (o: RunCommandOptions) => {
      calls.push(o.run)
      return Effect.promise(() => runner(o))
    },
    worktreePath: (p: string, sha7: string, runId: string) => `/wt/${p}/base-${sha7}-${runId}`,
    note: vi.fn(),
  }
  return { store, deps, runner, calls, port: createBaseCheck(deps) }
}

const recorded = async (store: ReturnType<typeof createMemoryEventStore>) =>
  (await store.read(stream)).filter((e) => e.type === 'BaseChecked')

describe('baseCheck', () => {
  it('runs each prepared command with its own env and timeout', async () => {
    const { port, runner } = setup()
    await Effect.runPromise(port.ask(question()))
    expect(runner.mock.calls[0]![0]).toMatchObject({
      run: 'pnpm install',
      env: { REGISTRY_TOKEN: 't' },
      timeoutMs: 9000,
    })
    expect(runner.mock.calls[1]![0]).toMatchObject({ run: 'pnpm typecheck', timeoutMs: 1000 })
    expect(runner.mock.calls[1]![0].env).not.toHaveProperty('REGISTRY_TOKEN')
  })

  it('cuts, installs, runs the command, removes, records one event and answers red', async () => {
    const { port, calls, store } = setup(async (o) =>
      o.run === 'pnpm typecheck' ? outcome({ ok: false, exitCode: 1, evidence: '58 errors' }) : outcome(),
    )
    const answer = await Effect.runPromise(port.ask(question()))
    expect(answer).toEqual({ verdict: 'red', exitCode: 1, evidence: '58 errors', from: 'ran' })
    expect(calls).toEqual(['pnpm install', 'pnpm typecheck'])
    expect(tree.cut).toHaveBeenCalledWith(`/wt/proj/base-aaaaaaa-pass-1`, SHA)
    expect(tree.remove).toHaveBeenCalledTimes(1)
    const events = await recorded(store)
    expect(events).toHaveLength(1)
    expect(events[0]!.data).toMatchObject({ baseSha: SHA, command: 'pnpm typecheck', ok: false, exitCode: 1 })
  })

  it('answers green on exit 0', async () => {
    const { port } = setup()
    expect(await Effect.runPromise(port.ask(question()))).toEqual({ verdict: 'green', exitCode: 0, from: 'ran' })
  })

  it('answers from the log without running anything', async () => {
    const first = setup(async (o) =>
      o.run === 'pnpm typecheck' ? outcome({ exitCode: 2, ok: false, evidence: 'x' }) : outcome(),
    )
    await Effect.runPromise(first.port.ask(question()))
    const second = createBaseCheck({ ...first.deps, run: vi.fn() })
    const answer = await Effect.runPromise(second.ask(question({ runId: 'pass-2' })))
    expect(answer).toEqual({ verdict: 'red', exitCode: 2, evidence: 'x', from: 'log' })
  })

  it('runs again for the same command on a different sha', async () => {
    const { port, runner } = setup()
    await Effect.runPromise(port.ask(question()))
    await Effect.runPromise(port.ask(question({ baseSha: 'b'.repeat(40), runId: 'pass-2' })))
    expect(runner).toHaveBeenCalledTimes(4)
  })

  it('shares one run between two concurrent asks and appends once', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const { port, calls, store } = setup(async (o) => {
      if (o.run === 'pnpm typecheck') await gate
      return outcome()
    })
    const a = Effect.runPromise(port.ask(question()))
    const b = Effect.runPromise(port.ask(question({ runId: 'pass-2' })))
    release()
    await Promise.all([a, b])
    expect(calls.filter((c) => c === 'pnpm typecheck')).toHaveLength(1)
    expect(calls.filter((c) => c === 'pnpm install')).toHaveLength(1)
    expect(await recorded(store)).toHaveLength(1)
  })

  it('records once even when the lane moves the stream during the run', async () => {
    let store: ReturnType<typeof createMemoryEventStore>
    const s = setup(async (o) => {
      if (o.run === 'pnpm typecheck') {
        const at = (await store.read(stream)).length
        await store.append(stream, at, [
          { type: 'IntegrationAttempted', actor: 'conductor', data: { ticketId: 't', branch: 'b', headSha: 'h' } },
        ])
      }
      return outcome()
    })
    store = s.store
    await Effect.runPromise(s.port.ask(question()))
    expect(await recorded(store)).toHaveLength(1)
  })

  it('still answers when the append fails, and notes it', async () => {
    const s = setup()
    const failing = createBaseCheck({
      ...s.deps,
      store: { read: s.store.read.bind(s.store), append: async () => Promise.reject(new Error('disk')) },
    })
    expect(await Effect.runPromise(failing.ask(question()))).toMatchObject({ verdict: 'green', from: 'ran' })
    expect(s.deps.note).toHaveBeenCalled()
  })

  describe('unknown is never appended and the worktree is still removed', () => {
    it('a timeout', async () => {
      const { port, store } = setup(async (o) =>
        o.run === 'pnpm typecheck' ? outcome({ ok: false, timedOut: true, exitCode: null }) : outcome(),
      )
      expect((await Effect.runPromise(port.ask(question()))).verdict).toBe('unknown')
      expect(await recorded(store)).toHaveLength(0)
      expect(tree.remove).toHaveBeenCalledTimes(1)
    })

    it('a failed cut', async () => {
      const { port, store, runner } = setup()
      tree.cut.mockRejectedValueOnce(new Error('bad object'))
      expect((await Effect.runPromise(port.ask(question()))).verdict).toBe('unknown')
      expect(runner).not.toHaveBeenCalled()
      expect(await recorded(store)).toHaveLength(0)
      expect(tree.remove).toHaveBeenCalledTimes(1)
    })

    it('a failed prepared command', async () => {
      const { port, store, calls } = setup(async (o) =>
        o.run === 'pnpm install' ? outcome({ ok: false, exitCode: 1, evidence: 'no network' }) : outcome(),
      )
      const answer = await Effect.runPromise(port.ask(question()))
      expect(answer).toMatchObject({ verdict: 'unknown' })
      expect(calls).toEqual(['pnpm install'])
      expect(await recorded(store)).toHaveLength(0)
      expect(tree.remove).toHaveBeenCalledTimes(1)
    })

    it('an aborted signal', async () => {
      const controller = new AbortController()
      const { port, store } = setup(async () => {
        controller.abort()
        return outcome({ exitCode: 1, ok: false })
      })
      expect((await Effect.runPromise(port.ask(question({ signal: controller.signal })))).verdict).toBe('unknown')
      expect(await recorded(store)).toHaveLength(0)
      expect(tree.remove).toHaveBeenCalledTimes(1)
    })

    it('an abort while the cut is pending starts nothing', async () => {
      const controller = new AbortController()
      const { port, store, runner } = setup()
      tree.cut.mockImplementationOnce(async () => controller.abort())
      expect((await Effect.runPromise(port.ask(question({ signal: controller.signal })))).verdict).toBe('unknown')
      expect(runner).not.toHaveBeenCalled()
      expect(await recorded(store)).toHaveLength(0)
      expect(tree.remove).toHaveBeenCalledTimes(1)
    })

    it('an abort while the plant is pending starts nothing, with no prepared commands', async () => {
      const controller = new AbortController()
      const { port, store, runner } = setup()
      tree.plant.mockImplementationOnce(async () => controller.abort())
      const answer = await Effect.runPromise(port.ask(question({ signal: controller.signal, prepared: [] })))
      expect(answer.verdict).toBe('unknown')
      expect(runner).not.toHaveBeenCalled()
      expect(await recorded(store)).toHaveLength(0)
      expect(tree.remove).toHaveBeenCalledTimes(1)
    })
  })

  it('answers unknown and runs nothing when the log cannot be read', async () => {
    const s = setup()
    const port = createBaseCheck({
      ...s.deps,
      store: { read: async () => Promise.reject(new Error('down')), append: s.store.append.bind(s.store) },
    })
    expect((await Effect.runPromise(port.ask(question()))).verdict).toBe('unknown')
    expect(s.runner).not.toHaveBeenCalled()
    expect(tree.cut).not.toHaveBeenCalled()
  })
})

describe('baseCheck under a boundary (#1153)', () => {
  /** A fake wrap: counts the profile reads and records every wrap with the profile it was handed. */
  function fakeSandbox(
    over: { fingerprint?: (p?: unknown) => string; profile?: () => unknown; failWrap?: boolean } = {},
  ) {
    const reads: string[] = []
    const wraps: { command: readonly string[]; env: Record<string, string>; profile: unknown }[] = []
    const sandbox = {
      profile: (_worktree: string, env: Record<string, string>) => {
        reads.push(env.HOME ?? '')
        return (over.profile?.() ?? { ok: true, paths: [] }) as never
      },
      fingerprint: (_w: string, profile?: unknown) => (over.fingerprint ?? (() => 'fp-A'))(profile),
      wrap: (command: readonly string[], _w: string, env: Record<string, string>, profile: unknown) => {
        wraps.push({ command, env, profile })
        return over.failWrap
          ? Effect.fail({ _tag: 'SandboxUnavailable', reason: 'no bwrap', sentences: [] } as never)
          : Effect.succeed({ argv: ['/wrap', ...command], env: { ...env, WRAPPED: '1' }, commandId: 'c' })
      },
    }
    return { sandbox, reads, wraps }
  }

  it('reads the profile once per command and wraps with that same value', async () => {
    const { port, runner } = setup()
    const f = fakeSandbox({ profile: () => ({ ok: true, paths: ['/secret'] }) })
    const answer = await Effect.runPromise(port.ask(question({ sandbox: f.sandbox as never })))
    expect(answer).toMatchObject({ verdict: 'green', from: 'ran' })
    expect(f.reads).toHaveLength(2)
    expect(f.wraps).toHaveLength(2)
    expect(f.wraps[0]!.command).toEqual(['/bin/sh', '-c', 'pnpm install'])
    expect(f.wraps[1]!.profile).toEqual({ ok: true, paths: ['/secret'] })
    expect(runner.mock.calls[1]![0]).toMatchObject({ wrapped: { argv: ['/wrap', '/bin/sh', '-c', 'pnpm typecheck'] } })
  })

  it('records the fingerprint, and an answer under one boundary never answers another', async () => {
    const { port, store, calls } = setup()
    await Effect.runPromise(port.ask(question({ sandbox: fakeSandbox().sandbox as never })))
    expect((await recorded(store))[0]!.data).toMatchObject({ boundary: 'fp-A' })
    // The same boundary is answered from the log; another boundary and no sandbox run again.
    const same = await Effect.runPromise(port.ask(question({ sandbox: fakeSandbox().sandbox as never })))
    expect(same).toMatchObject({ from: 'log' })
    await Effect.runPromise(
      port.ask(question({ sandbox: fakeSandbox({ fingerprint: () => 'fp-B' }).sandbox as never })),
    )
    await Effect.runPromise(port.ask(question()))
    expect(calls.filter((c) => c === 'pnpm typecheck')).toHaveLength(3)
    expect((await recorded(store)).map((e) => (e.data as { boundary: string }).boundary)).toEqual([
      'fp-A',
      'fp-B',
      'unsandboxed',
    ])
  })

  it('reads an event with no boundary as unsandboxed: it answers that question and never a sandboxed one', async () => {
    const { port, store, calls } = setup()
    await store.append(stream, 0, [
      {
        type: 'BaseChecked',
        actor: 'conductor',
        data: {
          base: 'main',
          baseSha: SHA,
          command: 'pnpm typecheck',
          ok: false,
          exitCode: 1,
          durationMs: 1,
          evidence: 'x',
          runId: 'old',
        },
      },
    ])
    expect(await Effect.runPromise(port.ask(question()))).toMatchObject({ verdict: 'red', from: 'log' })
    expect(calls).toEqual([])
    const sandboxed = await Effect.runPromise(port.ask(question({ sandbox: fakeSandbox().sandbox as never })))
    expect(sandboxed).toMatchObject({ verdict: 'green', from: 'ran' })
  })

  it('shares one run for one fingerprint and runs twice for two', async () => {
    const { port, calls } = setup(async () => {
      await new Promise((r) => setTimeout(r, 10))
      return outcome()
    })
    const ask = (fp: string) =>
      Effect.runPromise(port.ask(question({ sandbox: fakeSandbox({ fingerprint: () => fp }).sandbox as never })))
    await Promise.all([ask('fp-A'), ask('fp-A')])
    expect(calls.filter((c) => c === 'pnpm typecheck')).toHaveLength(1)
    await Promise.all([ask('fp-C'), ask('fp-D')])
    expect(calls.filter((c) => c === 'pnpm typecheck')).toHaveLength(3)
  })

  it('answers unknown and records nothing when the wrap fails, never spawning unwrapped', async () => {
    const { port, store, runner } = setup()
    const answer = await Effect.runPromise(
      port.ask(question({ sandbox: fakeSandbox({ failWrap: true }).sandbox as never })),
    )
    expect(answer).toMatchObject({ verdict: 'unknown' })
    expect(runner).not.toHaveBeenCalled()
    expect(await recorded(store)).toEqual([])
  })

  it('answers unknown and records nothing when the profile refuses', async () => {
    const { port, store, runner } = setup()
    const f = fakeSandbox({ profile: () => ({ ok: false, refusal: { sentence: 'bad profile' } }) })
    const answer = await Effect.runPromise(port.ask(question({ sandbox: f.sandbox as never })))
    expect(answer).toMatchObject({ verdict: 'unknown' })
    expect(runner).not.toHaveBeenCalled()
    expect(await recorded(store)).toEqual([])
  })

  it('a hit under a sandboxed boundary removes the tree and runs nothing', async () => {
    const { port, runner } = setup()
    await Effect.runPromise(port.ask(question({ sandbox: fakeSandbox().sandbox as never })))
    runner.mockClear()
    tree.remove.mockClear()
    await Effect.runPromise(port.ask(question({ sandbox: fakeSandbox().sandbox as never })))
    expect(runner).not.toHaveBeenCalled()
    expect(tree.remove).toHaveBeenCalledTimes(1)
  })
})
