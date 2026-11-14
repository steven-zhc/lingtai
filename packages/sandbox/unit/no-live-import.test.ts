/** `@lingtai/sandbox/live` loads srt: only the conductor's own service may import it (#1150). */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..', '..')

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === '.next') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(name) ? [path] : []
  })

describe('no file outside the conductor imports @lingtai/sandbox/live', () => {
  it.each(['packages/agent/src', 'packages/actions/src', 'apps/board'])('%s', (where) => {
    const offenders = sources(join(root, where)).filter((f) =>
      readFileSync(f, 'utf8').includes('@lingtai/sandbox/live'),
    )
    expect(offenders).toEqual([])
  })
})
