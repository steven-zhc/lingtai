import { describe, expect, it, vi } from 'vitest'

import { git } from '../src/git.ts'
import { conflictedPathsAt } from '../src/mirror.ts'

vi.mock('../src/git.ts', () => ({ git: vi.fn() }))

const oid = 'a'.repeat(40)
const tree = 'b'.repeat(40)
const stages = `${tree}\0${[1, 2, 3].map((stage) => `100644 ${oid} ${stage}\ta.ts\0`).join('')}`

describe('conflictedPathsAt', () => {
  it('refuses an oversized merged file even when all stage blobs are readable', async () => {
    vi.mocked(git).mockImplementation(async (args) => {
      if (args[0] === '--version') return 'git version 2.40.0'
      if (args[0] === 'merge-tree') return stages
      if (args[0] === 'show') {
        throw Object.assign(new Error('stdout maxBuffer length exceeded'), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        })
      }
      if (args[0] === 'cat-file') return 'readable stage blob'
      throw new Error(`unexpected git command: ${args[0]}`)
    })

    await expect(conflictedPathsAt({ project: 'test', baseSha: oid, headSha: oid })).rejects.toThrow(
      'stdout maxBuffer length exceeded',
    )
  })

  it('keeps the one-hunk fallback when the merged tree has no copy of the path', async () => {
    vi.mocked(git).mockImplementation(async (args) => {
      if (args[0] === '--version') return 'git version 2.40.0'
      if (args[0] === 'merge-tree') return stages
      if (args[0] === 'show') {
        throw Object.assign(new Error('path absent'), {
          code: 128,
          stderr: `fatal: path 'a.ts' does not exist in '${tree}'`,
        })
      }
      if (args[0] === 'cat-file') return 'readable stage blob'
      throw new Error(`unexpected git command: ${args[0]}`)
    })

    const paths = await conflictedPathsAt({ project: 'test', baseSha: oid, headSha: oid })
    expect(paths).toMatchObject([{ path: 'a.ts', hunks: 1, hunkLines: [1], base: 'readable stage blob' }])
  })
})
