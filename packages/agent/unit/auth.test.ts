import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  claudeAuthThenStore,
  classifyClaudeAuth,
  classifyCodexLogin,
  expiryFromCredentials,
  reportedVersion,
  withStoredExpiry,
  type ProbeEnd,
  type StoredExpiry,
} from '../src/auth.ts'

const exited = (code: number | null, out: string, signal: NodeJS.Signals | null = null): ProbeEnd => ({
  kind: 'exited',
  code,
  signal,
  out,
  err: '',
})
const ENOENT: ProbeEnd = { kind: 'spawn-error', code: 'ENOENT', message: 'spawn codex ENOENT' }

describe('classifyCodexLogin', () => {
  it('exit 0 is signed in', () => {
    expect(classifyCodexLogin(exited(0, 'Logged in using ChatGPT'))).toMatchObject({
      state: 'signed-in',
      loggedIn: true,
    })
  })
  it('exit 1 saying not logged in is signed out', () => {
    expect(classifyCodexLogin(exited(1, 'Not logged in'))).toMatchObject({ state: 'signed-out', loggedIn: false })
  })
  it('exit 1 with other output does not start', () => {
    expect(classifyCodexLogin(exited(1, 'something else')).state).toBe('did-not-start')
  })
  it('an abort by signal does not start, and keeps what it printed', () => {
    const got = classifyCodexLogin(exited(null, 'dyld[1]: Library not loaded: libllhttp', 'SIGABRT'))
    expect(got.state).toBe('did-not-start')
    expect(got.detail).toContain('Library not loaded')
  })
  it('a timeout does not start', () => {
    expect(classifyCodexLogin({ kind: 'timeout' })).toMatchObject({ state: 'did-not-start', loggedIn: false })
  })
  it('ENOENT is not installed; another spawn error does not start', () => {
    expect(classifyCodexLogin(ENOENT).state).toBe('not-installed')
    expect(classifyCodexLogin({ kind: 'spawn-error', code: 'EACCES', message: 'spawn codex EACCES' }).state).toBe(
      'did-not-start',
    )
  })
})

describe('classifyClaudeAuth', () => {
  it('parsed loggedIn true is signed in', () => {
    expect(classifyClaudeAuth(exited(0, '{"loggedIn":true,"authMethod":"claude.ai"}'))).toMatchObject({
      state: 'signed-in',
      method: 'claude.ai',
    })
  })
  it('parsed loggedIn false is signed out, past a leading warning line', () => {
    expect(classifyClaudeAuth(exited(0, 'warning\n{"loggedIn":false,"authMethod":"none"}')).state).toBe('signed-out')
  })
  it('JSON that says neither is not told to sign in', () => {
    expect(classifyClaudeAuth(exited(0, '{"authMethod":"none"}')).state).toBe('did-not-start')
  })
  it('no JSON and bad JSON do not start', () => {
    expect(classifyClaudeAuth(exited(1, 'boom')).state).toBe('did-not-start')
    expect(classifyClaudeAuth(exited(0, '{nope')).state).toBe('did-not-start')
  })
  it('ENOENT is not installed', () => {
    expect(classifyClaudeAuth({ ...ENOENT, message: 'spawn claude ENOENT' }).state).toBe('not-installed')
  })
})

describe('reportedVersion (#929)', () => {
  it('is the first line as the runtime printed it', () => {
    expect(reportedVersion(exited(0, '2.1.318 (Claude Code)\n'))).toBe('2.1.318 (Claude Code)')
    expect(reportedVersion(exited(0, 'codex-cli 0.164.0\n'))).toBe('codex-cli 0.164.0')
  })
  it('skips blank lines and caps at 200 characters', () => {
    expect(reportedVersion(exited(0, '\n  \n 1.2.3 \nnext'))).toBe('1.2.3')
    expect(reportedVersion(exited(0, 'v'.repeat(500)))).toBe('v'.repeat(200))
  })
  it('is null for anything that is not a clean exit with output', () => {
    expect(reportedVersion(exited(1, '1.2.3'))).toBeNull()
    expect(reportedVersion(exited(null, '1.2.3', 'SIGABRT'))).toBeNull()
    expect(reportedVersion({ kind: 'timeout' })).toBeNull()
    expect(reportedVersion(ENOENT)).toBeNull()
    expect(reportedVersion(exited(0, ''))).toBeNull()
    expect(reportedVersion(exited(0, '  \n\n'))).toBeNull()
  })
  it('never answers with stderr', () => {
    expect(reportedVersion({ kind: 'exited', code: 0, signal: null, out: '', err: '9.9.9' })).toBeNull()
  })
})

describe('withStoredExpiry and the order it is asked in', () => {
  const NOW = 1_800_000_000_000
  const signedIn = exited(0, '{"loggedIn":true,"authMethod":"claude.ai"}')
  const judge = (end: ProbeEnd, stored: StoredExpiry) => withStoredExpiry(classifyClaudeAuth(end), stored, NOW)

  it('a future expiry stays signed in', () => {
    expect(judge(signedIn, { kind: 'expires', at: NOW + 1, from: 'file' }).state).toBe('signed-in')
  })
  it('a past expiry is signed out and says to sign in again', () => {
    const got = judge(signedIn, { kind: 'expires', at: NOW, from: 'keychain' })
    expect(got).toMatchObject({ state: 'signed-out', loggedIn: false })
    expect(got.detail).toContain(new Date(NOW).toISOString())
    expect(got.detail).toContain('/login')
  })
  it('an unreadable store keeps the answer', () => {
    expect(judge(signedIn, { kind: 'unreadable', why: 'x' })).toEqual(classifyClaudeAuth(signedIn))
  })
  it('another auth method keeps the answer', () => {
    const key = exited(0, '{"loggedIn":true,"authMethod":"api_key"}')
    expect(judge(key, { kind: 'expires', at: 1, from: 'file' }).state).toBe('signed-in')
  })
  it('signed out and unreadable output keep their answers', () => {
    for (const end of [exited(0, '{"loggedIn":false,"authMethod":"none"}'), exited(0, 'nope')]) {
      expect(judge(end, { kind: 'expires', at: 1, from: 'file' })).toEqual(classifyClaudeAuth(end))
    }
  })
  it('asks the store only after a signed-in answer', async () => {
    const calls: string[] = []
    const store = Effect.sync((): StoredExpiry => {
      calls.push('store')
      return { kind: 'expires', at: 1, from: 'file' }
    })
    const ask = (end: ProbeEnd) =>
      Effect.sync(() => {
        calls.push('status')
        return end
      })
    const out = await Effect.runPromise(claudeAuthThenStore(ask(signedIn), store, () => NOW))
    expect(calls).toEqual(['status', 'store'])
    expect(out.state).toBe('signed-out')
    calls.length = 0
    await Effect.runPromise(claudeAuthThenStore(ask(exited(0, '{"loggedIn":false}')), store, () => NOW))
    expect(calls).toEqual(['status'])
  })
  it('never carries a token', () => {
    const blob = '{"claudeAiOauth":{"accessToken":"sk-ant-SECRET-a","refreshToken":"sk-ant-SECRET-r","expiresAt":5}}'
    const at = expiryFromCredentials(blob)
    expect(at).toBe(5)
    const got = judge(signedIn, { kind: 'expires', at: at ?? 0, from: 'keychain' })
    expect(JSON.stringify(got)).not.toContain('SECRET')
    expect(expiryFromCredentials('{"accessToken":"sk-ant-SECRET-a" nope')).toBeNull()
  })
})
