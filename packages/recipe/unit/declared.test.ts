/** `checkDeclared`, `sourceOf` and `sourceHashOf` (0128 §6, #1175): functions of text, nothing else asked. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  PRESETS,
  RecipeInvalidError,
  SANDBOX_REQUIRED_REFUSAL,
  checkDeclared,
  declaredSandbox,
  isSandboxRequiredRefusal,
  modeOf,
  parseDeclared,
  resolveSource,
  sourceHashOf,
  sourceOf,
} from '../src/index.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const MINIMAL = 'version: 2\nbranch:\n  main: main\nsource:\n  kinds: [bug]\nenv:\n  plantAt: .env.local\n'

describe('sourceOf and sourceHashOf', () => {
  it('makes every CRLF and bare CR an LF and changes nothing else', () => {
    expect(sourceOf('a: 1\r\nb: 2\rc: 3\n  # x \n')).toBe('a: 1\nb: 2\nc: 3\n  # x \n')
  })
  it('hashes CRLF and LF alike, and a changed comment differently', () => {
    expect(sourceHashOf('a: 1\r\n')).toBe(sourceHashOf('a: 1\n'))
    expect(sourceHashOf('a: 1 # x\n')).not.toBe(sourceHashOf('a: 1 # y\n'))
    expect(sourceHashOf('a')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('checkDeclared', () => {
  it('passes a recipe naming no runtime.agent', () => {
    expect(() => checkDeclared(MINIMAL, '/r.yml')).not.toThrow()
  })
  it('passes sandbox.required, which only a host can refuse', () => {
    expect(() => checkDeclared(`${MINIMAL}sandbox:\n  required: true\n`, '/r.yml')).not.toThrow()
  })
  it('applies a known preset before validating, so an empty steps: block inherits the preset’s', () => {
    expect(() => checkDeclared(`${MINIMAL}extends: pnpm-workspace\nsteps:\n`, '/r.yml')).not.toThrow()
  })

  it('passes extends: without consulting a preset', () => {
    expect(() => checkDeclared(`${MINIMAL}extends: no-such-preset\n`, '/r.yml')).not.toThrow()
  })
  it.each([
    ['invalid YAML', 'a: [\n'],
    ['a non-mapping root', '- a\n- b\n'],
    ['an empty file', ''],
    ['an unknown key', `${MINIMAL}nonsense: 1\n`],
    ['a runtime that is a list', `${MINIMAL}runtime:\n  - agent: codex\n`],
    ['a runtime that is a scalar', `${MINIMAL}runtime: codex\n`],
    ['runtime.tier', `${MINIMAL}runtime:\n  tier: open\n`],
  ])('refuses %s', (_name, text) => {
    expect(() => checkDeclared(text, '/r.yml')).toThrow(RecipeInvalidError)
  })

  it('accepts every text resolveSource accepts among the repository’s own', () => {
    const texts = [
      readFileSync(`${root}doc/examples/lingtai-recipe.yml`, 'utf8'),
      readFileSync(`${root}.lingtai/config.yaml`, 'utf8'),
      ...Object.keys(PRESETS).map((name) => `${MINIMAL}extends: ${name}\n`),
    ]
    for (const text of texts) {
      let resolves = true
      try {
        resolveSource(text, 'main', '/r.yml', (raw) => {
          raw['runtime'] = { ...(raw['runtime'] as object | null), agent: 'claude-code' }
          return []
        })
      } catch {
        resolves = false
      }
      if (resolves) expect(() => checkDeclared(text, '/r.yml')).not.toThrow()
    }
  })
})

describe('declaredSandbox (#1163)', () => {
  it('is an absent block when the key is not there, which is off by choice', () => {
    expect(declaredSandbox(MINIMAL)).toEqual({ kind: 'block', block: undefined })
  })
  it('reads an enabled block, defaults filled', () => {
    const got = declaredSandbox(`${MINIMAL}sandbox:\n  required: true\n`)
    expect(got.kind).toBe('block')
    if (got.kind === 'block') expect(got.block).toMatchObject({ enabled: true, required: true })
  })
  it('reads enabled: false as a block that is off', () => {
    const got = declaredSandbox(`${MINIMAL}sandbox:\n  enabled: false\n`)
    expect(got).toMatchObject({ kind: 'block', block: { enabled: false } })
  })
  it('is unreadable, never off, for text that is not YAML', () => {
    expect(declaredSandbox('a: [unclosed').kind).toBe('unreadable')
  })
  it('is unreadable for a root that is not a mapping', () => {
    expect(declaredSandbox('- a\n- b\n').kind).toBe('unreadable')
  })
  it('is unreadable for a block the schema refuses', () => {
    expect(declaredSandbox(`${MINIMAL}sandbox:\n  bogus: 1\n`).kind).toBe('unreadable')
    expect(declaredSandbox(`${MINIMAL}sandbox:\n  enabled: false\n  required: true\n`).kind).toBe('unreadable')
  })
})

describe('isSandboxRequiredRefusal (#1163)', () => {
  it('recognises the refusal checkSandboxBlock gives, wherever it sits in the detail', () => {
    expect(isSandboxRequiredRefusal(SANDBOX_REQUIRED_REFUSAL)).toBe(true)
    expect(
      isSandboxRequiredRefusal(`recipe /r.yml is invalid:\n  ${SANDBOX_REQUIRED_REFUSAL} (no bwrap) — install`),
    ).toBe(true)
  })
  it('does not take another refusal, nor a path refusal under sandbox', () => {
    expect(isSandboxRequiredRefusal('sandbox.write[0]: collides with a protected path')).toBe(false)
    expect(isSandboxRequiredRefusal('(root): expected a mapping')).toBe(false)
  })
})

describe('parseDeclared (#1489)', () => {
  const TEAM = `${MINIMAL.replace('main: main', 'main: main\n  personal: me/work')}mode: team\n`
  it('reads a team text', () => {
    const r = parseDeclared(TEAM)
    expect(r?.mode).toBe('team')
    expect(r?.branch.personal).toBe('me/work')
  })
  it('reads no mode as solo', () => {
    const r = parseDeclared(MINIMAL)
    expect(r).not.toBeNull()
    expect(modeOf(r!)).toBe('solo')
  })
  it('applies a known preset and keeps an unknown extends as written', () => {
    expect(parseDeclared(`extends: ${Object.keys(PRESETS)[0]}\n${TEAM}`)?.mode).toBe('team')
    expect(parseDeclared(`extends: no-such-preset\n${TEAM}`)?.mode).toBe('team')
  })
  it('does not run checkDeclared’s refusals', () => {
    expect(parseDeclared(`${TEAM}nonsense: 1\n`)?.mode).toBe('team')
  })
  it('is null for bad YAML, a non-mapping root and a schema failure', () => {
    expect(parseDeclared('a: [')).toBeNull()
    expect(parseDeclared('- a\n')).toBeNull()
    expect(parseDeclared(`${MINIMAL}mode: crew\n`)).toBeNull()
  })
})
