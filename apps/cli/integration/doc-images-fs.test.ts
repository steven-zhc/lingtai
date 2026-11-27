/**
 * `nodeFs.write` against a real directory (#1469): the filesystem is a
 * dependency outside the system, so this is the integration half.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { nodeFs } from '../src/doc-images.ts'

let dir: string
let root: string
let outside: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'doc-images-'))
  root = join(dir, 'doc')
  outside = join(dir, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const bytes = new Uint8Array([1, 2, 3])

describe('nodeFs.write', () => {
  it('writes a new file, makes directories, leaves no temporary name', async () => {
    expect(await nodeFs(root).write('a/b/c.png', bytes)).toBe('written')
    expect([...readFileSync(join(root, 'a/b/c.png'))]).toEqual([1, 2, 3])
    expect(readdirSync(join(root, 'a/b'))).toEqual(['c.png'])
  })

  it('writes a name at the filesystem limit, which a longer temporary name would break', async () => {
    const name = `${'a'.repeat(220)}.png`
    expect(await nodeFs(root).write(name, bytes)).toBe('written')
    expect(readdirSync(root)).toEqual([name])
  })

  it('never overwrites a regular file', async () => {
    writeFileSync(join(root, 'x.png'), 'old')
    expect(await nodeFs(root).write('x.png', bytes)).toBe('exists')
    expect(readFileSync(join(root, 'x.png'), 'utf8')).toBe('old')
    expect(readdirSync(root)).toEqual(['x.png'])
  })

  it('fails, rather than skips, when a parent is a regular file', async () => {
    writeFileSync(join(root, 'parent'), 'file')
    await expect(nodeFs(root).write('parent/a.png', bytes)).rejects.toThrow()
  })

  it('fails, rather than skips, when the destination is a directory', async () => {
    mkdirSync(join(root, 'directory.png'))
    await expect(nodeFs(root).write('directory.png', bytes)).rejects.toThrow()
    expect(readdirSync(join(root, 'directory.png'))).toEqual([])
  })

  it('refuses to write through a symlinked directory', async () => {
    symlinkSync(outside, join(root, 'img'))
    await expect(nodeFs(root).write('img/a.png', bytes)).rejects.toThrow()
    expect(readdirSync(outside)).toEqual([])
  })
})
