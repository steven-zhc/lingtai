/** `proposeSetup` through fake readers — nothing here touches a disk, a network or a process (0060 §1). */
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { type ProposalReaders, proposeSetup, defaultAgents } from '../src/propose-setup.ts'
import type { RuntimeFound } from '../src/runtimes.ts'
import { githubSlugOfRemote } from '../src/ticket-source.ts'

const files = (present: Record<string, string>) => ({
  has: (p: string) => Effect.succeed(p in present),
  read: (p: string) => Effect.succeed(present[p] ?? null),
})
const rt = (id: 'claude-code' | 'codex', signedIn: boolean): RuntimeFound => ({
  id,
  state: signedIn ? 'signed-in' : 'signed-out',
  signedIn,
  detail: '',
})
const readers = (over: Partial<ProposalReaders> = {}): ProposalReaders => ({
  setupReader: files({ 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }), 'pnpm-lock.yaml': '' }),
  defaultBranch: () => Effect.succeed('main'),
  runtimes: () => Effect.succeed([rt('claude-code', true), rt('codex', true)]),
  history: () => Effect.succeed([]),
  origin: () => Effect.succeed('git@github.com:acme/widget.git'),
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
      const p = await run({ kind: 'local', path: '/w/widget' }, readers({ origin: () => Effect.succeed(origin) }))
      expect(p.tickets).toMatchObject({ known: true, value: { source: 'db', repository: null } })
    }
  })

  it('history keeps its source and still names the origin repository', async () => {
    const p = await run(
      { kind: 'local', path: '/w/widget' },
      readers({ history: () => Effect.succeed(['ticket-widget-1']) }),
    )
    expect(p.tickets).toMatchObject({
      known: true,
      value: { source: 'github', repository: { owner: 'acme', repo: 'widget' } },
    })
    const q = await run(
      { kind: 'local', path: '/w/widget' },
      readers({ history: () => Effect.succeed(['db ticket #3']) }),
    )
    expect(q.tickets).toMatchObject({ known: true, value: { source: 'db' } })
  })

  it('a history that cannot be read is unknown, never "no history"', async () => {
    const p = await run(
      { kind: 'local', path: '/w/widget' },
      readers({ history: () => Effect.fail(new Error('store down')) }),
    )
    expect(p.tickets).toMatchObject({ known: false, reason: 'store down', default: { source: 'db' } })
    expect(p.base.known).toBe(true)
  })

  it('a repository that cannot be read is unknown on the lines it feeds, and the rest still propose', async () => {
    const boom = { has: () => Effect.fail(new Error('403 from GitHub')), read: () => Effect.succeed(null) }
    const p = await run({ kind: 'github', owner: 'acme', repo: 'widget' }, readers({ setupReader: boom }))
    expect(p.install).toMatchObject({ known: false, default: null })
    expect(p.checks.known).toBe(false)
    expect((p.install as { reason: string }).reason).toContain('403 from GitHub')
    expect(p.runtimes.known).toBe(true)
    expect(p.kinds.known).toBe(true)
  })

  it('a read that rejects in detection is a known:false line carrying the reader’s message', async () => {
    const failing = {
      has: (path: string) => Effect.succeed(path === 'package.json'),
      read: () => Effect.fail(new Error('boom')),
    }
    const p = await run({ kind: 'github', owner: 'acme', repo: 'widget' }, readers({ setupReader: failing }))
    expect(p.install).toMatchObject({ known: false, reason: 'the repository could not be read: boom' })
  })

  it('a read that dies (a defect) is still a known:false line, never a crash', async () => {
    const dying = {
      has: (path: string) => Effect.succeed(path === 'package.json'),
      read: () => Effect.die(new Error('boom')),
    }
    const p = await run({ kind: 'github', owner: 'acme', repo: 'widget' }, readers({ setupReader: dying }))
    expect(p.install).toMatchObject({ known: false, reason: 'the repository could not be read: boom' })
    expect(p.checks.known).toBe(false)
  })

  it('a default branch that dies is unknown, not a throw', async () => {
    const p = await run(
      { kind: 'github', owner: 'acme', repo: 'widget' },
      readers({ defaultBranch: () => Effect.die(new Error('no branch')) }),
    )
    expect(p.base).toMatchObject({ known: false, reason: 'no branch', default: null })
  })

  it('a runtime probe that fails is unknown for the runtimes and the agents', async () => {
    const p = await run(
      { kind: 'github', owner: 'acme', repo: 'widget' },
      readers({ runtimes: () => Effect.fail(new Error('auth check hung')) }),
    )
    expect(p.runtimes).toMatchObject({ known: false, reason: 'auth check hung' })
    expect(p.reviewer.known).toBe(false)
  })

  it('no runtime signed in says how to sign in', async () => {
    const p = await run(
      { kind: 'github', owner: 'acme', repo: 'widget' },
      readers({ runtimes: () => Effect.succeed([rt('claude-code', false), rt('codex', false)]) }),
    )
    expect(p.runtimes.known && p.runtimes.value[0]?.remedy).toContain('sign in')
    expect(p.writer).toMatchObject({ known: true, value: null })
  })
})

