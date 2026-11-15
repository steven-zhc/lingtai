/** `checkDeclared`, `sourceOf` and `sourceHashOf` (0128 §6, #1175): functions of text, nothing else asked. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { PRESETS, RecipeInvalidError, checkDeclared, resolveSource, sourceHashOf, sourceOf } from '../src/index.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const MINIMAL = 'version: 2\nrepo:\n  base: main\nsource:\n  kinds: [bug]\nenv:\n  plantAt: .env.local\n'

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
