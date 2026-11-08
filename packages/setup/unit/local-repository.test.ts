import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { type LocalPorts, readLocalRepository } from '../src/local-repository.ts'

const ports = (
  over: { kind?: 'directory' | 'file' | 'missing'; git?: Record<string, string | null> } = {},
): LocalPorts => ({
  home: '/home/me',
  stat: () => Effect.succeed(over.kind ?? 'directory'),
  git: (_cwd, args) => {
    const out = (over.git ?? {})[args.join(' ')]
    return Effect.succeed(out === undefined || out === null ? { ok: false, out: 'fatal: nope' } : { ok: true, out })
  },
})
const read = (input: string, p: LocalPorts) => Effect.runSync(readLocalRepository(input, p))
const repo = {
  'rev-parse --show-toplevel': '/work/widget\n',
  'branch --show-current': 'main\n',
  'remote get-url origin': 'git@github.com:acme/widget.git\n',
}

describe('readLocalRepository', () => {
  it('reads the toplevel, branch and a github remote', () => {
    expect(read('/work/widget/src/..', ports({ git: repo }))).toEqual({
      ok: true,
      path: '/work/widget',
      branch: 'main',
      remote: 'git@github.com:acme/widget.git',
      github: 'acme/widget',
    })
  })
  it('expands a leading ~ and refuses a relative path', () => {
    expect(read('~/x', ports({ kind: 'missing' }))).toEqual({ ok: false, why: '/home/me/x does not exist' })
    expect(read('x/y', ports())).toMatchObject({ ok: false })
  })
  it('says a file is not a directory', () => {
    expect(read('/a', ports({ kind: 'file' }))).toEqual({ ok: false, why: '/a is not a directory' })
  })
  it('says a directory that is not a repository', () => {
    expect(read('/a', ports())).toEqual({ ok: false, why: '/a is not a git repository — fatal: nope' })
  })
  it('accepts a repository with no remote', () => {
    const r = read('/work/widget', ports({ git: { ...repo, 'remote get-url origin': null } }))
    expect(r).toMatchObject({ ok: true, remote: null, github: null })
  })
  it('strips credentials from another host and reports a detached head', () => {
    const r = read(
      '/work/widget',
      ports({
        git: { ...repo, 'branch --show-current': '', 'remote get-url origin': 'https://u:tok@git.example.com/a/b.git' },
      }),
    )
    expect(r).toMatchObject({ ok: true, branch: null, remote: 'https://git.example.com/a/b.git', github: null })
  })
})