describe('proposeSetup — what accepting the CLI defaults produces', () => {
  it('holds nothing by default, closes nothing for a local project, and has no turn ceiling for codex', async () => {
    const only = readers({ runtimes: () => Effect.succeed([rt('claude-code', false), rt('codex', true)]) })
    const local = await run({ kind: 'local', path: '/w/widget' }, only)
    expect(local.heldBy).toMatchObject({ known: true, value: null })
    expect(local.end).toMatchObject({ known: true, value: [] })
    expect(local.limits).toMatchObject({ known: true, value: { turns: 'unbounded' } })
    const gh = await run({ kind: 'github', owner: 'acme', repo: 'widget' }, readers())
    expect(gh.end.known && gh.end.value.length).toBe(2)
    expect(gh.limits).toMatchObject({ value: { turns: 300 } })
  })
})

describe('proposeSetup — a failure is not a result', () => {
  it('a file that exists but cannot be read is unknown', async () => {
    const flaky = { has: () => Effect.succeed(true), read: () => Effect.succeed(null) }
    const p = await run({ kind: 'github', owner: 'acme', repo: 'widget' }, readers({ setupReader: flaky }))
    expect(p.checks.known).toBe(false)
    expect(p.install.known).toBe(false)
  })
  it('a default branch that cannot be found is unknown', async () => {
    const p = await run(
      { kind: 'github', owner: 'acme', repo: 'widget' },
      readers({ defaultBranch: () => Effect.succeed(null) }),
    )
    expect(p.base).toMatchObject({ known: false, default: null })
  })
  it('a runtime that did not start is unknown, not signed out', async () => {
    const dead: RuntimeFound = { id: 'codex', state: 'did-not-start', signedIn: false, detail: 'timed out' }
    const p = await run(
      { kind: 'github', owner: 'acme', repo: 'widget' },
      readers({ runtimes: () => Effect.succeed([rt('claude-code', false), dead]) }),
    )
    expect(p.runtimes.known).toBe(false)
    expect(p.writer.known).toBe(false)
  })
  it('an origin lookup that fails is unknown, even where history exists', async () => {
    const boom = readers({ origin: () => Effect.fail(new Error('not a git repository')) })
    const p = await run({ kind: 'local', path: '/w/widget' }, boom)
    expect(p.tickets).toMatchObject({ known: false, reason: 'not a git repository' })
    const q = await run(
      { kind: 'local', path: '/w/widget' },
      { ...boom, history: () => Effect.succeed(['db ticket #1']) },
    )
    expect(q.tickets).toMatchObject({ known: false, default: { source: 'db' } })
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
