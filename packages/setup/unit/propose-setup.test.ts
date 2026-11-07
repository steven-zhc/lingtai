import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { githubRepositoryOf, type ProposalReaders, proposeSetup, type SetupTarget } from '../src/propose-setup.ts'
import type { RuntimeFound } from '../src/runtimes.ts'

const signedIn: RuntimeFound = { id: 'claude-code', state: 'signed-in', signedIn: true, detail: 'ok' }

const files: Record<string, string> = { 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }) }

function readers(over: Partial<ProposalReaders> = {}): ProposalReaders {
  return {
    base: () => Effect.succeed('main'),
    reader: () => ({ has: async (p) => p in files, read: async (p) => files[p] ?? null }),
    runtimes: () => Effect.succeed([signedIn]),
    history: () => Effect.succeed([]),
    origin: () => Effect.succeed(null),
    ...over,
  }
}

const slug: SetupTarget = { kind: 'github', owner: 'o', repo: 'r' }
const local: SetupTarget = { kind: 'local', path: '/work/thing' }
const run = (t: SetupTarget, r: ProposalReaders) => Effect.runPromise(proposeSetup(t, r))

describe('githubRepositoryOf', () => {
  it.each([
    ['https://github.com/o/r', 'o/r'],
    ['https://github.com/o/r.git', 'o/r'],
    ['git@github.com:o/r.git', 'o/r'],
    ['ssh://git@github.com/o/r.git', 'o/r'],
    ['https://gitlab.com/o/r', null],
    ['git@github.com.evil.io:o/r', null],
  ])('%s', (url, want) => expect(githubRepositoryOf(url)).toBe(want))
})

describe('proposeSetup', () => {
  it('a GitHub slug proposes every line, with four kinds, no approval and github tickets', async () => {
    const p = await run(slug, readers())
    expect(p.base).toEqual({ state: 'detected', value: 'main', from: 'GitHub' })
    expect(p.setup.state).toBe('detected')
    expect(p.kinds).toEqual({ state: 'default', value: ['bug', 'feature', 'tech-debt', 'documentation'] })
    expect(p.approve).toEqual({ state: 'default', value: false })
    expect(p.tickets).toMatchObject({ state: 'detected', value: { source: 'github', repository: 'o/r' } })
    expect(p.reviewer).toMatchObject({ state: 'detected', value: 'claude-code' })
  })

  it('a local path with a GitHub origin takes that repository’s issues', async () => {
    const p = await run(local, readers({ origin: () => Effect.succeed('git@github.com:a/b.git') }))
    expect(p.tickets).toMatchObject({ value: { source: 'github', repository: 'a/b' } })
  })

  it('a local path with no origin, or one off GitHub, gets local tickets', async () => {
    const none = await run(local, readers())
    expect(none.tickets).toMatchObject({ value: { source: 'db' }, from: 'no origin remote' })
    const other = await run(local, readers({ origin: () => Effect.succeed('https://gitlab.com/a/b') }))
    expect(other.tickets).toMatchObject({ value: { source: 'db' }, from: 'origin is not on GitHub' })
  })

  it('history wins over the origin', async () => {
    const p = await run(
      local,
      readers({
        history: () => Effect.succeed(['db ticket #1']),
        origin: () => Effect.succeed('git@github.com:a/b.git'),
      }),
    )
    expect(p.tickets).toMatchObject({ value: { source: 'db' } })
  })

  it('no runtime signed in is a detected line with reviewer none', async () => {
    const out: RuntimeFound = { ...signedIn, state: 'signed-out', signedIn: false }
    const p = await run(slug, readers({ runtimes: () => Effect.succeed([out]) }))
    expect(p.runtimes.state).toBe('detected')
    expect(p.reviewer).toMatchObject({ value: 'none' })
  })

  const failing: [string, Partial<ProposalReaders>, (keyof Awaited<ReturnType<typeof run>>)[]][] = [
    ['base', { base: () => Effect.fail(new Error('boom')) }, ['base']],
    ['runtimes', { runtimes: () => Effect.fail(new Error('boom')) }, ['runtimes', 'reviewer']],
    ['history', { history: () => Effect.fail(new Error('boom')) }, ['tickets']],
    [
      'the repository',
      { reader: () => ({ has: async () => Promise.reject(new Error('boom')), read: async () => null }) },
      [],
    ],
  ]
  it.each(failing)('a failing %s reader makes only its own lines unknown', async (_n, over, unknown) => {
    const p = await run(slug, readers(over))
    for (const key of ['base', 'setup', 'runtimes', 'reviewer', 'tickets'] as const) {
      expect(p[key].state === 'unknown', key).toBe(unknown.includes(key))
    }
    for (const key of unknown) expect(JSON.stringify(p[key])).toContain('boom')
  })

  it('a failing origin read is unknown, not db', async () => {
    const p = await run(local, readers({ origin: () => Effect.fail(new Error('no git')) }))
    expect(p.tickets).toMatchObject({ state: 'unknown' })
  })
})
