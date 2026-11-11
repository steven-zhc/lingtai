import { EventEmitter } from 'node:events'

import { Effect, Fiber } from 'effect'
import { describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  signal: undefined as AbortSignal | undefined,
  child: undefined as (EventEmitter & { exitCode: number | null; signalCode: string | null }) | undefined,
  cb: undefined as ((err: unknown, stdout: string, stderr: string) => void) | undefined,
}))

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], opts: { signal: AbortSignal }, cb: typeof fake.cb) => {
    fake.signal = opts.signal
    fake.cb = cb
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })
    fake.child = child
    return child
  }),
}))

import { RepoFailed, git, gitEffect } from '../src/git.ts'

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('gitEffect', () => {
  it('aborts the signal on interrupt and holds the fiber until the child has closed', async () => {
    const fiber = Effect.runFork(gitEffect(['fetch']))
    await tick()
    expect(fake.signal?.aborted).toBe(false)
    let done = false
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber)).then(() => (done = true))
    await tick()
    expect(fake.signal?.aborted).toBe(true)
    expect(done).toBe(false)
    fake.child!.emit('close', null, 'SIGTERM')
    await interrupted
    expect(done).toBe(true)
  })

  it('fails with the exit code, stdout and stderr; message is detail; the face rejects with it', async () => {
    const failure = Object.assign(new Error('Command failed: git merge\nboom'), { code: 1 })
    const effect = Effect.runPromise(Effect.flip(gitEffect(['merge'])))
    await tick()
    fake.cb!(failure, 'out', 'boom')
    const err = await effect
    expect(err).toBeInstanceOf(RepoFailed)
    expect(err).toMatchObject({ exitCode: 1, stdout: 'out', stderr: 'boom', operation: 'git merge' })
    expect(err.message).toBe(err.detail)
    expect(err.detail).toBe('Command failed: git merge\nboom')

    const face = git(['merge'])
    await tick()
    fake.cb!(failure, 'out', 'boom')
    await expect(face).rejects.toMatchObject({ _tag: 'RepoFailed', exitCode: 1, message: err.detail })
  })

  it('reads a string error code as no exit code', async () => {
    const effect = Effect.runPromise(Effect.flip(gitEffect(['status'])))
    await tick()
    fake.cb!(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }), '', '')
    expect((await effect).exitCode).toBeNull()
  })
})

describe('gitEffect, a synchronous execFile throw', () => {
  it('is a RepoFailed, not a defect', async () => {
    const cp = await import('node:child_process')
    vi.mocked(cp.execFile).mockImplementationOnce((() => {
      throw new Error('spawn E2BIG')
    }) as never)
    const err = await Effect.runPromise(Effect.flip(gitEffect(['status'])))
    expect(err).toBeInstanceOf(RepoFailed)
    expect(err.detail).toBe('spawn E2BIG')
    expect(err.exitCode).toBeNull()
  })
})
