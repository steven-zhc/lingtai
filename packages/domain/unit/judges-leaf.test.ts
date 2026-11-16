/**
 * `judges.ts` is a leaf on purpose: the board's wizard is a client component
 * and anything it reaches that imports `@lingtai/env` drags `node:fs` into the
 * browser bundle. Only the Next build sees that (`apps/release/integration`),
 * and no ticket runs it, so this reads the source instead (#1195).
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

describe('the built-in judges leaf', () => {
  it('imports nothing and re-exports nothing', () => {
    const src = read('../src/judges.ts')
    expect(src).not.toMatch(/^\s*import\b/m)
    expect(src).not.toMatch(/\bfrom\s+['"]/)
  })

  it("is the recipe's judges.ts's only import", () => {
    const src = read('../../recipe/src/judges.ts')
    const specifiers = [...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const s of specifiers) expect(s).toBe('@lingtai/domain/judges')
  })
})
