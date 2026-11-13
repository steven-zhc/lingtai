/**
 * #1095: the order `lingtai restart` refuses in, before the merge. Every refusal is *before* the drain, because
 * one after it is a system with no conductor (CLAUDE.md, *One command drains, waits and starts*), and the
 * integration half that plays `RESTART_GUARDS` runs after the merge.
 */
import type { Identity } from '@lingtai/daemon'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { controlCommand } from '../src/daemon.ts'
import { prepareRestart, restartSupervised, type RestartArgs, type RestartFacts } from '../src/restart.ts'

vi.mock('../src/project-pause.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/project-pause.ts')>()),
  pauseProjects: () => Effect.die(new Error('boom')),
}))

const CLEAN: Identity = {
  sha: '2926f2d0f0e2a0b1c2d3e4f5a6b7c8d9e0f1a2b3',
  dirty: false,
  base: 'origin/main',
  pushed: true,
  unknown: null,
}
const ARGS: RestartArgs = {
  reason: 'picking up #88',
  timeoutMs: null,
  dirty: false,
  despiteDoctor: false,
  noConduct: false,
  noMerge: false,
  force: false,
}

/** Facts that record each call, and answer a healthy system with a daemon up unless told otherwise. */
function world(over: Partial<RestartFacts> = {}) {
  const calls: string[] = []
  const note = <A>(name: string, value: A) =>
    Effect.sync(() => {
      calls.push(name)
      return value
    })
  const facts: RestartFacts = {
    identity: () => note('identity', CLEAN),
    doctor: () => note('doctor', { results: [] }),
    holder: () => note('holder', 'human:x' as string | null),
    daemonUp: () => note('daemonUp', true),
    control: () => note('control', { shutdown: null }),
    inFlight: () => note('inFlight', [] as string[]),
    ask: () => note('ask', { asked: true as const, version: 11 }),
    watermark: () => note('watermark', 10),
    startAfter: () => note('startAfter', null),
    requestsBetween: () => note('requestsBetween', []),
    pollMs: 1,
    ...over,
  }
  const lines: string[] = []
  return { calls, facts, lines, log: (l: string) => void lines.push(l) }
}

let user: string | undefined
beforeEach(() => {
  user = process.env['USER']
  process.env['USER'] = 'tester'
})
afterEach(() => {
  if (user === undefined) delete process.env['USER']
  else process.env['USER'] = user
  vi.restoreAllMocks()
})

const refusals: Record<string, Partial<RestartFacts>> = {
  'a dirty worktree': { identity: () => Effect.succeed({ ...CLEAN, dirty: true }) },
  'a red doctor': {
    doctor: () => Effect.succeed({ results: [{ name: 'store', status: 'fail', detail: 'red' }] }),
  },
  'a lock that could not be asked about': { holder: () => Effect.fail(new Error('lock unreadable')) },
  'a beacon that could not be read': { daemonUp: () => Effect.die(new Error('beacon unreadable')) },
  'a control stream that could not be read': { watermark: () => Effect.die(new Error('stream unreadable')) },
}

describe('a restart refuses before it drains', () => {
  for (const [name, over] of Object.entries(refusals)) {
    it(`${name}: terminal path asks nothing and waits for nothing`, async () => {
      const w = world(over)
      const prepared = await Effect.runPromise(prepareRestart(ARGS, w.log, w.facts))
      expect(prepared.ok).toBe(false)
      expect(w.calls).not.toContain('ask')
      expect(w.lines.join('\n')).toContain('not restarting:')
    })

    it(`${name}: supervised path asks nothing and never calls the service`, async () => {
      const w = world(over)
      const service = vi.fn(() => Effect.succeed(0))
      const code = await Effect.runPromise(restartSupervised(ARGS, { service, facts: w.facts, log: w.log }))
      expect(code).not.toBe(0)
      expect(w.calls).not.toContain('ask')
      expect(service).not.toHaveBeenCalled()
      expect(w.lines.join('\n')).toContain('not restarting:')
    })
  }

  it('a wait that Ctrl+C ended leaves the request standing: no start read, no second ask', async () => {
    let holderAsks = 0
    const w = world({
      holder: () =>
        Effect.sync(() => {
          // The second ask is the wait's first; the wait's own listener hears this.
          if (++holderAsks === 2) process.emit('SIGINT')
          return 'human:x'
        }),
    })
    const prepared = await Effect.runPromise(prepareRestart(ARGS, w.log, w.facts))
    expect(prepared).toEqual({ ok: false, code: 130 })
    expect(w.calls.filter((c) => c === 'ask')).toHaveLength(1)
    expect(w.calls).not.toContain('startAfter')
    expect(w.lines.join('\n')).toContain('The shutdown asked by human:tester is still standing')
  })
})

describe('controlCommand', () => {
  it('a pause whose store dies prints the message alone and exits 1', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = await Effect.runPromise(controlCommand('pause', {}))
    expect(code).toBe(1)
    expect(error.mock.calls).toEqual([['boom']])
  })
})
