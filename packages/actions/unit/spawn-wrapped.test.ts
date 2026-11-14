/**
 * `spawnChild`'s two spawns (#1152): a pre-wrapped argv with `shell: false`, and today's `shell: true`. `node:child_process` is
 * mocked, so no test here starts a process (0060 §1).
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { Effect } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn }))

import { commandEffect } from '../src/command.ts'

/** A child that exits 0 as soon as somebody listens for `close`. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child['stdout'] = new PassThrough()
  child['stderr'] = new PassThrough()
  child['stdin'] = new PassThrough()
  child['pid'] = 4242
  child['exitCode'] = null
  child['signalCode'] = null
  child['kill'] = vi.fn()
  queueMicrotask(() => child.emit('close', 0))
  return child
}

beforeEach(() => {
  spawn.mockReset()
  spawn.mockImplementation(() => fakeChild())
})

const base = { timeoutMs: 5_000, cwd: '/tmp/wt', env: { PATH: '/bin' } }

describe('a wrapped command', () => {
  it('is spawned as its argv, with shell false, its own group and the wrap’s environment', async () => {
    const out = await Effect.runPromise(
      commandEffect({
        ...base,
        run: 'pnpm test',
        ownGroup: true,
        wrapped: { argv: ['/usr/bin/bwrap', '--x', '/bin/sh', '-c', 'pnpm test'], env: { PATH: '/bin', CACHE: '/c' } },
      }),
    )
    expect(out.ok).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(1)
    const [file, args, options] = spawn.mock.calls[0]!
    expect(file).toBe('/usr/bin/bwrap')
    expect(args).toEqual(['--x', '/bin/sh', '-c', 'pnpm test'])
    expect(options).toMatchObject({
      shell: false,
      detached: true,
      cwd: '/tmp/wt',
      env: { PATH: '/bin', CACHE: '/c' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  })

  it('carries LINGTAI_RESULT on the wrap’s environment when asked, and not otherwise', async () => {
    await Effect.runPromise(
      commandEffect({
        ...base,
        run: 'x',
        ownGroup: true,
        resultPath: '/tmp/result.json',
        wrapped: { argv: ['/w', 'x'], env: { A: '1' } },
      }),
    )
    expect(spawn.mock.calls[0]![2].env).toEqual({ A: '1', LINGTAI_RESULT: '/tmp/result.json' })
  })

  it('takes a payload on stdin the same way', async () => {
    await Effect.runPromise(
      commandEffect({ ...base, run: 'x', ownGroup: true, payload: { a: 1 }, wrapped: { argv: ['/w'], env: {} } }),
    )
    expect(spawn.mock.calls[0]![2]).toMatchObject({ shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
  })
})

describe('a command with no wrap', () => {
  it('is spawned as its text through a shell, with the environment it was given, unchanged', async () => {
    await Effect.runPromise(commandEffect({ ...base, run: 'pnpm test' }))
    expect(spawn).toHaveBeenCalledWith('pnpm test', {
      shell: true,
      detached: undefined,
      cwd: '/tmp/wt',
      env: { PATH: '/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  })
})
