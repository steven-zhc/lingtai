/** The recipe's `sandbox:` block (#1147): no spawn, no disk, no `HOME` — the host is a counting fake. */
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  RecipeInvalidError,
  SANDBOX_REQUIRED_REFUSAL,
  isSandboxRequiredRefusal,
  recipePath,
  resolveLocalRecipeEffect,
  sandboxDecision,
} from '../src/index.ts'
import { fakeFacts, fakeSandboxHost, type FakeSandboxHost } from '../test/sandbox-host.ts'

const STATE = '/home/me/.lingtai'

const RECIPE = `version: 2
repo:
  base: main
source:
  kinds: [bug]
env:
  plantAt: .env.local
steps:
  proposed:
    - name: build
      run: pnpm test
`

const resolveWith = (block: string | undefined, host: FakeSandboxHost) =>
  Effect.runPromise(
    resolveLocalRecipeEffect('app', {
      home: STATE,
      signedIn: async () => ['claude-code'],
      read: async (p) => (p === recipePath('app', STATE) ? `${RECIPE}${block ?? ''}` : null),
      ...host,
    }),
  )

const refusal = async (block: string, host = fakeSandboxHost()): Promise<string> => {
  const error = await resolveWith(block, host).then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(RecipeInvalidError)
  return (error as RecipeInvalidError).problems.join('\n')
}

describe('a recipe without `sandbox` is the recipe it was', () => {
  // Recorded before #1147 was wired in (the schema without the key): an absent optional key must leave the hash as it is.
  const BEFORE = '3e1f53e6ab1e70903558914d1dd6c4ee707d70aed99f9df870171b1e59d1d12a'

  it('hashes as it did, and asks the host nothing', async () => {
    const host = fakeSandboxHost()
    const resolved = await resolveWith(undefined, host)
    expect(resolved.recipe.sandbox).toBeUndefined()
    expect(resolved.configHash).toBe(BEFORE)
    expect(host.asked).toEqual({ host: 0, facts: 0 })
  })

  it('a block is part of the hash, and the defaults are inside it', async () => {
    const resolved = await resolveWith('sandbox:\n  network: { allow: [pypi.org] }\n', fakeSandboxHost())
    expect(resolved.recipe.sandbox).toEqual({
      enabled: true,
      required: false,
      network: { allow: ['pypi.org'] },
      write: [],
      deny: [],
    })
    expect(resolved.configHash).not.toBe(BEFORE)
  })

  it('keeps a path as written, so the hash does not depend on the machine', async () => {
    const a = await resolveWith('sandbox:\n  write: [~/work/fixtures]\n', fakeSandboxHost())
    const b = await resolveWith(
      'sandbox:\n  write: [~/work/fixtures]\n',
      fakeSandboxHost({ facts: fakeFacts({ home: '/Users/other', stateDir: '/Users/other/.lingtai' }) }),
    )
    expect(a.recipe.sandbox?.write).toEqual(['~/work/fixtures'])
    expect(b.configHash).toBe(a.configHash)
  })
})

describe('what the text alone refuses', () => {
  it.each([
    ['a relative path', 'write: [work/fixtures]', 'sandbox.write.0: "work/fixtures" is a relative path'],
    ['a relative deny', 'deny: [./secrets]', 'sandbox.deny.0: "./secrets" is a relative path'],
    ['~user/', 'write: ["~root/x"]', 'sandbox.write.0: "~root/x" is a relative path'],
    ['a scheme', 'network: { allow: ["https://pypi.org"] }', 'sandbox.network.allow.0: "https://pypi.org"'],
    ['a port', 'network: { allow: ["pypi.org:443"] }', 'sandbox.network.allow.0: "pypi.org:443"'],
    ['a path', 'network: { allow: ["pypi.org/simple"] }', 'sandbox.network.allow.0: "pypi.org/simple"'],
    ['a second wildcard', 'network: { allow: ["*.*.org"] }', 'sandbox.network.allow.0: "*.*.org"'],
    ['a wildcard over a top-level domain', 'network: { allow: ["*.com"] }', 'sandbox.network.allow.0: "*.com"'],
    ['a name with no dot', 'network: { allow: [intranet] }', 'sandbox.network.allow.0: "intranet"'],
    ['a bare *', 'network: { allow: ["*"] }', 'sandbox.network.allow.0: "*"'],
    ['a key it does not know', 'network: { alow: [pypi.org] }', 'sandbox.network'],
  ])('%s', async (_name, line, sentence) => {
    const host = fakeSandboxHost()
    expect(await refusal(`sandbox:\n  ${line}\n`, host)).toContain(sentence)
    expect(host.asked.host).toBe(0)
  })

  it('enabled: false with required: true requires what it turns off', async () => {
    const host = fakeSandboxHost({ can: false })
    expect(await refusal('sandbox:\n  enabled: false\n  required: true\n', host)).toContain(
      'sandbox.required: required: true requires a sandbox that enabled: false turns off',
    )
    expect(host.asked.host).toBe(0)
  })

  it('refuses null for a flag', async () => {
    expect(await refusal('sandbox:\n  enabled: null\n')).toContain('sandbox.enabled')
  })

  it('accepts a hostname, a *. hostname and a path outside everything protected', async () => {
    const resolved = await resolveWith(
      'sandbox:\n  network: { allow: [pypi.org, "*.pythonhosted.org"] }\n  write: [~/work/fixtures, /srv/fixtures]\n  deny: [~/work/secrets]\n',
      fakeSandboxHost(),
    )
    expect(resolved.recipe.sandbox?.network.allow).toEqual(['pypi.org', '*.pythonhosted.org'])
  })
})

