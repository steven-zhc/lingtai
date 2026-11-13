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

  it('a runs/ that cannot be listed fails rather than finding none', async () => {
    const fs: ClaudeDirFs = {
      readdir: async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      },
      rm: async () => {},
    }
    await expect(Effect.runPromise(findOrphanClaudeDirsEffect({ home: '/h', fs }))).rejects.toBeDefined()
  })

  it('a run directory that cannot be listed fails rather than finding none', async () => {
    const { fs: base } = fake(tree)
    const fs: ClaudeDirFs = {
      ...base,
      readdir: async (p) => {
        if (p === '/h/runs/r1') throw Object.assign(new Error('EIO'), { code: 'EIO' })
        return base.readdir(p)
      },
    }
    await expect(Effect.runPromise(findOrphanClaudeDirsEffect({ home: '/h', fs }))).rejects.toBeDefined()
  })
})
