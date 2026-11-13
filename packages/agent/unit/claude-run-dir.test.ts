import { Effect, Exit, Scope } from 'effect'
import { describe, expect, it } from 'vitest'

import { prepareClaudeRunDirectory, type RunDirFs, type RunDirStat } from '../src/index.ts'

const TOKEN = 'sk-ant-oat01-FAKE-0000'

type Node = { kind: 'dir' } | { kind: 'file'; data: string } | { kind: 'link'; to: string }

/** An in-memory tree. Paths are absolute strings; links name another path. */
function fake(initial: Record<string, Node>) {
  const nodes = new Map(Object.entries(initial))
  const removed: string[] = []
  const err = (code: string) => Object.assign(new Error(code), { code })
  const st = (n: Node): RunDirStat => ({
    isDirectory: () => n.kind === 'dir',
    isFile: () => n.kind === 'file',
    isSymbolicLink: () => n.kind === 'link',
  })
  /** Follows a link at any segment, so `/op/.claude/skills/a.md` finds `/elsewhere/skills/a.md`. */
  const resolve = (p: string): string | null => {
    let cur = ''
    for (const seg of p.split('/').filter(Boolean)) {
      cur = `${cur}/${seg}`
      for (let i = 0; i < 20 && nodes.get(cur)?.kind === 'link'; i++) cur = (nodes.get(cur) as { to: string }).to
    }
    return nodes.has(cur) ? cur : null
  }
  const fs: RunDirFs = {
    lstat: (p) => {
      const dirOnly = resolve(p.slice(0, p.lastIndexOf('/')) || '/')
      const n =
        dirOnly === null ? undefined : nodes.get(`${dirOnly === '/' ? '' : dirOnly}${p.slice(p.lastIndexOf('/'))}`)
      return n ? Effect.succeed(st(n)) : Effect.fail(err('ENOENT'))
    },
    stat: (p) => {
      const r = resolve(p)
      return r ? Effect.succeed(st(nodes.get(r)!)) : Effect.fail(err('ENOENT'))
    },
    realpath: (p) => {
      const r = resolve(p)
      return r ? Effect.succeed(r) : Effect.fail(err('ENOENT'))
    },
    readdir: (p) => {
      const base = resolve(p) ?? p
      const prefix = `${base}/`
      return Effect.succeed(
        [...nodes.keys()]
          .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
          .map((k) => k.slice(prefix.length)),
      )
    },
    readFile: (p) => {
      const n = nodes.get(resolve(p) ?? p)
      if (n?.kind !== 'file') return Effect.fail(err('EACCES'))
      return Effect.succeed(new TextEncoder().encode(n.data))
    },
    writeFile: (p, data) => {
      nodes.set(p, { kind: 'file', data: typeof data === 'string' ? data : new TextDecoder().decode(data) })
      return Effect.void
    },
    mkdir: (p, o) => {
      if (nodes.has(p) && !o.recursive) return Effect.fail(err('EEXIST'))
      nodes.set(p, { kind: 'dir' })
      return Effect.void
    },
    rm: (p) => {
      removed.push(p)
      for (const k of Array.from(nodes.keys()).filter((key) => key === p || key.startsWith(`${p}/`))) nodes.delete(k)
      return Effect.void
    },
  }
  return { fs, nodes, removed }
}

const SRC = '/op/.claude'
const DIR = '/home/runs/r1/claude'
const run = <A, E>(e: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.exit(Effect.scoped(e)))

