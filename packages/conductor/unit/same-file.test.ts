import { describe, expect, it } from 'vitest'

import { collision, fixFiles, waitsFor } from '../src/same-file.ts'

const row = (cell: string) => `| | |\n|---|---|\n| **Problem** | \`x/y.ts\` |\n| **Fix** | ${cell} |\n`

describe('fixFiles', () => {
  it('takes backticked paths and extensions from the Fix row, and strips :line', () => {
    expect(fixFiles(row('see `packages/a/b.ts:12` and `work-loop.ts` then `pnpm test` in `src/`'))).toEqual([
      'packages/a/b.ts',
      'work-loop.ts',
      'src/',
    ])
  })
  it('names nothing without a Fix row, and ignores other rows', () => {
    expect(fixFiles('| **Problem** | `a/b.ts` |')).toEqual([])
    expect(fixFiles(row('no files here'))).toEqual([])
  })
})

describe('collision', () => {
  it('equal paths, or a bare name against the last segment', () => {
    expect(collision(['a/b.ts'], ['a/b.ts'])).toEqual({ file: 'a/b.ts' })
    expect(collision(['b.ts'], ['a/b.ts'])).toEqual({ file: 'a/b.ts' })
    expect(collision(['a/b.ts'], ['c/b.ts'])).toBeNull()
  })
  it('an empty list collides with nothing', () => {
    expect(collision([], ['a/b.ts'])).toBeNull()
    expect(waitsFor([], [{ issue: '1', files: ['a/b.ts'] }])).toBeNull()
  })
  it('an unread list collides with everything', () => {
    expect(waitsFor(null, [{ issue: '1', files: [] }])).toContain('#1')
  })
})
