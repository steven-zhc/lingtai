/**
 * Interrupting an adapter's run waits for the process group to be gone (#1023, #587).
 *
 * The Effect is forked and interrupted under fake timers, so every step is driven with
 * `advanceTimersByTimeAsync`: Effect's scheduler yields on `setImmediate`, which the fake clock owns.
 */
import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { Deferred, Effect, Exit, Fiber } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { claudeCodeRun } from '../src/claude-code.ts'
import { codexRun } from '../src/codex.ts'
import type { RunOutcome, RunRequest } from '../src/runtime.ts'

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    readFileSync: ((path: unknown, ...rest: unknown[]) =>
      path === '/wiring/settings.json'
        ? '{}'
        : (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)) as typeof real.readFileSync,
  }
})

const PID = 4242

// `pid: null` is Codex's case: it signals with `process.kill(-pid)` and has no injectable
// sender, so the stand-in has no pid and it falls back to the stand-in's `kill`: no real signal
// is ever sent. (`null`, not `undefined`: `undefined` would activate the default.)
const stubChild = (pid: number | null = PID) =>
  Object.assign(new EventEmitter(), {
    pid: pid ?? undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  })

const request = (over: Partial<RunRequest> = {}): RunRequest => ({
  runId: 'r1',
  cwd: '/tmp',
  prompt: 'p',
  settingsPath: '/wiring/settings.json',
  env: {},
  limits: { wallMs: 60_000 },
  ...over,
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('claudeCodeRun interrupted (#1023)', () => {
  it('completes the interruption only once the group reports ESRCH', async () => {
    const child = stubChild()
    const calls: Array<[number, NodeJS.Signals | 0]> = []
    let gone = false
    const fiber = Effect.runFork(
      claudeCodeRun(
        {
          spawn: (() => child) as unknown as typeof spawn,
          signal: (pid, sig) => {
            calls.push([pid, sig])
            if (gone) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
          },
        },
        request(),
      ),
    )
    await vi.advanceTimersByTimeAsync(10)
    let interrupted = false
    void Effect.runPromise(Fiber.interrupt(fiber)).then(() => (interrupted = true))

    await vi.advanceTimersByTimeAsync(5_000)
    expect(calls[0]).toEqual([-PID, 'SIGTERM'])
    expect(calls).toContainEqual([-PID, 'SIGKILL'])
    expect(interrupted).toBe(false)

    gone = true
    await vi.advanceTimersByTimeAsync(100)
    expect(interrupted).toBe(true)
    expect(calls.findIndex(([, s]) => s === 'SIGTERM')).toBeLessThan(calls.findIndex(([, s]) => s === 'SIGKILL'))
  })
})

describe('a spawn error is an outcome, not a failure (#1023)', () => {
  it('gives a crash outcome from claudeCodeRun as a successful Effect', async () => {
    const child = stubChild()
    const exit = Effect.runPromiseExit(
      claudeCodeRun({ spawn: (() => child) as unknown as typeof spawn, signal: () => undefined }, request()),
    )
    child.emit('error', new Error('spawn claude ENOENT'))
    const done = await exit
    expect(Exit.isSuccess(done)).toBe(true)
    const outcome = (done as Exit.Success<RunOutcome, never>).value
    expect(outcome.failure).toEqual({ kind: 'crash', detail: 'spawn claude ENOENT' })
  })

  it('gives a crash outcome from codexRun as a successful Effect', async () => {
    const child = stubChild(null)
    const exit = Effect.runPromiseExit(
      codexRun({ spawn: (() => child) as unknown as typeof spawn, stopProcesses: () => Effect.void }, request()),
    )
    child.emit('error', new Error('spawn codex ENOENT'))
    const done = await exit
    expect(Exit.isSuccess(done)).toBe(true)
    const outcome = (done as Exit.Success<RunOutcome, never>).value
    expect(outcome.failure).toEqual({ kind: 'crash', detail: 'spawn codex ENOENT' })
  })
})

describe('codexRun interrupted (#1023)', () => {
  it('completes the interruption only once the process scan has settled', async () => {
    const child = stubChild(null)
    const release = Effect.runSync(Deferred.make<void, Error>())
    const fiber = Effect.runFork(
      codexRun(
        {
          spawn: (() => child) as unknown as typeof spawn,
          stopProcesses: () => Deferred.await(release),
        },
        request(),
      ),
    )
    await vi.advanceTimersByTimeAsync(10)
    let interrupted = false
    void Effect.runPromise(Fiber.interrupt(fiber)).then(() => (interrupted = true))

    await vi.advanceTimersByTimeAsync(5_000)
    expect(interrupted).toBe(false)

    Effect.runSync(Deferred.succeed(release, undefined))
    await vi.advanceTimersByTimeAsync(10)
    expect(interrupted).toBe(true)
  })
})
