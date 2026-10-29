import { describe, expect, it } from 'vitest'

import { ghExecOptions, ghSpawnOptions, ghStatus, ghToken, scrubbedEnv, type GhRun } from '../src/gh.ts'

const TOKENS = { GH_TOKEN: 'a', GITHUB_TOKEN: 'b', GH_ENTERPRISE_TOKEN: 'c', GITHUB_ENTERPRISE_TOKEN: 'd' }

describe('scrubbedEnv', () => {
  it('drops the four token variables and keeps the rest', () => {
    const env = scrubbedEnv({ ...TOKENS, PATH: '/bin', HOME: '/h' })
    expect(env).toEqual({ PATH: '/bin', HOME: '/h' })
  })

  it('is what the live runner hands the child', () => {
    const options = ghExecOptions({ ...TOKENS, PATH: '/bin' })
    expect(options.env).toEqual({ PATH: '/bin' })
  })

  it('is what the inherited-terminal runner hands the child, with GH_TOKEN dropped', () => {
    const options = ghSpawnOptions({ ...TOKENS, PATH: '/bin' })
    expect(options.env).toEqual({ PATH: '/bin' })
    expect(options.stdio).toBe('inherit')
  })
})

describe('ghToken', () => {
  it('trims the token', async () => {
    const run: GhRun = async () => ({ code: 0, stdout: 'gho_abc\n', stderr: '' })
    expect(await ghToken(run)).toBe('gho_abc')
  })

  it('names a failure from the exit code and stderr, never stdout', async () => {
    const run: GhRun = async () => ({ code: 1, stdout: 'gho_SECRET', stderr: 'not logged in' })
    const error = await ghToken(run).catch((e: Error) => e)
    expect(String((error as Error).message)).toContain('exited 1')
    expect(String((error as Error).message)).toContain('not logged in')
    expect(String((error as Error).message)).not.toContain('gho_SECRET')
  })

  it('scrubs a token a stderr echoed', async () => {
    const run: GhRun = async () => ({ code: 1, stdout: '', stderr: 'bad gho_LEAK123 here' })
    const error = (await ghToken(run).catch((e: Error) => e)) as Error
    expect(error.message).not.toContain('gho_LEAK123')
  })

  it('names a missing gh and an empty answer', async () => {
    await expect(ghToken(async () => ({ missing: true }))).rejects.toThrow(/not installed/)
    await expect(ghToken(async () => ({ code: 0, stdout: ' \n', stderr: '' }))).rejects.toThrow(/no token/)
  })
})

describe('ghStatus', () => {
  const hosts = (entries: unknown[]) => JSON.stringify({ hosts: { 'github.com': entries } })
  const answer =
    (stdout: string, code = 0, stderr = ''): GhRun =>
    async () => ({ code, stdout, stderr })

  it('parses the active login and its scopes', async () => {
    const out = hosts([
      { state: 'success', active: false, login: 'old', scopes: 'repo' },
      { state: 'success', active: true, login: 'me', scopes: 'gist, project, read:org, repo, workflow' },
    ])
    expect(await ghStatus(answer(out))).toEqual({
      ok: true,
      login: 'me',
      scopes: ['gist', 'project', 'read:org', 'repo', 'workflow'],
    })
  })

  it('reads empty scopes as none', async () => {
    const out = hosts([{ state: 'success', active: true, login: 'me', scopes: '' }])
    expect(await ghStatus(answer(out))).toEqual({ ok: true, login: 'me', scopes: [] })
  })

  it('names missing, signed-out, no account, too old and unparsed', async () => {
    expect(await ghStatus(async () => ({ missing: true }))).toMatchObject({ ok: false, reason: 'missing' })
    expect(await ghStatus(answer(hosts([{ state: 'error', active: true, login: 'me' }]), 1))).toMatchObject({
      reason: 'signed-out',
    })
    expect(await ghStatus(answer(hosts([])))).toMatchObject({ reason: 'no-account' })
    expect(await ghStatus(answer('', 1, 'unknown flag: --json'))).toMatchObject({ reason: 'too-old' })
    expect(await ghStatus(answer('', 0))).toMatchObject({ reason: 'unparsed' })
  })
})
