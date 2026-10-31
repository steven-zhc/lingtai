/**
 * **A check's result on a base commit is read off the log, or run once and
 * recorded there** (#743, 0108 §13). Over fakes for the cut, the plant, the
 * removal and the runner, and the memory store — no `git`, no directory.
 */
import type { CommandOutcome, RunCommandOptions } from '@lingtai/actions'
import { integrationStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
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
    prepared: ['pnpm install'],
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
      return runner(o)
    },
    worktreePath: (p: string, sha7: string, runId: string) => `/wt/${p}/base-${sha7}-${runId}`,
    note: vi.fn(),
  }
  return { store, deps, runner, calls, port: createBaseCheck(deps) }
}

const recorded = async (store: ReturnType<typeof createMemoryEventStore>) =>
  (await store.read(stream)).filter((e) => e.type === 'BaseChecked')

describe('baseCheck', () => {
  it('cuts, installs, runs the command, removes, records one event and answers red', async () => {
    const { port, calls, store } = setup(async (o) =>
      o.run === 'pnpm typecheck' ? outcome({ ok: false, exitCode: 1, evidence: '58 errors' }) : outcome(),
    )
    const answer = await port.ask(question())
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
    expect(await port.ask(question())).toEqual({ verdict: 'green', exitCode: 0, from: 'ran' })
  })

  it('answers from the log without running anything', async () => {
    const first = setup(async (o) =>
      o.run === 'pnpm typecheck' ? outcome({ exitCode: 2, ok: false, evidence: 'x' }) : outcome(),
    )
    await first.port.ask(question())
    const second = createBaseCheck({ ...first.deps, run: vi.fn() })
    const answer = await second.ask(question({ runId: 'pass-2' }))
    expect(answer).toEqual({ verdict: 'red', exitCode: 2, evidence: 'x', from: 'log' })
  })

  it('runs again for the same command on a different sha', async () => {
    const { port, runner } = setup()
    await port.ask(question())
    await port.ask(question({ baseSha: 'b'.repeat(40), runId: 'pass-2' }))
    expect(runner).toHaveBeenCalledTimes(4)
  })

  it('shares one run between two concurrent asks and appends once', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const { port, calls, store } = setup(async (o) => {
      if (o.run === 'pnpm typecheck') await gate
      return outcome()
    })
    const a = port.ask(question())
    const b = port.ask(question({ runId: 'pass-2' }))
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
    await s.port.ask(question())
    expect(await recorded(store)).toHaveLength(1)
  })

  it('still answers when the append fails, and notes it', async () => {
    const s = setup()
    const failing = createBaseCheck({
      ...s.deps,
      store: { read: s.store.read.bind(s.store), append: async () => Promise.reject(new Error('disk')) },
    })
    expect(await failing.ask(question())).toMatchObject({ verdict: 'green', from: 'ran' })
    expect(s.deps.note).toHaveBeenCalled()
  })

  describe('unknown is never appended and the worktree is still removed', () => {
    it('a timeout', async () => {
      const { port, store } = setup(async (o) =>
        o.run === 'pnpm typecheck' ? outcome({ ok: false, timedOut: true, exitCode: null }) : outcome(),
      )
      expect((await port.ask(question())).verdict).toBe('unknown')
      expect(await recorded(store)).toHaveLength(0)
      expect(tree.remove).toHaveBeenCalledTimes(1)
    })

    it('a failed cut', async () => {
      const { port, store, runner } = setup()
      tree.cut.mockRejectedValueOnce(new Error('bad object'))
      expect((await port.ask(question())).verdict).toBe('unknown')
      expect(runner).not.toHaveBeenCalled()
      expect(await recorded(store)).toHaveLength(0)
      expect(tree.remove).toHaveBeenCalledTimes(1)
    })

    it('a failed prepared command', async () => {
      const { port, store, calls } = setup(async (o) =>
        o.run === 'pnpm install' ? outcome({ ok: false, exitCode: 1, evidence: 'no network' }) : outcome(),
      )
      const answer = await port.ask(question())
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
      expect((await port.ask(question({ signal: controller.signal }))).verdict).toBe('unknown')
      expect(await recorded(store)).toHaveLength(0)
      expect(tree.remove).toHaveBeenCalledTimes(1)
    })

    it('an abort while the cut is pending starts nothing', async () => {
      const controller = new AbortController()
      const { port, store, runner } = setup()
      tree.cut.mockImplementationOnce(async () => controller.abort())
      expect((await port.ask(question({ signal: controller.signal }))).verdict).toBe('unknown')
      expect(runner).not.toHaveBeenCalled()
      expect(await recorded(store)).toHaveLength(0)
      expect(tree.remove).toHaveBeenCalledTimes(1)
    })

    it('an abort while the plant is pending starts nothing, with no prepared commands', async () => {
      const controller = new AbortController()
      const { port, store, runner } = setup()
      tree.plant.mockImplementationOnce(async () => controller.abort())
      const answer = await port.ask(question({ signal: controller.signal, prepared: [] }))
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
    expect((await port.ask(question())).verdict).toBe('unknown')
    expect(s.runner).not.toHaveBeenCalled()
    expect(tree.cut).not.toHaveBeenCalled()
  })
})
