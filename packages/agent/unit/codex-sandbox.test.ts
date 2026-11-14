/**
 * A sandboxed Codex run (#1151). Nothing here starts srt or a process: `wrap` is a recording fake and `spawn` a stand-in.
 */
import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import type { WrapInput } from '@lingtai/sandbox'
import { Effect, Exit, Fiber } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SandboxRunRefused, type RunSandbox } from '../src/claude-sandbox.ts'
import { codexProfileDenies, codexSandboxedLaunch } from '../src/codex-sandbox.ts'
import { codexArgv, codexRun, createCodexRuntime, type UserPermissions } from '../src/codex.ts'
import type { RunOutcome, RunRequest } from '../src/runtime.ts'

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    readFileSync: ((path: unknown, ...rest: unknown[]) =>
      path === '/wiring/settings.json'
        ? '{}'
        : path === '/home/op/.codex/config.toml'
          ? ((globalThis as { __codexConfig?: string }).__codexConfig ?? '')
          : (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)) as typeof real.readFileSync,
  }
})

const AT = { home: '/home/op', cwd: '/work/tree' }

describe('codexProfileDenies', () => {
  const denies = (...paths: string[]): UserPermissions => ({ kind: 'denies', paths })
  const paths = (v: UserPermissions) => {
    const r = codexProfileDenies(v, AT)
    if (!r.ok) throw new Error(r.refusal.sentence)
    return r.paths
  }
  it('carries nothing for none and kept', () => {
    expect(paths({ kind: 'none' })).toEqual([])
    expect(paths({ kind: 'kept', why: 'x' })).toEqual([])
  })
  it('resolves home, relative and absolute keys, and anchors a glob', () => {
    expect(paths(denies('~/.ssh', '/etc/x', 'secrets', '~/a/**/*.key'))).toEqual([
      '/home/op/.ssh',
      '/etc/x',
      '/work/tree/secrets',
      '/home/op/a/**/*.key',
    ])
  })
  it('refuses a :special key, an unreadable profile and a ~ with no HOME, by name', () => {
    const special = codexProfileDenies(denies(':minimal'), AT)
    expect(!special.ok && special.refusal.sentence).toContain(':minimal')
    const bad = codexProfileDenies({ kind: 'unreadable', why: 'nope' }, AT)
    expect(!bad.ok && bad.refusal.sentence).toContain('nope')
    const noHome = codexProfileDenies(denies('~/x'), { home: undefined, cwd: '/w' })
    expect(!noHome.ok && noHome.refusal.sentence).toContain('HOME')
  })
})

const fakeSandbox = (over: Partial<RunSandbox> = {}) => {
  const wrapped: WrapInput[] = []
  const sandbox: RunSandbox = {
    decision: { kind: 'sandboxed', project_additions: { write: ['/extra'] } },
    project: 'p',
    mirror: '/state/repos/p.git',
    cache: '/state/cache/p',
    worktree: '/work/tree',
    runDir: '/state/runs/r1/claude',
    operatorClaudeDir: '/home/op/.claude',
    hostHome: '/home/op',
    read: ['/bundle/lingtai-hook'],
    wrap: (input) =>
      Effect.sync(() => {
        wrapped.push(input)
        return { argv: ['srt', '--', ...input.command], env: { ...input.env, SRT: '1' }, commandId: 'c1' }
      }),
    ...over,
  }
  return { sandbox, wrapped }
}

const launch = (permissions: UserPermissions, over: Partial<RunSandbox> = {}, codexHome = '/home/op/.codex') => {
  const { sandbox, wrapped } = fakeSandbox(over)
  const exit = Effect.runSyncExit(
    Effect.scoped(
      codexSandboxedLaunch(
        sandbox,
        {
          argv: ['codex', 'exec'],
          env: { LINGTAI_CODEX_PROCESS_MARKER: 'm1' },
          cwd: '/work/tree',
          codexHome,
          permissions,
          outputSchemaPath: '/tmp/schema.json',
        },
        '/home/op',
      ),
    ),
  )
  return { exit, wrapped }
}

const refusal = (exit: Exit.Exit<unknown, SandboxRunRefused>): string => {
  if (!Exit.isFailure(exit)) throw new Error('expected a refusal')
  const e = exit.cause.reasons.find((r) => r._tag === 'Fail')
  return (e as { error: SandboxRunRefused }).error.sentence
}

