/** `proposeSetup` through fake readers — nothing here touches a disk, a network or a process (0060 §1). */
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { type ProposalReaders, proposeSetup, defaultAgents } from '../src/propose-setup.ts'
import type { RuntimeFound } from '../src/runtimes.ts'
import { githubSlugOfRemote } from '../src/ticket-source.ts'

const files = (present: Record<string, string>) => ({
  has: async (p: string) => p in present,
  read: async (p: string) => present[p] ?? null,
})
const rt = (id: 'claude-code' | 'codex', signedIn: boolean): RuntimeFound => ({
  id,
  state: signedIn ? 'signed-in' : 'signed-out',
  signedIn,
  detail: '',
})
const readers = (over: Partial<ProposalReaders> = {}): ProposalReaders => ({
  setupReader: files({ 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }), 'pnpm-lock.yaml': '' }),
  defaultBranch: async () => 'main',
  runtimes: async () => [rt('claude-code', true), rt('codex', true)],
  history: async () => [],
  origin: async () => 'git@github.com:acme/widget.git',
  ...over,
})
const run = (t: Parameters<typeof proposeSetup>[0], r: ProposalReaders) => Effect.runPromise(proposeSetup(t, r))

describe('proposeSetup', () => {
  it('proposes for a GitHub slug, with the four-kind default and no person approving the merge', async () => {
    const p = await run({ kind: 'github', owner: 'acme', repo: 'widget' }, readers())
    expect(p.base).toMatchObject({ known: true, value: 'main' })
    expect(p.install).toMatchObject({ known: true, value: 'pnpm install --frozen-lockfile' })
    expect(p.tickets).toMatchObject({
      known: true,
      value: { source: 'github', repository: { owner: 'acme', repo: 'widget' } },
    })
    expect(p.kinds).toMatchObject({ known: true, value: ['bug', 'feature', 'tech-debt', 'documentation'] })
    expect(p.writer).toMatchObject({ value: 'claude-code' })
    expect(p.reviewer).toMatchObject({ value: 'codex' })
    expect(p.personApprovesMerge).toBe(false)
  })

  it('a local path with a GitHub origin proposes that remote’s issues — while add --local still writes db', async () => {
    const p = await run({ kind: 'local', path: '/w/widget' }, readers())
    expect(p.tickets).toMatchObject({
      known: true,
      value: { source: 'github', repository: { owner: 'acme', repo: 'widget' } },
    })
  })

  it('a local path whose origin is not GitHub, or that has none, proposes local tickets', async () => {
    for (const origin of ['https://gitlab.com/acme/widget.git', null]) {
      const p = await run({ kind: 'local', path: '/w/widget' }, readers({ origin: async () => origin }))
      expect(p.tickets).toMatchObject({ known: true, value: { source: 'db', repository: null } })
    }
  })

  it('history keeps its source and still names the origin repository', async () => {
    const p = await run({ kind: 'local', path: '/w/widget' }, readers({ history: async () => ['ticket-widget-1'] }))
    expect(p.tickets).toMatchObject({
      known: true,
      value: { source: 'github', repository: { owner: 'acme', repo: 'widget' } },
    })
    const q = await run({ kind: 'local', path: '/w/widget' }, readers({ history: async () => ['db ticket #3'] }))
    expect(q.tickets).toMatchObject({ known: true, value: { source: 'db' } })
  })

  it('a history that cannot be read is unknown, never "no history"', async () => {
    const p = await run(
      { kind: 'local', path: '/w/widget' },
      readers({ history: async () => Promise.reject(new Error('store down')) }),
    )
    expect(p.tickets).toMatchObject({ known: false, reason: 'store down', default: { source: 'db' } })
    expect(p.base.known).toBe(true)
  })

  it('a repository that cannot be read is unknown on the lines it feeds, and the rest still propose', async () => {
    const boom = { has: async () => Promise.reject(new Error('403 from GitHub')), read: async () => null }
    const p = await run({ kind: 'github', owner: 'acme', repo: 'widget' }, readers({ setupReader: boom }))
    expect(p.install).toMatchObject({ known: false, default: null })
    expect(p.checks.known).toBe(false)
    expect((p.install as { reason: string }).reason).toContain('403 from GitHub')
    expect(p.runtimes.known).toBe(true)
    expect(p.kinds.known).toBe(true)
  })

  it('a runtime probe that fails is unknown for the runtimes and the agents', async () => {
    const p = await run(
      { kind: 'github', owner: 'acme', repo: 'widget' },
      readers({ runtimes: async () => Promise.reject(new Error('auth check hung')) }),
    )
    expect(p.runtimes).toMatchObject({ known: false, reason: 'auth check hung' })
    expect(p.reviewer.known).toBe(false)
  })

  it('no runtime signed in says how to sign in', async () => {
    const p = await run(
      { kind: 'github', owner: 'acme', repo: 'widget' },
      readers({ runtimes: async () => [rt('claude-code', false), rt('codex', false)] }),
    )
    expect(p.runtimes.known && p.runtimes.value[0]?.remedy).toContain('sign in')
    expect(p.writer).toMatchObject({ known: true, value: null })
  })
})

describe('defaultAgents', () => {
  it('prefers a different signed-in runtime as reviewer, else the writer', () => {
    expect(defaultAgents(['claude-code', 'codex'])).toEqual({ writer: 'claude-code', reviewer: 'codex' })
    expect(defaultAgents(['codex'])).toEqual({ writer: 'codex', reviewer: 'codex' })
    expect(defaultAgents([])).toEqual({ writer: null, reviewer: null })
  })
})

describe('githubSlugOfRemote', () => {
  it('reads the three GitHub shapes and nothing else', () => {
    const want = { owner: 'o', repo: 'r' }
    expect(githubSlugOfRemote('https://github.com/o/r.git')).toEqual(want)
    expect(githubSlugOfRemote('https://github.com/o/r')).toEqual(want)
    expect(githubSlugOfRemote('git@github.com:o/r.git')).toEqual(want)
    expect(githubSlugOfRemote('ssh://git@github.com/o/r')).toEqual(want)
    expect(githubSlugOfRemote('https://gitlab.com/o/r')).toBeNull()
  })
})
