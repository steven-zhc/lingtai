/**
 * `@lingtai/sandbox/live` is the only file that loads srt, and only `apps/cli/src` may import it (#1152): the board
 * imports the actions barrel and depends on the conductor, so `SandboxLive` provided anywhere either reaches would
 * reach the board. Read through the TypeScript AST, as the effect ratchet does, never by a regex.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

import { modulesOf } from '../test/ts-modules.ts'

const root = join(import.meta.dirname, '..', '..', '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return []
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx|mts)$/.test(name) ? [path] : []
  })
}

const roots = ['packages', 'apps'].flatMap((top) =>
  readdirSync(join(root, top)).map((name) => join(root, top, name, 'src')),
)

const importers = roots
  .filter((dir) => {
    try {
      return statSync(dir).isDirectory()
    } catch {
      return false
    }
  })
  .flatMap(sources)
  .flatMap((file) => {
    const text = readFileSync(file, 'utf8')
    if (!text.includes('sandbox/live')) return []
    return modulesOf(file, text)
      .filter((m) => m.specifier === '@lingtai/sandbox/live')
      .map((m) => ({ file: relative(root, file), line: m.line, text }))
  })

describe('@lingtai/sandbox/live', () => {
  it('is imported only under apps/cli/src, statically or dynamically', () => {
    const stray = importers.filter((i) => !i.file.startsWith('apps/cli/src/'))
    expect(stray.map((i) => `${i.file}:${i.line}`)).toEqual([])
  })

  it('is found where it is known to be, so the test cannot pass by finding nothing', () => {
    expect(importers.some((i) => i.file === 'apps/cli/src/sandbox.ts')).toBe(true)
  })
})