describe('what the host refuses: a path that is, lies inside or contains a protected one', () => {
  const darwin = fakeFacts({ platform: 'darwin' })
  const pnpm = fakeFacts({ pnpmHome: '/opt/pnpm' })

  it.each([
    ['/', 'contains /home/me'],
    ['/usr', 'contains /usr/bin'],
    ['/usr/local/bin', 'is /usr/local/bin (path)'],
    ['/home/me', 'is /home/me (home)'],
    ['~', 'is /home/me (home)'],
    ['~/.ssh', 'is /home/me/.ssh (deny-list)'],
    ['~/.ssh/keys', 'lies inside /home/me/.ssh (deny-list)'],
    ['~/.lingtai', 'is /home/me/.lingtai (state-dir)'],
    ['~/.lingtai/repos/app.git', '(mirror)'],
    ['~/.lingtai/worktrees/app/run', 'lies inside /home/me/.lingtai (state-dir)'],
    ['~/.claude', 'is /home/me/.claude (runtime-config)'],
    ['~/.codex/sessions', 'lies inside /home/me/.codex (runtime-config)'],
    ['~/.cache', 'is /home/me/.cache (host-tool)'],
    ['~/.local/share', 'lies inside /home/me/.local (host-tool)'],
    ['~/.config/**', 'contains /home/me/.config/gh (deny-list)'],
  ])('write: %s', async (path, sentence) => {
    expect(await refusal(`sandbox:\n  write: ["${path}"]\n`)).toContain(sentence)
  })

  it('write: $PNPM_HOME, and what lies inside it', async () => {
    const block = 'sandbox:\n  write: [/opt/pnpm/store]\n'
    expect(await refusal(block, fakeSandboxHost({ facts: pnpm }))).toContain('lies inside /opt/pnpm (host-tool)')
  })

  it('write: ~/Library on macOS, and not on linux', async () => {
    const block = 'sandbox:\n  write: [~/Library/Caches]\n'
    expect(await refusal(block, fakeSandboxHost({ facts: darwin }))).toContain('lies inside /home/me/Library')
    await expect(resolveWith(block, fakeSandboxHost())).resolves.toBeDefined()
  })

  it.each([
    ['~/.lingtai/worktrees/app/sub', 'lies inside /home/me/.lingtai (state-dir)'],
    ['~/.lingtai/repos/app.git/refs', '(mirror)'],
    ['~/.ssh/id', 'lies inside /home/me/.ssh (deny-list)'],
  ])('deny: %s', async (path, sentence) => {
    expect(await refusal(`sandbox:\n  deny: ["${path}"]\n`)).toContain(sentence)
  })

  it('names every problem at once, with its own index', async () => {
    const said = await refusal('sandbox:\n  write: [~/work/ok, ~/.ssh, /usr]\n')
    expect(said).toContain('sandbox.write.1: "~/.ssh"')
    expect(said).toContain('sandbox.write.2: "/usr"')
    expect(said).not.toContain('sandbox.write.0')
  })

  it('a list that cannot be checked is refused, never accepted', async () => {
    const host = fakeSandboxHost()
    const said = await refusal('sandbox:\n  write: [~/work/ok]\n', {
      ...host,
      hostFacts: Effect.die(new Error('secret detail')),
    })
    expect(said).toContain('sandbox.write: these paths could not be checked')
    expect(said).not.toContain('secret detail')
  })

  it('reads the facts only for a block that names a path', async () => {
    const host = fakeSandboxHost()
    await resolveWith('sandbox:\n  required: false\n', host)
    expect(host.asked.facts).toBe(0)
    await resolveWith('sandbox:\n  write: [~/work/ok]\n', host)
    expect(host.asked.facts).toBe(1)
  })
})

