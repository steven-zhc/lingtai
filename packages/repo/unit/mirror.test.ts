import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { RepoFailed, gitEffect } from '../src/git.ts'
import { conflictedPathsAt } from '../src/mirror.ts'

vi.mock('../src/git.ts', async () => ({
  ...(await vi.importActual<typeof import('../src/git.ts')>('../src/git.ts')),
  gitEffect: vi.fn(),
}))

const oid = 'a'.repeat(40)
const tree = 'b'.repeat(40)
const stages = `${tree}\0${[1, 2, 3].map((stage) => `100644 ${oid} ${stage}\ta.ts\0`).join('')}`

describe('conflictedPathsAt', () => {
  it('refuses an oversized merged file even when all stage blobs are readable', async () => {
    vi.mocked(gitEffect).mockImplementation((args) => {
      if (args[0] === '--version') return Effect.succeed('git version 2.40.0')
      if (args[0] === 'merge-tree') return Effect.succeed(stages)
      if (args[0] === 'show') {
        return Effect.fail(
          new RepoFailed({ operation: 'git show', detail: 'stdout maxBuffer length exceeded', exitCode: null }),
        )
      }
      if (args[0] === 'cat-file') return Effect.succeed('readable stage blob')
      return Effect.fail(new RepoFailed({ operation: 'git', detail: `unexpected git command: ${args[0]}` }))
    })

    await expect(conflictedPathsAt({ project: 'test', baseSha: oid, headSha: oid })).rejects.toThrow(
      'stdout maxBuffer length exceeded',
    )
  })

  it('keeps the one-hunk fallback when the merged tree has no copy of the path', async () => {
    vi.mocked(gitEffect).mockImplementation((args) => {
      if (args[0] === '--version') return Effect.succeed('git version 2.40.0')
      if (args[0] === 'merge-tree') return Effect.succeed(stages)
      if (args[0] === 'show') {
        return Effect.fail(
          new RepoFailed({
            operation: 'git show',
            detail: 'path absent',
            exitCode: 128,
            stderr: `fatal: path 'a.ts' does not exist in '${tree}'`,
          }),
        )
      }
      if (args[0] === 'cat-file') return Effect.succeed('readable stage blob')
      return Effect.fail(new RepoFailed({ operation: 'git', detail: `unexpected git command: ${args[0]}` }))
    })

    const paths = await conflictedPathsAt({ project: 'test', baseSha: oid, headSha: oid })
    expect(paths).toMatchObject([{ path: 'a.ts', hunks: 1, hunkLines: [1], base: 'readable stage blob' }])
  })
})