describe('codexSandboxedLaunch', () => {
  it('wraps with the Codex home writable, its configuration write-denied only, and the profile denies', () => {
    const { exit, wrapped } = launch({ kind: 'denies', paths: ['~/.ssh'] })
    expect(Exit.isSuccess(exit)).toBe(true)
    const input = wrapped[0]!
    expect(input.command).toEqual(['codex', 'exec'])
    expect(input.env.LINGTAI_CODEX_PROCESS_MARKER).toBe('m1')
    const add = input.caller_additions!
    expect(add.write).toEqual(['/home/op/.codex'])
    expect(add.denyWrite).toEqual(['/home/op/.codex/config.toml', '/home/op/.codex/AGENTS.md', '/home/op/.codex/rules'])
    expect(add.deny).toEqual(['/home/op/.ssh'])
    expect(add.deny).not.toContain('/home/op/.codex/config.toml')
    expect(add.read).toEqual(['/bundle/lingtai-hook', '/tmp/schema.json'])
    if (Exit.isSuccess(exit)) expect(exit.value.command).toBe('srt')
  })
  it('refuses a refused decision before wrap', () => {
    const { exit, wrapped } = launch({ kind: 'none' }, { decision: { kind: 'refused', why: 'no bwrap' } })
    expect(refusal(exit)).toContain('sandbox required and unavailable on this host: no bwrap')
    expect(wrapped).toEqual([])
  })
  it('refuses an unreadable profile before wrap', () => {
    const { exit, wrapped } = launch({ kind: 'unreadable', why: 'bad' })
    expect(refusal(exit)).toContain('bad')
    expect(wrapped).toEqual([])
  })
  it.each([
    ['the worktree', '/work/tree'],
    ['inside the worktree', '/work/tree/secrets'],
    ['a parent of the worktree', '/work'],
    ['the mirror', '/state/repos/p.git'],
    ['the cache', '/state/cache/p'],
    ['the Codex home', '/home/op/.codex'],
    ['inside the Codex home', '/home/op/.codex/sessions'],
  ])('refuses a deny that is or covers %s', (_n, path) => {
    const { exit, wrapped } = launch({ kind: 'denies', paths: [path] })
    expect(refusal(exit)).toContain(path)
    expect(wrapped).toEqual([])
  })
  it('fails with the sentence of a wrap that failed', () => {
    const { exit } = launch(
      { kind: 'none' },
      { wrap: () => Effect.fail({ message: 'srt could not wrap the command: boom' }) },
    )
    expect(refusal(exit)).toBe('srt could not wrap the command: boom')
  })
})

