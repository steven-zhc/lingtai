/**
 * `@lingtai/recipe` reads no file and asks no host (0128 §8, #1172): what does moved to `@lingtai/project`.
 *
 * Held to the package's own imports — `@lingtai/env` still pulls `node:fs` in beneath it, and that is out of
 * scope. Imports are read with the TypeScript parser, as `packages/domain/test/ts-modules.ts` does. Reading
 * the source is the filesystem, which 0060 §1 would call integration; this stays in `unit/` as
 * `effect-ratchet.test.ts` does with its own source reads.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src')
const FORBIDDEN = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises', '@lingtai/sandbox/host'])

const specifiers = (file: string): string[] => {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const out: string[] = []
  source.forEachChild((node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      out.push((node.moduleSpecifier as ts.StringLiteral).text)
    }
  })
  return out
}

describe('@lingtai/recipe imports no file system and no host read', () => {
  it('in any of its sources', () => {
    const found = readdirSync(SRC)
      .filter((name) => name.endsWith('.ts'))
      .flatMap((name) =>
        specifiers(join(SRC, name))
          .filter((s) => FORBIDDEN.has(s))
          .map((s) => `${name} imports ${s}`),
      )
    expect(found).toEqual([])
  })
})
