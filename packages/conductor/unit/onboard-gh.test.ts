/**
 * `checkGhAccess` and `add()` on a `gh` machine (#708, ADR 0114 §8): the saved
 * login's scopes and `permissions.push` stand where the App's installation
 * does, and each refusal names its own cause.
 */
import { GitHubError, type GhStatus } from '@lingtai/github'
import { describe, expect, it, vi } from 'vitest'

import { add, checkGhAccess, type GhAccessDeps } from '../src/onboard.ts'

const SLUG = 'acme/widgets'
const SIGNED_IN: GhStatus = { ok: true, login: 'sam', scopes: ['repo', 'workflow', 'read:org'] }

function run(status: GhStatus, repository: GhAccessDeps['repository']) {
  const lines: string[] = []
  const repo = vi.fn(repository)
  return {
    lines,
    repo,
    result: () => checkGhAccess(SLUG, (l) => lines.push(l), { status: async () => status, repository: repo }),
  }
}

describe('checkGhAccess (#708)', () => {
  it('passes a login with both scopes that can push, and returns the default branch', async () => {
    const t = run(SIGNED_IN, async () => ({ permissions: { push: true }, default_branch: 'trunk' }))
    expect(await t.result()).toEqual({ login: 'sam', defaultBranch: 'trunk' })
    expect(t.lines).toEqual([])
  })

  it('names the refresh command when only workflow is missing, and reads nothing', async () => {
    const t = run({ ok: true, login: 'sam', scopes: ['repo'] }, async () => ({ permissions: { push: true } }))
    expect(await t.result()).toBeNull()
    expect(t.lines.join('\n')).toContain('gh auth refresh --hostname github.com --scopes workflow')
    expect(t.repo).not.toHaveBeenCalled()
  })

  it('names a missing repo scope before the repository is read', async () => {
    const t = run({ ok: true, login: 'sam', scopes: ['workflow'] }, async () => ({}))
    expect(await t.result()).toBeNull()
    expect(t.lines.join('\n')).toContain('--scopes repo')
    expect(t.repo).not.toHaveBeenCalled()
  })

  it('names a signed-out gh with gh auth login', async () => {
    const t = run({ ok: false, reason: 'signed-out', detail: 'gh is signed out of github.com' }, async () => ({}))
    expect(await t.result()).toBeNull()
    expect(t.lines.join('\n')).toMatch(/signed out.*gh auth login/)
  })

  it('refuses a login that cannot push', async () => {
    const t = run(SIGNED_IN, async () => ({ permissions: { push: false } }))
    expect(await t.result()).toBeNull()
    expect(t.lines.join('\n')).toContain('cannot push to acme/widgets')
  })

  it('says archived, ahead of push, when the response says archived', async () => {
    const t = run(SIGNED_IN, async () => ({ archived: true, permissions: { push: true } }))
    expect(await t.result()).toBeNull()
    expect(t.lines.join('\n')).toContain('archived')
  })

  it('names a 404 as not visible', async () => {
    const t = run(SIGNED_IN, async () => {
      throw new GitHubError(404, '/repos/acme/widgets', 'Not Found')
    })
    expect(await t.result()).toBeNull()
    expect(t.lines.join('\n')).toContain('not visible to sam')
  })

  it("names an organisation's OAuth-app restriction and names the App as the fix", async () => {
    const t = run(SIGNED_IN, async () => {
      throw new GitHubError(
        403,
        '/repos/acme/widgets',
        'Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions',
      )
    })
    expect(await t.result()).toBeNull()
    const said = t.lines.join('\n')
    expect(said).toContain('blocks the GitHub CLI')
    expect(said).toContain('--github-auth app')
  })

  it('names SAML enforcement and says to authorise the token', async () => {
    const t = run(SIGNED_IN, async () => {
      throw new GitHubError(403, '/repos/acme/widgets', 'Resource protected by organization SAML enforcement.')
    })
    expect(await t.result()).toBeNull()
    expect(t.lines.join('\n')).toMatch(/SAML.*authorise gh's token for the acme organisation/)
  })

  it("quotes any other 403's own message", async () => {
    const t = run(SIGNED_IN, async () => {
      throw new GitHubError(403, '/repos/acme/widgets', 'API rate limit exceeded')
    })
    expect(await t.result()).toBeNull()
    expect(t.lines.join('\n')).toContain('API rate limit exceeded')
  })

  it('names a network failure as that, never as no access', async () => {
    const t = run(SIGNED_IN, async () => {
      throw new TypeError('fetch failed')
    })
    expect(await t.result()).toBeNull()
    const said = t.lines.join('\n')
    expect(said).toContain('could not read acme/widgets')
    expect(said).not.toMatch(/not visible|cannot push/)
  })
})

describe('add on a gh machine (#708)', () => {
  it('refuses with checkInstallation never called when the gh check refuses', async () => {
    const check = vi.fn()
    const code = await add({ slug: SLUG }, () => {}, {
      auth: () => 'gh',
      checkGh: async () => null,
      check,
    })
    expect(code).toBe(1)
    expect(check).not.toHaveBeenCalled()
  })

  it('on an App machine asks checkInstallation and never gh', async () => {
    const checkGh = vi.fn()
    const code = await add({ slug: SLUG }, () => {}, {
      auth: () => 'app',
      checkGh,
      check: async () => null,
    })
    expect(code).toBe(1)
    expect(checkGh).not.toHaveBeenCalled()
  })
})
