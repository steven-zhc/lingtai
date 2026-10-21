/**
 * `diffStatAt`, against real git.
 *
 * `mirror.ts`'s own comment on the function says the three dots are there so
 * that a `base` which moved after an attempt's run started does not show up
 * as reverted — two-dot would diff against `base`'s current tip and render
 * every change `base` gained since as if the attempt had undone it. The only
 * way to pin that is a real three-way merge-base, which neither half of the
 * unit suite exercises (every caller there hands `diffStatAt` a stub).
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { diffStatAt, mirrorPathFor } from '../src/index.ts'

const exec = promisify(execFile)
const g = (args: string[], cwd: string) =>
  exec('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  })

const PROJECT = `mirrortest${crypto.randomUUID().slice(0, 6)}`

let root: string
let home: string
let baseSha: string
let headSha: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'lingtai-mirror-'))
  home = join(root, 'home')

  const mirror = mirrorPathFor(PROJECT, home)
  await exec('git', ['init', '-q', '--bare', '-b', 'main', mirror])

  const work = join(root, 'work')
  await exec('git', ['init', '-q', '-b', 'main', work])
  await g(['remote', 'add', 'origin', mirror], work)

  // The merge base: one commit, pushed as `main`.
  await writeFile(join(work, 'README.md'), 'hello\n')
  await g(['add', '-A'], work)
  await g(['commit', '-qm', 'first'], work)
  await g(['push', '-q', 'origin', 'main'], work)
  const mergeBase = (await exec('git', ['rev-parse', 'HEAD'], { cwd: work })).stdout.trim()

  // `main` moves forward on its own, after the merge base — the move a
  // two-dot diff would wrongly attribute to the attempt below.
  await writeFile(join(work, 'base-only.txt'), 'base moved on\n')
  await g(['add', '-A'], work)
  await g(['commit', '-qm', 'base moves on'], work)
  await g(['push', '-q', 'origin', 'main'], work)
  baseSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: work })).stdout.trim()

  // The attempt: branched from the merge base, never from the moved `main`.
  await g(['checkout', '-q', '-b', 'attempt', mergeBase], work)
  await writeFile(join(work, 'head-only.txt'), 'the attempt\n')
  await g(['add', '-A'], work)
  await g(['commit', '-qm', 'the attempt'], work)
  await g(['push', '-q', 'origin', 'attempt'], work)
  headSha = (await exec('git', ['rev-parse', 'HEAD'], { cwd: work })).stdout.trim()
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('diffStatAt', () => {
  it('diffs from the merge base, not the base ref itself — so a base that moved on does not show up as reverted', async () => {
    const stat = await diffStatAt({ project: PROJECT, home, base: baseSha, head: headSha })

    expect(stat).not.toBeNull()
    expect(stat).toContain('head-only.txt')
    // A two-dot diff (`baseSha head`) would show `base-only.txt` as removed,
    // since the attempt's branch never had the commit that added it. Finding
    // that here is exactly the regression this test exists to catch.
    expect(stat).not.toContain('base-only.txt')
  })

  it('returns null rather than throwing when the mirror has no such ref', async () => {
    const stat = await diffStatAt({ project: PROJECT, home, base: baseSha, head: '0'.repeat(40) })

    expect(stat).toBeNull()
  })
})
