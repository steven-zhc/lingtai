import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { type ClaudeDirFs, findOrphanClaudeDirsEffect } from '../src/reconcile.ts'

function fake(tree: Record<string, readonly { name: string; dir: boolean }[]>) {
  const removed: string[] = []
  const fs: ClaudeDirFs = {
    readdir: async (p) => {
      const entries = tree[p]
      if (!entries) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return entries.map((e) => ({ name: e.name, isDirectory: () => e.dir }))
    },
    rm: async (p) => {
      removed.push(p)
    },
  }
  return { fs, removed }
}

const tree = {
  '/h/runs': [
    { name: 'proj', dir: true },
    { name: 'r1', dir: true },
    { name: 'r2', dir: true },
    { name: 'stray.log', dir: false },
  ],
  '/h/runs/r1': [
    { name: 'settings.json', dir: false },
    { name: 'claude', dir: true },
  ],
  '/h/runs/r2': [{ name: 'settings.json', dir: false }],
  '/h/runs/proj': [{ name: 'r1.log', dir: false }],
}

describe('findOrphanClaudeDirsEffect', () => {
  it('finds only runs/<runId>/claude directories, as a removal when not a dry run', async () => {
    const { fs } = fake(tree)
    const found = await Effect.runPromise(findOrphanClaudeDirsEffect({ home: '/h', fs }))
    expect(found.map((f) => [f.stream, f.path, f.action])).toEqual([['r1', '/h/runs/r1/claude', 'removed']])
  })

  it('a missing runs/ is no finding', async () => {
    const { fs } = fake({})
    expect(await Effect.runPromise(findOrphanClaudeDirsEffect({ home: '/h', fs }))).toEqual([])
  })
})
