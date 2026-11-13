import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { RepoFailed } from '../src/git.ts'
import { isRemoteError, isRemoteErrorFailure, isUnreachable, remoteErrorRef, retryUnreachable } from '../src/network.ts'

describe('isUnreachable', () => {
  it.each([
    "fatal: unable to access 'https://github.com/steven-zhc/lingtai.git/': Recv failure: Operation timed out",
    "fatal: unable to access 'https://github.com/x/y.git/'",
    'fatal: Could not resolve host: github.com',
    'fatal: Could not connect to server',
    'fatal: Failed to connect to github.com port 443',
    'Operation timed out',
    'Connection timed out',
    'Connection reset by peer',
    'Connection refused',
    'Recv failure',
    'Send failure',
    'fatal: early EOF',
    'error: RPC failed; HTTP 500',
    'The requested URL returned error: 503',
    'fatal: the remote end hung up unexpectedly',
    'SSL_ERROR_SYSCALL in connection to github.com:443',
    'gnutls_handshake() failed',
    'CONNECTION REFUSED',
  ])('is true for %s', (text) => expect(isUnreachable(text)).toBe(true))

  it.each([
    '! [rejected] HEAD -> main (non-fast-forward)',
    "unable to access 'x': The requested URL returned error: 403\n! [rejected] HEAD -> main (fetch first)",
    "unable to access 'x'\nremote: error: GH006: Protected branch update failed",
    'remote: GH013: Repository rule violations found Connection reset',
    'CONFLICT (content): Merge conflict in a.ts',
    "fatal: couldn't find remote ref refs/heads/x",
    'The requested URL returned error: 403',
    '',
    "fatal: impossible d'accéder à 'https://github.com/x/y.git/' : délai d'attente dépassé",
  ])('is false for %j', (text) => expect(isUnreachable(text)).toBe(false))
})

describe('retryUnreachable', () => {
  const timeout = new RepoFailed({ operation: 'git push', detail: "unable to access 'x': Operation timed out" })
  const flaky = (failures: number, err: RepoFailed = timeout) => {
    let calls = 0
    const effect = Effect.suspend(() => (calls++ < failures ? Effect.fail(err) : Effect.succeed('ok')))
    return { effect, calls: () => calls }
  }
  const waits = ['0 millis', '0 millis'] as const

  it('retries and succeeds within three tries', async () => {
    const f = flaky(2)
    await expect(Effect.runPromise(retryUnreachable(f.effect, waits))).resolves.toBe('ok')
    expect(f.calls()).toBe(3)
  })

  it('fails with the last error, naming the tries, when they run out', async () => {
    const f = flaky(10)
    const err = await Effect.runPromise(Effect.flip(retryUnreachable(f.effect, waits)))
    expect(f.calls()).toBe(3)
    expect(err.detail).toContain('(after 3 tries)')
  })

  it('does not retry another failure', async () => {
    const other = new RepoFailed({ operation: 'git push', detail: '! [rejected] (non-fast-forward)' })
    const f = flaky(10, other)
    const err = await Effect.runPromise(Effect.flip(retryUnreachable(f.effect, waits)))
    expect(f.calls()).toBe(1)
    expect(err.detail).toBe(other.detail)
  })

  it('reads stderr when present', async () => {
    const f = flaky(1, new RepoFailed({ operation: 'git push', detail: 'Command failed', stderr: 'Connection reset' }))
    await expect(Effect.runPromise(retryUnreachable(f.effect, waits))).resolves.toBe('ok')
  })
})

describe('isRemoteError (#1125)', () => {
  it.each(['Internal Server Error', 'Bad Gateway', 'Service Unavailable', 'Gateway Timeout'])(
    'is true for a remote rejected line answered %s',
    (reason) => expect(isRemoteError(` ! [remote rejected]   HEAD -> agent/1068 (${reason})`)).toBe(true),
  )

  it.each([
    ' ! [remote rejected]   HEAD -> main (protected branch hook declined)',
    ' ! [remote rejected]   HEAD -> main (pre-receive hook declined)',
    ' ! [remote rejected]   HEAD -> main (failed to update ref)',
    ' ! [rejected]          HEAD -> main (non-fast-forward)',
    'remote: Internal Server Error',
    '',
  ])('is false for %j', (text) => expect(isRemoteError(text)).toBe(false))

  it('reads detail alone after the tries have been appended', () => {
    const err = new RepoFailed({
      operation: 'git push',
      detail:
        'remote: Internal Server Error\n ! [remote rejected]   HEAD -> agent/1068 (Internal Server Error) (after 3 tries)',
    })
    expect(isRemoteErrorFailure(err)).toBe(true)
  })

  it('names the ref git printed', () => {
    expect(remoteErrorRef(' ! [remote rejected]   HEAD -> refs/heads/agent/1068 (Bad Gateway)')).toBe('agent/1068')
    expect(remoteErrorRef('nothing')).toBeNull()
  })

  const fiveHundred = new RepoFailed({
    operation: 'git push',
    detail: ' ! [remote rejected]   HEAD -> agent/1068 (Internal Server Error)',
  })
  const flaky = (failures: number) => {
    let calls = 0
    return {
      effect: Effect.suspend(() => (calls++ < failures ? Effect.fail(fiveHundred) : Effect.succeed('ok'))),
      calls: () => calls,
    }
  }
  const waits = ['0 millis', '0 millis'] as const

  it('retryUnreachable retries it and succeeds within three tries', async () => {
    const f = flaky(2)
    await expect(Effect.runPromise(retryUnreachable(f.effect, waits))).resolves.toBe('ok')
    expect(f.calls()).toBe(3)
  })

  it('retryUnreachable names the tries when they run out', async () => {
    const f = flaky(10)
    const err = await Effect.runPromise(Effect.flip(retryUnreachable(f.effect, waits)))
    expect(f.calls()).toBe(3)
    expect(err.detail).toContain('(after 3 tries)')
    expect(isRemoteErrorFailure(err)).toBe(true)
  })
})
