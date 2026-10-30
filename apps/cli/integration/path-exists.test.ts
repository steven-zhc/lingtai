import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { pathExists } from '../src/first-project.ts'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) {
    chmodSync(join(dir, 'locked'), 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('pathExists', () => {
  it('is false for a path that is not there', async () => {
    expect(await pathExists(join(tmpdir(), 'lingtai-path-exists-gone'))).toBe(false)
  })

  it.skipIf(process.getuid?.() === 0)('is true for a directory beneath a parent that cannot be traversed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lingtai-path-exists-'))
    made.push(root)
    mkdirSync(join(root, 'locked', 'repo'), { recursive: true })
    chmodSync(join(root, 'locked'), 0o000)

    expect(await pathExists(join(root, 'locked', 'repo'))).toBe(true)
  })
})
