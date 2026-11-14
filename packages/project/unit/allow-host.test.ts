import { type RecipeFiles, withAllowedHost } from '@lingtai/recipe'
import { fakeSandboxHost } from '@lingtai/recipe/test/sandbox-host'
/** `withAllowedHost` (#1162): the editor's draft, pure, and what saving it does. */
import { describe, expect, it } from 'vitest'

import { recipePath, saveRecipeText } from '../src/index.ts'

const HOME = '/home/me/.lingtai'
const PATH = recipePath('app', HOME)
const GOOD = `# mine
version: 2
repo:
  base: main
source:
  kinds: [bug]   # priority
env:
  plantAt: .env.local
steps:
  proposed:
    - name: build
      run: pnpm test
`
const WITH_BLOCK =
  GOOD +
  `sandbox:
  network:
    allow:
      - example.org  # already
`

describe('withAllowedHost', () => {
  it('creates the block when it is absent and keeps the comments', () => {
    const out = withAllowedHost(GOOD, 'registry.example.com')
    expect(out).toContain('# mine')
    expect(out).toContain('# priority')
    expect(out).toMatch(/sandbox:\s+network:\s+allow:\s+- registry\.example\.com/)
  })

  it('appends to an existing list, comments kept', () => {
    const out = withAllowedHost(WITH_BLOCK, 'cdn.example.com')!
    expect(out).toContain('# already')
    expect(out).toContain('- cdn.example.com')
  })

  it('does not append twice, and drafts nothing for a host the recipe would refuse', () => {
    expect(withAllowedHost(WITH_BLOCK, 'example.org')).toBeNull()
    expect(withAllowedHost(GOOD, 'not a host')).toBeNull()
    expect(withAllowedHost(GOOD, '169.254.169.254')).toBeNull()
    expect(withAllowedHost('a: [', 'example.org')).toBeNull()
  })

  it('a prefilled Save succeeds: loaded is the file’s bytes, text is the draft', async () => {
    const store = new Map([[PATH, GOOD]])
    const files: RecipeFiles = {
      read: async (p) => store.get(p) ?? null,
      replace: async (p, text) => void store.set(p, text),
    }
    const draft = withAllowedHost(GOOD, 'registry.example.com')!
    // Drafting wrote nothing.
    expect(store.get(PATH)).toBe(GOOD)
    const result = await saveRecipeText(
      'app',
      { loaded: GOOD, text: draft },
      {
        home: HOME,
        files,
        base: 'main',
        signedIn: async () => ['claude-code' as const],
        hostFacts: fakeSandboxHost().hostFacts,
      },
    )
    expect(result).toMatchObject({ ok: true, written: true })
    expect(store.get(PATH)).toBe(draft)
  })
})
