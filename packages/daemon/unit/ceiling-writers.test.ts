/**
 * 0126 §4: the system locks are written by one module. `ceilingCheck` builds the
 * events the guard appends, and `raiseTransition` the one a person's raise
 * appends; no other file under `apps/` or a package's `src` calls either, so
 * nothing else can append a `DayCeilingReached` or a `DayCeilingLifted`, and
 * nothing writes a ceiling `ConductorPaused` any more (#1004).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (/\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

const files = [
  ...sources(join(root, 'apps')).filter((f) => !/\/(unit|integration|test)\//.test(f)),
  ...readdirSync(join(root, 'packages')).flatMap((p) => {
    try {
      return sources(join(root, 'packages', p, 'src'))
    } catch {
      return []
    }
  }),
]

const callers = (pattern: RegExp): string[] =>
  files
    .filter((f) => pattern.test(readFileSync(f, 'utf8')))
    .map((f) => relative(root, f))
    .sort()

describe('who writes the ceiling lock', () => {
  it('calls ceilingCheck only in the guard (and defines it in ceiling-lock)', () => {
    expect(callers(/\bceilingCheck\(/)).toEqual(['packages/daemon/src/guard.ts', 'packages/domain/src/ceiling-lock.ts'])
  })

  it('calls raiseTransition only in raiseDayCeiling (and defines it in ceiling-lock)', () => {
    expect(callers(/\braiseTransition\(/)).toEqual([
      'packages/daemon/src/control.ts',
      'packages/domain/src/ceiling-lock.ts',
    ])
  })

  it('writes no ceiling ConductorPaused', () => {
    expect(callers(/cause:\s*'day-ceiling'/).filter((f) => f !== 'packages/domain/src/control.ts')).toEqual([])
  })
})