describe('codexRun with a decision', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as { __codexConfig?: string }).__codexConfig = ''
  })
  afterEach(() => vi.useRealTimers())

  const request = (sandbox?: RunSandbox): RunRequest => ({
    runId: 'r1',
    cwd: '/work/tree',
    prompt: 'p',
    settingsPath: '/wiring/settings.json',
    env: { HOME: '/home/op', PATH: '/bin' },
    limits: { wallMs: 60_000 },
    ...(sandbox === undefined ? {} : { sandbox }),
  })
  const child = () =>
    Object.assign(new EventEmitter(), {
      pid: undefined,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    })

  it('spawns the fake wrap argv and env, with no shell, and danger-full-access only here', async () => {
    const { sandbox, wrapped } = fakeSandbox()
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
    const c = child()
    const fiber = Effect.runFork(
      codexRun(
        {
          binary: 'codex',
          spawn: ((command: string, args: string[], options: Record<string, unknown>) => {
            calls.push({ command, args, options })
            return c
          }) as unknown as typeof spawn,
          stopProcesses: () => Effect.void,
        },
        request(sandbox),
      ),
    )
    await vi.advanceTimersByTimeAsync(10)
    const cmd = wrapped[0]!.command
    expect(cmd[0]).toBe('codex')
    expect(cmd[cmd.indexOf('--sandbox') + 1]).toBe('danger-full-access')
    expect(cmd.join(' ')).not.toMatch(/default_permissions|permissions\.|--add-dir/)
    expect(calls[0]!.command).toBe('srt')
    expect(calls[0]!.args).toEqual(['--', ...cmd])
    expect((calls[0]!.options.env as Record<string, string>).SRT).toBe('1')
    expect(calls[0]!.options.shell).toBeUndefined()
    c.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(10)
    await Effect.runPromise(Fiber.interrupt(fiber))
  })

  it('stops a wrapped run through the marker handed to wrap', async () => {
    const { sandbox, wrapped } = fakeSandbox()
    const stops: string[] = []
    const c = child()
    const fiber = Effect.runFork(
      codexRun(
        {
          spawn: (() => c) as unknown as typeof spawn,
          stopProcesses: (marker) => Effect.sync(() => void stops.push(marker)),
        },
        request(sandbox),
      ),
    )
    await vi.advanceTimersByTimeAsync(10)
    void Effect.runPromise(Fiber.interrupt(fiber))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(stops.length).toBeGreaterThan(0)
    expect(stops[0]).toBe(wrapped[0]!.env.LINGTAI_CODEX_PROCESS_MARKER)
  })

  it('spawns nothing when the signal aborted while the wrap was pending', async () => {
    const ac = new AbortController()
    const { sandbox, wrapped } = fakeSandbox({
      wrap: (input) =>
        Effect.sync(() => {
          ac.abort()
          return { argv: ['srt', '--', ...input.command], env: { ...input.env }, commandId: 'c1' }
        }),
    })
    const spawnFn = vi.fn()
    const outcome: RunOutcome = await Effect.runPromise(
      codexRun({ spawn: spawnFn as unknown as typeof spawn }, { ...request(sandbox), signal: ac.signal }),
    )
    expect(outcome.failure?.kind).toBe('aborted')
    expect(spawnFn).not.toHaveBeenCalled()
    expect(wrapped).toEqual([])
  })

  it('spawns nothing for a refused decision or a failing wrap, and answers a crash', async () => {
    for (const [over, text] of [
      [{ decision: { kind: 'refused', why: 'no srt' } }, 'sandbox required and unavailable on this host: no srt'],
      [{ wrap: () => Effect.fail({ message: 'srt said no' }) }, 'srt said no'],
    ] as const) {
      const { sandbox, wrapped } = fakeSandbox(over as Partial<RunSandbox>)
      const spawnFn = vi.fn()
      const outcome: RunOutcome = await Effect.runPromise(
        codexRun({ spawn: spawnFn as unknown as typeof spawn }, request(sandbox)),
      )
      expect(outcome.failure).toEqual({ kind: 'crash', detail: text })
      expect(spawnFn).not.toHaveBeenCalled()
      expect(wrapped).toEqual([])
    }
  })

  it('leaves a run with no decision exactly as it was', async () => {
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
    const c = child()
    const fiber = Effect.runFork(
      codexRun(
        {
          binary: 'codex',
          spawn: ((command: string, args: string[], options: Record<string, unknown>) => {
            calls.push({ command, args, options })
            return c
          }) as unknown as typeof spawn,
          stopProcesses: () => Effect.void,
        },
        request(),
      ),
    )
    await vi.advanceTimersByTimeAsync(10)
    expect(calls[0]!.command).toBe('codex')
    expect(calls[0]!.args.join(' ')).not.toContain('danger-full-access')
    expect(calls[0]!.args[calls[0]!.args.indexOf('--sandbox') + 1]).toBe('workspace-write')
    expect(typeof (calls[0]!.options.env as Record<string, string>).LINGTAI_CODEX_PROCESS_MARKER).toBe('string')
    c.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(10)
    await Effect.runPromise(Fiber.interrupt(fiber))
  })
})

describe('danger-full-access', () => {
  const req = {
    runId: 'r',
    cwd: '/w',
    settingsPath: '/s',
    env: {},
    limits: { wallMs: 1 },
  } as unknown as Parameters<typeof codexArgv>[0]
  it('appears in no argv built without a sandboxed decision', () => {
    for (const sandbox of ['workspace-write', 'read-only'] as const) {
      for (const denies of [[], ['/x']]) {
        for (const writable of [[], ['/git']]) {
          const a = codexArgv(req, 'p', { settings: {}, sandbox, writable, denies })
          expect(a.join(' ')).not.toContain('danger-full-access')
        }
      }
    }
  })
  it('is what invocation() shows for a sandboxed decision, and only then', () => {
    const rt = createCodexRuntime()
    const { sandbox } = fakeSandbox()
    const inv = (s?: RunSandbox) =>
      rt.invocation!({ ...req, ...(s === undefined ? {} : { sandbox: s }) } as Parameters<
        NonNullable<typeof rt.invocation>
      >[0]).args
    expect(inv(sandbox).join(' ')).toContain('--sandbox danger-full-access')
    expect(inv().join(' ')).not.toContain('danger-full-access')
  })
})