describe('a host that cannot provide a sandbox the recipe requires', () => {
  it('refuses the recipe at sandbox.required, with srt’s own sentences', async () => {
    const host = fakeSandboxHost({
      can: false,
      reason: 'host dependencies are missing',
      sentences: ['bwrap not found'],
    })
    const said = await refusal('sandbox:\n  required: true\n', host)
    expect(said).toContain('sandbox.required: this recipe requires a sandbox and this machine cannot provide one')
    expect(said).toContain('host dependencies are missing; bwrap not found')
    expect(host.asked.host).toBe(1)
  })

  it('carries no project name and no digit that varies', async () => {
    const said = await refusal('sandbox:\n  required: true\n', fakeSandboxHost({ can: false }))
    expect(said).not.toMatch(/\d/)
    expect(said).not.toContain('app')
  })

  it('treats a check that cannot be read as cannot, and never says why', async () => {
    const said = await refusal(
      'sandbox:\n  required: true\n',
      fakeSandboxHost({ defect: new Error('spawn ENOENT /secret/path') }),
    )
    expect(said).toContain('the host check could not be read')
    expect(said).not.toContain('ENOENT')
  })

  it('is not asked for required: false, an absent block, or enabled: false', async () => {
    const host = fakeSandboxHost({ can: false })
    await resolveWith('sandbox:\n  required: false\n', host)
    await resolveWith('sandbox:\n  enabled: false\n', host)
    await resolveWith(undefined, host)
    expect(host.asked.host).toBe(0)
  })

  it('resolves when the host can', async () => {
    const host = fakeSandboxHost({ can: true })
    await expect(resolveWith('sandbox:\n  required: true\n', host)).resolves.toBeDefined()
    expect(host.asked.host).toBe(1)
  })

  it('is not asked when saving', async () => {
    const host = fakeSandboxHost({ can: false })
    await expect(
      Effect.runPromise(
        resolveLocalRecipeEffect('app', {
          home: STATE,
          signedIn: async () => ['claude-code'],
          read: async (p) => (p === recipePath('app', STATE) ? `${RECIPE}sandbox:\n  required: true\n` : null),
          host: 'skip',
          hostFacts: host.hostFacts,
        }),
      ),
    ).resolves.toBeDefined()
    expect(host.asked.host).toBe(0)
  })
})

describe('sandboxDecision', () => {
  const block = {
    enabled: true,
    required: false,
    network: { allow: ['pypi.org'] },
    write: ['~/work/fixtures'],
    deny: ['/srv/secrets'],
  }
  const cannot = { can: false, reason: 'host dependencies are missing', sentences: ['bwrap not found'] } as const

  it('off by choice: no block, or enabled: false', () => {
    expect(sandboxDecision(undefined, { can: true }, '/home/me')).toEqual({
      kind: 'unsandboxed',
      reason: 'off by choice',
    })
    expect(sandboxDecision({ ...block, enabled: false }, cannot, '/home/me')).toEqual({
      kind: 'unsandboxed',
      reason: 'off by choice',
    })
  })

  it('sandboxed: the recipe’s lists with ~ expanded, for S3 to add to the built-ins', () => {
    expect(sandboxDecision(block, { can: true }, '/home/me')).toEqual({
      kind: 'sandboxed',
      project_additions: { network: ['pypi.org'], write: ['/home/me/work/fixtures'], deny: ['/srv/secrets'] },
    })
  })

  it('degraded: the host cannot and the recipe does not require it, with S3’s sentence', () => {
    expect(sandboxDecision(block, cannot, '/home/me')).toEqual({
      kind: 'unsandboxed',
      reason: 'degraded',
      why: 'host dependencies are missing; bwrap not found',
    })
  })

  it('refused: the host cannot and the recipe requires it', () => {
    expect(sandboxDecision({ ...block, required: true }, cannot, '/home/me')).toEqual({
      kind: 'refused',
      why: 'host dependencies are missing; bwrap not found',
    })
  })
})

describe('isSandboxRequiredRefusal (#1163)', () => {
  it('recognises the refusal checkSandboxBlock gives, with anything before or after it', () => {
    const detail = `recipe ~/x.yml is invalid:\n  - ${SANDBOX_REQUIRED_REFUSAL} (srt is not installed) — install what is missing`
    expect(isSandboxRequiredRefusal(detail)).toBe(true)
    expect(isSandboxRequiredRefusal(SANDBOX_REQUIRED_REFUSAL)).toBe(true)
  })

  it('does not take a path refusal or another problem for it', () => {
    expect(isSandboxRequiredRefusal('sandbox.write: these paths could not be checked, because x')).toBe(false)
    expect(isSandboxRequiredRefusal('source.kinds: must not be empty')).toBe(false)
    expect(isSandboxRequiredRefusal('')).toBe(false)
  })
})
