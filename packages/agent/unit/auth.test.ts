import { describe, expect, it } from 'vitest'

import { classifyClaudeAuth, classifyCodexLogin, type ProbeEnd } from '../src/auth.ts'

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