describe('prepareClaudeRunDirectory', () => {
  it('writes settings, copies the three items with links dereferenced, and removes the directory at close', async () => {
    const f = fake({
      [SRC]: { kind: 'dir' },
      [`${SRC}/CLAUDE.md`]: { kind: 'file', data: 'rules' },
      [`${SRC}/skills`]: { kind: 'link', to: '/elsewhere/skills' },
      '/elsewhere/skills': { kind: 'dir' },
      '/elsewhere/skills/a.md': { kind: 'file', data: 'skill a' },
      [`${SRC}/commands`]: { kind: 'dir' },
    })
    const seen: Record<string, Node | undefined> = {}
    const scope = Effect.runSync(Scope.make())
    const trace: string[] = []
    await Effect.runPromise(
      Scope.provide(scope)(
        prepareClaudeRunDirectory(DIR, { source: SRC, settings: { hooks: {} }, trace: (l) => trace.push(l) }, f.fs),
      ),
    )
    for (const k of ['settings.json', 'CLAUDE.md', 'skills', 'skills/a.md', 'agents', 'commands'])
      seen[k] = f.nodes.get(`${DIR}/${k}`)
    expect(seen['settings.json']).toMatchObject({ kind: 'file' })
    expect(seen['CLAUDE.md']).toEqual({ kind: 'file', data: 'rules' })
    expect(seen['skills']).toEqual({ kind: 'dir' })
    expect(seen['skills/a.md']).toEqual({ kind: 'file', data: 'skill a' })
    expect(seen['agents']).toBeUndefined()
    expect(seen['commands']).toBeUndefined()
    expect([...f.nodes.values()].some((n) => n.kind === 'link' && f.nodes.get(`${DIR}/skills`) === n)).toBe(false)
    expect(f.removed).toEqual([])
    await Effect.runPromise(Scope.close(scope, Exit.void))
    expect(f.removed).toEqual([DIR])
    expect(f.nodes.has(`${DIR}/settings.json`)).toBe(false)
  })

  it('skips a dangling link with one trace line, and removes the directory on failure', async () => {
    const f = fake({
      [SRC]: { kind: 'dir' },
      [`${SRC}/skills`]: { kind: 'link', to: '/gone' },
      [`${SRC}/agents`]: { kind: 'dir' },
      [`${SRC}/agents/loop`]: { kind: 'link', to: `${SRC}/agents` },
    })
    const trace: string[] = []
    const exit = await run(
      prepareClaudeRunDirectory(DIR, { source: SRC, settings: {}, trace: (l) => trace.push(l) }, f.fs),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(trace).toEqual([`skipped a dangling link: ${SRC}/skills`])
    expect(JSON.stringify(exit)).toContain('link loop')
    expect(f.removed).toEqual([DIR])
  })

  it('fails by name on an unreadable item, without its contents', async () => {
    const f = fake({ [SRC]: { kind: 'dir' }, [`${SRC}/CLAUDE.md`]: { kind: 'file', data: TOKEN } })
    f.fs.readFile = () => Effect.fail(Object.assign(new Error(`bad ${TOKEN}`), { code: 'EACCES' }))
    const exit = await run(prepareClaudeRunDirectory(DIR, { source: SRC, settings: {}, trace: () => {} }, f.fs))
    expect(Exit.isFailure(exit)).toBe(true)
    const text = JSON.stringify(exit)
    expect(text).toContain(`${SRC}/CLAUDE.md`)
    expect(text).toContain('EACCES')
    expect(text).not.toContain(TOKEN)
    expect(f.removed).toEqual([DIR])
  })

  it('refuses a directory that exists and never removes it', async () => {
    const f = fake({ [SRC]: { kind: 'dir' }, [DIR]: { kind: 'dir' }, [`${DIR}/mine`]: { kind: 'file', data: 'x' } })
    const exit = await run(prepareClaudeRunDirectory(DIR, { source: SRC, settings: {}, trace: () => {} }, f.fs))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain('already exists')
    expect(f.removed).toEqual([])
    expect(f.nodes.has(`${DIR}/mine`)).toBe(true)
  })

  it('traces a failed removal and does not fail', async () => {
    const f = fake({ [SRC]: { kind: 'dir' } })
    f.fs.rm = () => Effect.fail(Object.assign(new Error(`nope ${TOKEN}`), { code: 'EBUSY' }))
    const trace: string[] = []
    const exit = await run(
      prepareClaudeRunDirectory(DIR, { source: SRC, settings: {}, trace: (l) => trace.push(l) }, f.fs),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(trace).toEqual([`could not remove ${DIR}: EBUSY`])
  })

  it('fails by name when skills is a file or CLAUDE.md is a directory', async () => {
    const a = fake({ [SRC]: { kind: 'dir' }, [`${SRC}/skills`]: { kind: 'file', data: 'x' } })
    const ea = await run(prepareClaudeRunDirectory(DIR, { source: SRC, settings: {}, trace: () => {} }, a.fs))
    expect(Exit.isFailure(ea)).toBe(true)
    expect(JSON.stringify(ea)).toContain('must be a directory')
    const b = fake({ [SRC]: { kind: 'dir' }, [`${SRC}/CLAUDE.md`]: { kind: 'dir' } })
    const eb = await run(prepareClaudeRunDirectory(DIR, { source: SRC, settings: {}, trace: () => {} }, b.fs))
    expect(Exit.isFailure(eb)).toBe(true)
    expect(JSON.stringify(eb)).toContain('must be a file')
  })

  it('keeps the execute bit of a copied file', async () => {
    const f = fake({
      [SRC]: { kind: 'dir' },
      [`${SRC}/skills`]: { kind: 'dir' },
      [`${SRC}/skills/run.sh`]: { kind: 'file', data: '#!/bin/sh' },
      [`${SRC}/skills/a.md`]: { kind: 'file', data: 'a' },
    })
    const modes: Record<string, number> = {}
    const base = f.fs
    const fs: RunDirFs = {
      ...base,
      stat: (p) => base.stat(p).pipe(Effect.map((s) => ({ ...s, mode: p.endsWith('run.sh') ? 0o755 : 0o644 }))),
      lstat: (p) => base.lstat(p).pipe(Effect.map((s) => ({ ...s, mode: p.endsWith('run.sh') ? 0o755 : 0o644 }))),
      writeFile: (p, d, m) => {
        modes[p] = m
        return base.writeFile(p, d, m)
      },
    }
    await run(prepareClaudeRunDirectory(DIR, { source: SRC, settings: {}, trace: () => {} }, fs))
    expect(modes[`${DIR}/skills/run.sh`]).toBe(0o700)
    expect(modes[`${DIR}/skills/a.md`]).toBe(0o600)
  })
})
