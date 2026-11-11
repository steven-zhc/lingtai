import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { GitHubFailed, NotInstalledError } from '../src/app.ts'
import { BodyChanged, PermissionDenied } from '../src/client.ts'
import { ghTokenEffect } from '../src/gh.ts'
import type { GhRun } from '../src/gh.ts'

describe('the tagged errors', () => {
  it('GitHubFailed keeps its message rule', () => {
    const err = new GitHubFailed(404, '/x', 'Not Found')
    expect(err._tag).toBe('GitHubFailed')
    expect(err.message).toBe('404 on /x: Not Found')
    expect(err).toBeInstanceOf(Error)
    expect(new GitHubFailed(0, 'gh auth token', 'nope').message).toBe('0 on gh auth token: nope')
  })
  it('NotInstalledError and BodyChanged keep their sentences', () => {
    const n = new NotInstalledError('o', 'r')
    expect(n._tag).toBe('NotInstalled')
    expect(n.message).toMatch(/^the GitHub App is not installed on o\/r\. Install it/)
    expect(n).toBeInstanceOf(Error)
    const b = new BodyChanged(7)
    expect(b._tag).toBe('BodyChanged')
    expect(b.message).toBe("#7's body changed since it was read")
    expect(b).toBeInstanceOf(Error)
  })
  it('PermissionDenied is a GitHubFailed', () => {
    const denied = new GitHubFailed(403, '/p', 'Resource not accessible')
    const p = new PermissionDenied(denied, 'issues', 'read')
    expect(p._tag).toBe('GitHubFailed')
    expect(p).toBeInstanceOf(GitHubFailed)
    expect(p.message).toBe(
      `403 on /p: the App's \`issues\` permission at \`read\` is missing for this endpoint — the installation must grant it, or the owner must accept the App's updated permissions (${denied.message})`,
    )
  })
  it('rateLimited', () => {
    expect(new GitHubFailed(429, '/', 'x').rateLimited).toBe(true)
    expect(new GitHubFailed(403, '/', 'API rate limit exceeded').rateLimited).toBe(true)
    expect(new GitHubFailed(403, '/', 'Resource not accessible by integration').rateLimited).toBe(false)
    expect(new GitHubFailed(404, '/', 'Not Found').rateLimited).toBe(false)
  })
})

describe('ghTokenEffect', () => {
  const fail = (run: GhRun) => Effect.runPromise(Effect.flip(ghTokenEffect(run)))
  it.each([
    [async () => ({ missing: true as const }), 'gh is not installed — install the GitHub CLI and run `gh auth login`'],
    [async () => ({ code: 1, stdout: '', stderr: '' }), 'gh auth token exited 1: no output'],
    [async () => ({ code: 0, stdout: '\n', stderr: '' }), 'gh answered no token — run `gh auth login`'],
  ] as [GhRun, string][])('fails with a status-0 GitHubFailed', async (run, detail) => {
    const err = await fail(run)
    expect(err).toBeInstanceOf(GitHubFailed)
    expect(err.status).toBe(0)
    expect(err.detail).toBe(detail)
    expect(err.message).toBe(`0 on gh auth token: ${detail}`)
  })
})
