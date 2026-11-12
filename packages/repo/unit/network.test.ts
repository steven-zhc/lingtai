import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { RepoFailed } from '../src/git.ts'
import { isUnreachable, retryUnreachable } from '../src/network.ts'

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
