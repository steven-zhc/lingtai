import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { reduceAttempt, STEPS, type Envelope } from '@lingtai/domain'
import { makeStream } from '@lingtai/domain/test/support'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SandboxMark, SandboxPanel } from '@/app/sandbox-panel'
import { sandboxTabPath, tabPath } from '@/lib/paths'
import {
  allowHrefOf,
  chipsOf,
  foldChips,
  markOfAction,
  METADATA_HOSTS,
  policyLetter,
  reachOf,
  sandboxViewOf,
  shortNameOf,
  summaryOf,
  vendorGroupsOf,
  type PathRoots,
  type PolicyGroup,
  type RunRow,
} from '@/lib/sandbox-view'
import { attemptOfQuery, defaultTabOf, sameTab } from '@/lib/tabs'

const RUN = 'pass-sbx-1'
const keys = (
  commandId: string,
  step = 'implement',
  action = 'agent',
  runtime: string | undefined = 'claude-code',
) => ({
  step: step as 'implement',
  action,
  ...(runtime === undefined ? {} : { runtime }),
  runId: RUN,
  commandId,
})
const policy = (over: Partial<{ allowedDomains: string[]; recipeDomains: string[]; weaker: boolean }> = {}) => ({
  allowedDomains: over.allowedDomains ?? ['api.anthropic.com', 'example.org'],
  recipeDomains: over.recipeDomains ?? ['example.org'],
  allowRead: ['/'],
  allowWrite: ['/wt', '~/.lingtai/cache/p'],
  denyRead: ['~/.ssh'],
  denyWrite: ['/wt/.git/hooks'],
  weakerNetworkIsolation: over.weaker ?? false,
  srtVersion: '0.0.83',
})
const sandboxed = { kind: 'sandboxed' as const, srtVersion: '0.0.83', policy: policy() }
const entry = (host: string | null, count: number, firstAt: string, telemetry = false) => ({
  host,
  port: host === null ? null : 443,
  ...(host === null ? { line: 'raw srt line' } : {}),
  count,
  firstAt,
  telemetry,
})

function fold(build: (e: ReturnType<typeof makeStream>) => Envelope[]) {
  const e = makeStream('pass-sbx-1')
  return reduceAttempt([
    e('RunStarted', {
      ticketId: 'ticket-p-1',
      runtime: 'claude-code',
      model: 'm',
      promptVersion: 'v',
      baseSha: 'b',
      configHash: 'c',
      worktree: '/wt',
      invocation: null,
    }),
    ...build(e),
  ])
}
const ended = (e: ReturnType<typeof makeStream>, step: 'implement' | 'review' = 'implement') =>
  e('StepEnded', { runId: RUN, outcome: { step, round: 0, actions: [] } })

describe('the sandbox view reads what the attempt recorded (#1161)', () => {
  it('draws sandboxed, off by choice, degraded and not recorded, each with its own mark', () => {
    const state = fold((e) => [
      e('SandboxBoundaryRecorded', { ...keys('c1'), boundary: sandboxed }),
      e('SandboxBoundaryRecorded', {
        ...keys('c2', 'review', 'cold', 'codex'),
        boundary: { kind: 'unsandboxed', reason: 'off by choice' },
      }),
      e('SandboxBoundaryRecorded', {
        ...keys('c3', 'build', 'test', undefined),
        boundary: { kind: 'unsandboxed', reason: 'degraded', why: 'no bubblewrap' },
      }),
      e('SandboxConnectionsRefused', {
        ...keys('c4', 'build', 'lint', undefined),
        read: { kind: 'entries', entries: [], complete: true },
      }),
    ])
    const view = sandboxViewOf(state, 'p')
    expect(view.rows.map((r) => [r.key, r.mark.state, r.mark.tone])).toEqual([
      ['c1', 'sandboxed', 'ok'],
      ['c2', 'off by choice', 'muted'],
      ['c3', 'degraded', 'signal'],
      ['c4', 'not recorded', 'muted'],
    ])
    expect(view.rows[2]!.mark.why).toBe('no bubblewrap')
    expect(JSON.stringify(view)).not.toMatch(/safe"/)
  })

  it('draws two invocations sharing one runId as two rows', () => {
    const state = fold((e) => [
      e('SandboxBoundaryRecorded', { ...keys('c1'), boundary: sandboxed }),
      e('SandboxBoundaryRecorded', { ...keys('c2'), boundary: sandboxed }),
    ])
    const rows = sandboxViewOf(state, 'p').rows
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.key)).size).toBe(2)
  })

  it('says a running invocation reads its refusals when it ends, and never none refused', () => {
    const view = sandboxViewOf(
      fold((e) => [e('SandboxBoundaryRecorded', { ...keys('c1'), boundary: sandboxed })]),
      'p',
    )
    expect(view.rows[0]!.refusals).toEqual({ kind: 'pending' })
    expect(view.blocked.caveats.join(' ')).toMatch(/read when the run ends/)
    const html = renderToStaticMarkup(<SandboxPanel view={view} />)
    expect(html).not.toContain('No refused connection was recorded')
  })

  it('says none recorded, never none refused, once the step has ended, and says the read was lost when the run ended inside it', () => {
    const afterStep = fold((e) => [e('SandboxBoundaryRecorded', { ...keys('c1'), boundary: sandboxed }), ended(e)])
    expect(sandboxViewOf(afterStep, 'p').rows[0]!.refusals).toEqual({ kind: 'none recorded' })

    const died = fold((e) => [
      e('SandboxBoundaryRecorded', { ...keys('c1'), boundary: sandboxed }),
      e('RunFailed', { kind: 'crash', detail: 'died' }),
    ])
    const view = sandboxViewOf(died, 'p')
    expect(view.rows[0]!.refusals).toEqual({ kind: 'lost' })
    expect(view.blocked.caveats.join(' ')).toMatch(/ended inside this step/)
  })

  it('marks a sandboxed review boundary ended by its StepEnded, though the review step folds summaries', () => {
    const state = fold((e) => [
      e('SandboxBoundaryRecorded', { ...keys('c1', 'review', 'cold'), boundary: sandboxed }),
      e('StepEnded', { runId: RUN, outcome: { step: 'review', round: 0, actions: [] } }),
      e('RunFinished', { exitCode: 0, turns: 1, durationMs: 1 }),
    ])
    expect(state.sandbox?.[0]?.ended).toBe(true)
    expect(sandboxViewOf(state, 'p').rows[0]!.refusals).toEqual({ kind: 'none recorded' })
  })

  it('says so, in a sentence, when the refusals could not be read or are incomplete', () => {
    const state = fold((e) => [
      e('SandboxBoundaryRecorded', { ...keys('c1'), boundary: sandboxed }),
      e('SandboxConnectionsRefused', { ...keys('c1'), read: { kind: 'unreadable', reason: 'no store' } }),
      e('SandboxBoundaryRecorded', { ...keys('c2', 'review', 'cold'), boundary: sandboxed }),
      e('SandboxConnectionsRefused', {
        ...keys('c2', 'review', 'cold'),
        read: { kind: 'entries', entries: [entry('a.example.com', 1, '2026-11-01T00:00:00.000Z')], complete: false },
      }),
    ])
    const view = sandboxViewOf(state, 'p')
    expect(view.rows[0]!.refusals).toEqual({ kind: 'unreadable', reason: 'no store' })
    expect(view.rows[1]!.refusals).toEqual({ kind: 'refused', count: 1, incomplete: true })
    expect(view.blocked.caveats).toHaveLength(2)
    expect(renderToStaticMarkup(<SandboxPanel view={view} />)).not.toContain('Nothing was refused')
  })

  it('leaves telemetry out of Blocked and of its count, and groups by host with the earliest time', () => {
    const state = fold((e) => [
      e('SandboxBoundaryRecorded', { ...keys('c1'), boundary: sandboxed }),
      e('SandboxConnectionsRefused', {
        ...keys('c1'),
        read: {
          kind: 'entries',
          complete: true,
          entries: [
            entry('o.example.com', 2, '2026-11-01T00:00:05.000Z'),
            entry('o.sentry.io', 9, '2026-11-01T00:00:00.000Z', true),
            entry(null, 1, '2026-11-01T00:00:09.000Z'),
          ],
        },
      }),
      e('SandboxBoundaryRecorded', { ...keys('c2', 'review', 'cold'), boundary: sandboxed }),
      e('SandboxConnectionsRefused', {
        ...keys('c2', 'review', 'cold'),
        read: { kind: 'entries', complete: true, entries: [entry('o.example.com', 3, '2026-11-01T00:00:01.000Z')] },
      }),
    ])
    const view = sandboxViewOf(state, 'p')
    expect(view.blocked.hosts.map((h) => [h.label, h.count, h.firstAt])).toEqual([
      ['o.example.com', 5, '2026-11-01T00:00:01.000Z'],
      ['raw srt line', 1, '2026-11-01T00:00:09.000Z'],
    ])
    expect(view.blocked.hosts[0]!.from).toEqual(['implement · agent · claude-code', 'review · cold · claude-code'])
    expect(view.rows[0]!.refusals).toEqual({ kind: 'refused', count: 3, incomplete: false })
    expect(JSON.stringify(view)).not.toContain('sentry')
  })

  it('shows Allowed and Limited from the recorded policy, built in or recipe, and weaker network isolation in words', () => {
    const state = fold((e) => [
      e('SandboxBoundaryRecorded', {
        ...keys('c1', 'implement', 'agent', 'codex'),
        boundary: { kind: 'sandboxed', srtVersion: '0.0.83', policy: policy({ weaker: true }) },
      }),
    ])
    const view = sandboxViewOf(state, 'p')
    expect(view.policies).toHaveLength(1)
    expect(view.policies[0]!.domains).toEqual([
      { host: 'api.anthropic.com', source: 'built in' },
      { host: 'example.org', source: 'recipe' },
    ])
    expect(view.policies[0]!.writable).toEqual(['/wt', '~/.lingtai/cache/p'])
    expect(view.policies[0]!.denyRead).toEqual([{ path: '~/.ssh', except: [] }])
    expect(view.policies[0]!.srtVersion).toBe('0.0.83')
    expect(view.claudeCodeAuth).toBe(false)
    const html = renderToStaticMarkup(<SandboxPanel view={view} />)
    expect(html).toContain('weaker network isolation')
    expect(html).toContain('outside the sandbox')
    expect(
      sandboxViewOf(
        fold((e) => [e('SandboxBoundaryRecorded', { ...keys('c1'), boundary: sandboxed })]),
        'p',
      ).claudeCodeAuth,
    ).toBe(true)
  })

  it("shows the source the run recorded, not today's built-in list, and not recorded for an older record", () => {
    const recorded = fold((e) => [
      e('SandboxBoundaryRecorded', {
        ...keys('c1'),
        boundary: {
          kind: 'sandboxed',
          srtVersion: '0.0.83',
          // example.org was recipe-provided when this ran, whatever the built-in list says now.
          policy: policy({ allowedDomains: ['example.org', 'github.com'], recipeDomains: ['example.org'] }),
        },
      }),
    ])
    expect(sandboxViewOf(recorded, 'p').policies[0]!.domains).toEqual([
      { host: 'example.org', source: 'recipe' },
      { host: 'github.com', source: 'built in' },
    ])
    const { recipeDomains: _omitted, ...older } = policy()
    const old = fold((e) => [
      e('SandboxBoundaryRecorded', {
        ...keys('c1'),
        boundary: { kind: 'sandboxed', srtVersion: '0.0.83', policy: older },
      }),
    ])
    expect(sandboxViewOf(old, 'p').policies[0]!.domains.map((d) => d.source)).toEqual(['not recorded', 'not recorded'])
  })

  it('shows each attempt its own rules', () => {
    const a = fold((e) => [e('SandboxBoundaryRecorded', { ...keys('c1'), boundary: sandboxed })])
    const b = fold((e) => [
      e('SandboxBoundaryRecorded', {
        ...keys('c1'),
        boundary: { kind: 'sandboxed', srtVersion: '0.0.83', policy: policy({ allowedDomains: ['only.example.net'] }) },
      }),
    ])
    expect(sandboxViewOf(a, 'p').policies[0]!.domains.map((d) => d.host)).toContain('example.org')
    expect(sandboxViewOf(b, 'p').policies[0]!.domains.map((d) => d.host)).toEqual(['only.example.net'])
  })

  it('says not recorded only for actions the attempt reached, and never for the merge or unexecuted ones', () => {
    const state = fold((e) => [
      e('StepsResolved', {
        runId: RUN,
        configHash: 'c',
        steps: STEPS.map((step) => ({
          step,
          actions: step === 'build' ? ['test'] : step === 'review' ? ['cold'] : step === 'merge' ? ['land'] : [],
        })),
      }),
      e('StepEnded', {
        runId: RUN,
        outcome: {
          step: 'build',
          round: 0,
          actions: [
            {
              plugin: 'run',
              name: 'test',
              onSha: 'base000',
              evidence: '',
              yields: 'verdict',
              result: { _tag: 'Completed', assessment: { verdict: 'accepted', findings: [] } },
            },
          ] as never,
        },
      }),
      e('RunFailed', { kind: 'crash', detail: 'died' }),
    ])
    const view = sandboxViewOf(state, 'p')
    expect(view.rows.map((r) => [r.step, r.action, r.mark.state])).toEqual([['build', 'test', 'not recorded']])
    expect(renderToStaticMarkup(<SandboxPanel view={view} />)).not.toContain('No refused connection was recorded')
  })

  it('draws no row and no warning for a reached human approval or watch, which launch no wrapped process', () => {
    const state = fold((e) => [
      e('StepsResolved', {
        runId: RUN,
        configHash: 'c',
        steps: STEPS.map((step) => ({
          step,
          actions: step === 'proposed' ? ['approve', 'ci'] : [],
        })),
      }),
      e('StepEnded', {
        runId: RUN,
        outcome: {
          step: 'proposed',
          round: 0,
          actions: [
            {
              plugin: 'human',
              name: 'approve',
              onSha: 'base000',
              evidence: '',
              yields: 'signoff',
              result: { _tag: 'Completed', requested: { question: 'approve?' } },
            },
            {
              plugin: 'watch',
              name: 'ci',
              onSha: 'base000',
              evidence: '',
              yields: 'signoff',
              result: { _tag: 'Completed', requested: { question: 'approve?' } },
            },
          ] as never,
        },
      }),
    ])
    const view = sandboxViewOf(state, 'p')
    expect(view.rows).toEqual([])
    expect(view.blocked.caveats.join(' ')).not.toContain('approve')
    expect(view.blocked.caveats.join(' ')).not.toContain('ci:')
  })

  it('keeps two invocations of one action under different policies apart, by number', () => {
    const state = fold((e) => [
      e('SandboxBoundaryRecorded', { ...keys('c1'), boundary: sandboxed }),
      e('SandboxBoundaryRecorded', {
        ...keys('c2'),
        boundary: { kind: 'sandboxed', srtVersion: '0.0.83', policy: { ...policy(), allowWrite: ['/fix'] } },
      }),
    ])
    const view = sandboxViewOf(state, 'p')
    expect(view.policies).toHaveLength(2)
    expect(view.rows.map((r) => r.policy)).toEqual([1, 2])
  })

  it('does not say nothing was refused for an attempt with no record at all', () => {
    const view = sandboxViewOf(
      fold(() => []),
      'p',
    )
    expect(view.blocked.caveats.join(' ')).toMatch(/No sandbox record/)
    expect(renderToStaticMarkup(<SandboxPanel view={view} />)).not.toContain('No refused connection was recorded')
  })

  it('keeps each invocation its own policy, with the exceptions to a denied root', () => {
    const wide = {
      ...policy(),
      allowRead: ['/', '~/.lingtai/state/cache', '/elsewhere'],
      denyRead: ['~/.lingtai/state'],
    }
    const state = fold((e) => [
      e('SandboxBoundaryRecorded', {
        ...keys('c1'),
        boundary: { kind: 'sandboxed', srtVersion: '0.0.83', policy: wide },
      }),
      e('SandboxBoundaryRecorded', {
        ...keys('c2', 'review', 'cold', 'codex'),
        boundary: {
          kind: 'sandboxed',
          srtVersion: '0.0.90',
          policy: { ...policy(), srtVersion: '0.0.90', allowWrite: ['/other'] },
        },
      }),
    ])
    const view = sandboxViewOf(state, 'p')
    expect(view.policies.map((g) => [g.runs, g.srtVersion])).toEqual([
      [['implement · agent · claude-code'], '0.0.83'],
      [['review · cold · codex'], '0.0.90'],
    ])
    expect(view.rows.map((r) => r.policy)).toEqual([1, 2])
    expect(view.policies[0]!.denyRead).toEqual([{ path: '~/.lingtai/state', except: ['~/.lingtai/state/cache'] }])
    expect(view.rows.map((r) => r.srtVersion)).toEqual(['0.0.83', '0.0.90'])
    expect(renderToStaticMarkup(<SandboxPanel view={view} />)).toContain('except ~/.lingtai/state/cache')
  })

  it('takes events only: the view module reads no recipe', () => {
    const source = readFileSync(join(import.meta.dirname, '../src/lib/sandbox-view.ts'), 'utf8')
    const recipeImports = [...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'@lingtai\/recipe'/g)]
    expect(recipeImports.map((m) => m[1]!.trim())).toEqual(['isNetworkEntry'])
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/recipe\.yml|readRecipe|currentRecipe|recipesFor/)
  })
})

describe('Allow on this project (#1161)', () => {
  it('links to the recipe editor with the host filled in', () => {
    expect(allowHrefOf('my proj', 'registry.example.com')).toBe(
      '/p/my%20proj/recipe?edit=1&allow=registry.example.com#sandbox',
    )
  })

  it('offers no link for a host the recipe would reject', () => {
    for (const host of [
      'not a host',
      'https://x.example.com',
      'host:443',
      'com',
      'a'.repeat(300) + '.com',
      '*.com',
      null,
    ]) {
      expect(allowHrefOf('p', host as string | null), String(host)).toBeNull()
    }
  })

  it('offers no link for any cloud-metadata address', () => {
    expect([...METADATA_HOSTS]).toEqual(['169.254.169.254', 'fd00:ec2::254', 'metadata.google.internal'])
    for (const host of METADATA_HOSTS) expect(allowHrefOf('p', host), host).toBeNull()
  })

  it('draws the link in Blocked only for an allowable host', () => {
    const state = fold((e) => [
      e('SandboxBoundaryRecorded', { ...keys('c1'), boundary: sandboxed }),
      e('SandboxConnectionsRefused', {
        ...keys('c1'),
        read: {
          kind: 'entries',
          complete: true,
          entries: [
            entry('ok.example.com', 1, '2026-11-01T00:00:00.000Z'),
            entry('169.254.169.254', 1, '2026-11-01T00:00:00.000Z'),
          ],
        },
      }),
    ])
    const html = renderToStaticMarkup(<SandboxPanel view={sandboxViewOf(state, 'p')} />)
    expect(html.match(/Allow on this project/g)).toHaveLength(1)
    expect(html).toContain('href="/p/p/recipe?edit=1&amp;allow=ok.example.com#sandbox"')
  })
})

describe('the mark on the attempt tab', () => {
  it('is the latest invocation of that step and action, and nothing where none was recorded', () => {
    const state = fold((e) => [
      e('SandboxBoundaryRecorded', { ...keys('c1'), boundary: { kind: 'unsandboxed', reason: 'off by choice' } }),
      e('SandboxBoundaryRecorded', { ...keys('c2'), boundary: sandboxed }),
    ])
    expect(markOfAction(state.sandbox, 'implement', 'agent')?.state).toBe('sandboxed')
    expect(markOfAction(state.sandbox, 'build', 'test')).toBeNull()
    expect(renderToStaticMarkup(<SandboxMark mark={markOfAction(state.sandbox, 'implement', 'agent')!} />)).toContain(
      'sandboxed',
    )
  })
})

describe('the Sandbox tab key', () => {
  it('has its own path and compares only with itself', () => {
    expect(tabPath('ticket-p-1', 'sandbox')).toBe('/p/p/ticket/1/sandbox')
    expect(sandboxTabPath('ticket-p-1', 2)).toBe('/p/p/ticket/1/sandbox?attempt=2')
    expect(sameTab('sandbox', 'sandbox')).toBe(true)
    expect(sameTab('sandbox', 'ticket')).toBe(false)
    expect(sameTab('sandbox', { attempt: 1 })).toBe(false)
    expect(sameTab({ attempt: 1 }, { attempt: 1 })).toBe(true)
  })

  it('is never the default tab', () => {
    for (const state of ['blocked', 'running', 'landed', 'queued']) {
      for (const runs of [[], [{ attempt: 1 }], [{ attempt: 1 }, { attempt: 2 }]]) {
        expect(defaultTabOf({ state, deciding: runs.length > 0 ? { attempt: 1 } : null }, runs)).not.toBe('sandbox')
      }
    }
  })

  it('reads ?attempt= as a whole number from 1 and otherwise means the newest', () => {
    expect(attemptOfQuery('2')).toBe(2)
    for (const bad of [undefined, '0', 'x', '1.5', ['1', '2']]) expect(attemptOfQuery(bad)).toBeNull()
  })
})

describe('what the record does not say is not drawn as fact (#1161, round 1)', () => {
  it('promises the dedicated token only for a sandboxed Claude Code run', () => {
    const off = fold((e) => [
      e('SandboxBoundaryRecorded', { ...keys('c1'), boundary: { kind: 'unsandboxed', reason: 'degraded', why: 'x' } }),
    ])
    expect(sandboxViewOf(off, 'p').claudeCodeAuth).toBe(false)
  })

  it('numbers invocations that share a label, so two refusals never merge', () => {
    const state = fold((e) => [
      e('SandboxBoundaryRecorded', { ...keys('c1'), boundary: sandboxed }),
      e('SandboxConnectionsRefused', {
        ...keys('c1'),
        read: { kind: 'entries', complete: true, entries: [entry('a.example.com', 1, '2026-11-01T00:00:00.000Z')] },
      }),
      e('SandboxBoundaryRecorded', { ...keys('c2'), boundary: sandboxed }),
      e('SandboxConnectionsRefused', {
        ...keys('c2'),
        read: { kind: 'entries', complete: true, entries: [entry('b.example.com', 1, '2026-11-01T00:00:01.000Z')] },
      }),
    ])
    const view = sandboxViewOf(state, 'p')
    expect(view.rows.map((r) => r.ordinal)).toEqual([1, 2])
    expect(view.blocked.hosts.map((h) => h.from)).toEqual([
      ['implement · agent · claude-code #1'],
      ['implement · agent · claude-code #2'],
    ])
  })

  it('ends a judge invocation at the route it produced, and every invocation of a superseded attempt', () => {
    const pending = fold((e) => [
      e('SandboxBoundaryRecorded', { ...keys('c1', 'proposed', 'judge'), boundary: sandboxed }),
    ])
    expect(sandboxViewOf(pending, 'p').rows[0]!.refusals).toEqual({ kind: 'pending' })
    expect(sandboxViewOf(pending, 'p', true).rows[0]!.refusals).toEqual({ kind: 'lost' })
  })

  it('does not call a continued attempt lost: a RunFailed marks only the invocations open when it arrived', () => {
    const state = fold((e) => [
      e('SandboxBoundaryRecorded', { ...keys('c1'), boundary: sandboxed }),
      e('RunFailed', { kind: 'out-of-turns', detail: 'limit' }),
      e('StepStarted', { runId: RUN, step: 'implement', round: 1 }),
      e('SandboxBoundaryRecorded', { ...keys('c2'), boundary: sandboxed }),
    ])
    expect(sandboxViewOf(state, 'p').rows.map((r) => r.refusals.kind)).toEqual(['lost', 'pending'])
  })

  it('says none refused, with no caveat, for a complete read of telemetry alone', () => {
    const state = fold((e) => [
      e('SandboxBoundaryRecorded', { ...keys('c1'), boundary: sandboxed }),
      e('SandboxConnectionsRefused', {
        ...keys('c1'),
        read: { kind: 'entries', complete: true, entries: [entry('o.sentry.io', 4, '2026-11-01T00:00:00.000Z', true)] },
      }),
      ended(e),
    ])
    const view = sandboxViewOf(state, 'p')
    expect(view.rows[0]!.refusals).toEqual({ kind: 'none refused' })
    expect(view.blocked.caveats).toEqual([])
  })

  it('finds a judge invocation under judge:<when>, not the recipe name', () => {
    const state = fold((e) => [
      e('SandboxBoundaryRecorded', { ...keys('c1', 'proposed', 'judge:findings'), boundary: sandboxed }),
    ])
    expect(markOfAction(state.sandbox, 'proposed', 'judge:findings')?.state).toBe('sandboxed')
    expect(markOfAction(state.sandbox, 'proposed', 'the approach')).toBeNull()
  })
})

const ROOTS: PathRoots = { home: '/Users/s', lingtaiHome: '/Users/s/.lingtai', project: 'proj' }

describe('short names (#1196)', () => {
  const name = (p: string) => shortNameOf(p, ROOTS).label
  it('names each of the five roots', () => {
    expect(name('/Users/s/.codex')).toBe('~/.codex')
    expect(name('/Users/s/.lingtai/runs/a1/claude')).toBe('<run dir>/claude')
    expect(name('/Users/s/.lingtai/worktrees/proj/pass-1/src')).toBe('<worktree>/src')
    expect(name('/Users/s/.lingtai/repos/proj.git')).toBe('<mirror>')
    expect(name('/Users/s/.lingtai/cache/proj')).toBe('<cache>')
  })
  it('lets the longest prefix win, matches only at a slash, and leaves the rest as it is', () => {
    expect(name('/Users/s/.lingtai/repos/proj.git/hooks')).toBe('<mirror>/hooks')
    expect(name('/Users/s/.lingtai/repos/other.git')).toBe('<lingtai home>/repos/other.git')
    expect(name('/Users/s/.lingtaix/a')).toBe('~/.lingtaix/a')
    expect(name('/Users/s/.lingtai')).toBe('<lingtai home>')
    expect(name('/var/folders/ab/T/x')).toBe('/var/folders/ab/T/x')
    expect(name('/tmp')).toBe('/tmp')
  })
  it('makes a path and its /private twin one chip with both spellings in the title', () => {
    const chips = chipsOf(['/tmp', '/private/tmp', '/Users/s/.codex'], ROOTS)
    expect(chips.map((c) => [c.label, c.fulls])).toEqual([
      ['/tmp', ['/tmp', '/private/tmp']],
      ['~/.codex', ['/Users/s/.codex']],
    ])
  })
  it('letters policies A to Z and then AA', () => {
    expect([1, 2, 26, 27, 28].map(policyLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB'])
  })
})

const group = (over: Partial<PolicyGroup> = {}): PolicyGroup => ({
  runs: ['implement · agent'],
  srtVersion: '0.0.83',
  writable: ['/wt', '/tmp'],
  domains: [
    { host: 'api.anthropic.com', source: 'built in' },
    { host: 'registry.npmjs.org', source: 'built in' },
    { host: 'example.org', source: 'recipe' },
  ],
  denyRead: [{ path: '/Users/s/.ssh', except: [] }],
  denyWrite: ['/wt/.git/hooks'],
  weakerNetwork: false,
  ...over,
})

const view2 = (a: PolicyGroup, b: PolicyGroup) => ({
  rows: [],
  policies: [a, b],
  claudeCodeAuth: false,
  blocked: { hosts: [], caveats: [] },
})

describe('what the runs could reach (#1196)', () => {
  it('lists the common set once and names each policy’s one extra path', () => {
    const { common, differs } = reachOf([
      group({ runs: ['implement'], writable: ['/wt', '/tmp', '/Users/s/.lingtai/runs/a1/claude'] }),
      group({ runs: ['review'], writable: ['/wt', '/tmp', '/Users/s/.codex'] }),
      group({ runs: ['build'] }),
    ])
    expect(common.writable).toEqual(['/wt', '/tmp'])
    expect(differs.map((d) => [d.letter, d.extra.writable])).toEqual([
      ['A', ['/Users/s/.lingtai/runs/a1/claude']],
      ['B', ['/Users/s/.codex']],
      ['C', []],
    ])
  })
  it('says what a policy lacks, and draws no differences for one policy', () => {
    const { differs } = reachOf([group(), group({ writable: ['/wt'] })])
    expect(differs[1]!.lacks.writable).toEqual(['/tmp'])
    expect(differs[0]!.extra.writable).toEqual(['/tmp'])
    expect(reachOf([group()]).differs).toEqual([])
  })
  it('never turns a denial a policy does not list into a permission', () => {
    const a = group({ denyRead: [{ path: '/lh', except: ['/lh/runs/a'] }], denyWrite: ['/x/.codex/config.toml'] })
    const b = group({ denyRead: [{ path: '/lh', except: [] }], denyWrite: [] })
    const { common, differs } = reachOf([a, b])
    expect(common.denyRead).toEqual([{ path: '/lh', except: [] }])
    expect(differs[0]!.exceptions).toEqual([{ path: '/lh', except: ['/lh/runs/a'] }])
    expect(differs[1]!.lacks.denyWrite).toEqual(['/x/.codex/config.toml'])
    const html = renderToStaticMarkup(<SandboxPanel view={{ ...view2(a, b) }} roots={ROOTS} />)
    expect(html).not.toContain('can read')
    expect(html).not.toContain('can write')
    expect(html).toContain('inside')
    expect(html).toContain('which stays denied')
    expect(html).toContain('does not deny writing')
  })
  it('groups hosts by vendor, the recipe’s own apart', () => {
    expect(vendorGroupsOf(group().domains)).toEqual({
      vendors: [
        { vendor: 'Anthropic', hosts: ['api.anthropic.com'] },
        { vendor: 'npm', hosts: ['registry.npmjs.org'] },
      ],
      recipe: ['example.org'],
    })
    expect(vendorGroupsOf([{ host: 'x.test', source: 'not recorded' }]).vendors).toEqual([
      { vendor: 'Other', hosts: ['x.test'] },
    ])
  })
})

describe('the summary (#1196)', () => {
  const row = (over: Partial<RunRow> = {}): RunRow => ({
    key: 'k',
    step: 'implement',
    action: 'agent',
    runtime: 'claude-code',
    ordinal: null,
    mark: { state: 'sandboxed', tone: 'ok', why: null },
    weakerNetwork: false,
    srtVersion: '0.0.83',
    policy: 1,
    refusals: { kind: 'none recorded' },
    ...over,
  })
  it('counts a plain sum only where every read is known', () => {
    const s = summaryOf([
      row({ refusals: { kind: 'refused', count: 3, incomplete: false } }),
      row({ refusals: { kind: 'none refused' } }),
    ])
    expect(s).toMatchObject({
      state: 'all',
      tone: 'ok',
      refused: { count: 3, orMore: false, unknownRuns: 0, unrecordedRuns: 0 },
    })
  })
  it('does not draw none recorded as a confirmed zero or a confirmed total', () => {
    const view = (rows: RunRow[]) => ({
      rows,
      policies: [],
      claudeCodeAuth: false,
      blocked: { hosts: [], caveats: [] },
    })
    const none = renderToStaticMarkup(<SandboxPanel view={view([row({ refusals: { kind: 'none recorded' } })])} />)
    expect(none).toContain('no refusal recorded')
    expect(none).not.toContain('0 connections refused')
    const some = renderToStaticMarkup(
      <SandboxPanel
        view={view([
          row({ refusals: { kind: 'refused', count: 2, incomplete: false } }),
          row({ key: 'k2', refusals: { kind: 'none recorded' } }),
        ])}
      />,
    )
    expect(some).toContain('2 recorded as refused')
    expect(some).not.toContain('2 connections refused')
  })
  it('keeps the one recorded srt version where another run has none', () => {
    const html = renderToStaticMarkup(
      <SandboxPanel
        view={{
          rows: [
            row(),
            row({
              key: 'k2',
              srtVersion: null,
              mark: { state: 'degraded', tone: 'signal', why: 'srt missing' },
            }),
          ],
          policies: [],
          claudeCodeAuth: false,
          blocked: { hosts: [], caveats: [] },
        }}
      />,
    )
    expect(html).toContain('srt 0.0.83')
  })
  it.each([
    [{ kind: 'pending' }],
    [{ kind: 'lost' }],
    [{ kind: 'unreadable', reason: 'x' }],
    [{ kind: 'refused', count: 1, incomplete: true }],
  ] as const)('never makes %j a plain total', (refusals) => {
    expect(
      summaryOf([row({ refusals: { kind: 'refused', count: 2, incomplete: false } }), row({ refusals })]).refused
        .orMore,
    ).toBe(true)
  })
  it('says unknown for K runs where only unknowns are there', () => {
    const html = renderToStaticMarkup(
      <SandboxPanel
        view={{
          rows: [row({ refusals: { kind: 'pending' } }), row({ key: 'k2', refusals: { kind: 'lost' } })],
          policies: [],
          claudeCodeAuth: false,
          blocked: { hosts: [], caveats: [] },
        }}
      />,
    )
    expect(html).toContain('refusals unknown for 2 runs')
  })
  it('reads all, some, off and none, each with its tone', () => {
    const off = row({ mark: { state: 'off by choice', tone: 'muted', why: null }, srtVersion: null, policy: null })
    const stopped = row({ mark: { state: 'stopped', tone: 'fail', why: 'no srt' } })
    const degraded = row({ mark: { state: 'degraded', tone: 'signal', why: 'srt missing' } })
    expect(summaryOf([row(), row()]).state).toBe('all')
    expect(summaryOf([row(), degraded])).toMatchObject({
      state: 'some',
      tone: 'signal',
      sandboxed: 1,
      why: 'srt missing',
    })
    expect(summaryOf([row(), stopped, degraded])).toMatchObject({ state: 'some', tone: 'fail', why: 'no srt' })
    expect(summaryOf([off])).toMatchObject({ state: 'off', tone: 'muted' })
    expect(summaryOf([])).toMatchObject({ state: 'none', total: 0 })
    expect(summaryOf([row(), row({ srtVersion: '0.0.90' })]).srt).toBe('differs')
  })
})

describe('the redrawn tab (#1196)', () => {
  it('draws its sections in order, with a Kind column and short names', () => {
    const state = fold((e) => [
      e('SandboxBoundaryRecorded', { ...keys('c1'), boundary: sandboxed }),
      e('SandboxBoundaryRecorded', {
        ...keys('c2', 'review', 'cold', 'codex'),
        boundary: {
          kind: 'sandboxed',
          srtVersion: '0.0.83',
          policy: { ...policy(), allowWrite: ['/wt', '/Users/s/.codex'] },
        },
      }),
    ])
    const html = renderToStaticMarkup(<SandboxPanel view={sandboxViewOf(state, 'p')} roots={ROOTS} attempt={2} />)
    const at = ['Summary', 'Blocked', 'Runs', 'What the runs could reach'].map((l) => html.indexOf(`aria-label="${l}"`))
    expect(at.every((n) => n >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(html).toContain('Every run of attempt 2 ran inside the sandbox')
    expect(html).toContain('agent · claude-code')
    expect(html).toContain('Where the policies differ')
    expect(html).toContain('~/.codex')
    expect(html).toContain('title="/Users/s/.codex"')
    expect(html.indexOf('Not covered')).toBeGreaterThan(at[3]!)
  })
  it('draws no reach where the recipe turned the sandbox off', () => {
    const state = fold((e) => [
      e('SandboxBoundaryRecorded', { ...keys('c1'), boundary: { kind: 'unsandboxed', reason: 'off by choice' } }),
    ])
    const html = renderToStaticMarkup(<SandboxPanel view={sandboxViewOf(state, 'p')} />)
    expect(html).toContain('ran without the sandbox: the recipe turns it off')
    expect(html).not.toContain('What the runs could reach')
  })
})

describe('the twin and the fold (#1237)', () => {
  it('draws a path and its /private twin as one chip, a trailing slash aside', () => {
    const chips = chipsOf(['/var/folders/x/T/', '/private/var/folders/x/T'], ROOTS)
    expect(chips).toHaveLength(1)
    expect(chips[0]!.label).toBe('/var/folders/x/T')
    expect(chips[0]!.fulls).toEqual(['/var/folders/x/T/', '/private/var/folders/x/T'])
  })
  it('draws the attempt run directory as <run dir>', () => {
    expect(shortNameOf('/Users/s/.lingtai/runs/p1/claude/settings.json', ROOTS).label).toBe(
      '<run dir>/claude/settings.json',
    )
    expect(shortNameOf('/Users/s/.lingtai/runs/p1', ROOTS).label).toBe('<run dir>')
    expect(shortNameOf('/Users/s/.lingtai/runs', ROOTS).label).toBe('<lingtai home>/runs')
  })
  it('folds three or more paths under one parent, and leaves two', () => {
    const base = '/Users/s/.lingtai/runs/p1/claude'
    const three = foldChips(chipsOf([`${base}/a`, `${base}/b`, `${base}/c`, '/etc/x'], ROOTS), ROOTS)
    expect(three.map((c) => c.label)).toEqual(['<run dir>/claude/… (3)', '/etc/x'])
    expect(three[0]!.members).toHaveLength(3)
    expect(foldChips(chipsOf([`${base}/a`, `${base}/b`], ROOTS), ROOTS)).toHaveLength(2)
  })
})

describe('agentsInSandbox (#1329)', () => {
  const on = { enabled: true }
  it('puts three inside and antigravity outside; off answers null', async () => {
    const { agentsInSandbox } = await import('@/lib/sandbox-view')
    const r = agentsInSandbox(['claude-code', 'codex', 'copilot', 'antigravity'], on, '/home/me')
    expect(r?.inside.map((a) => a.id)).toEqual(['claude-code', 'codex', 'copilot'])
    expect(r?.outside.map((a) => a.id)).toEqual(['antigravity'])
    expect(r?.outside[0]?.why).toContain('keychain')
    expect(r?.inside[2]?.adds).toEqual({ hosts: ['*.githubcopilot.com'], writes: ['/home/me/.copilot'] })
    expect(agentsInSandbox(['codex'], { enabled: false }, '/h')).toBeNull()
    expect(agentsInSandbox(['codex'], undefined, '/h')).toBeNull()
  })
  it('lists an unknown id as unknown, never inside', async () => {
    const { agentsInSandbox } = await import('@/lib/sandbox-view')
    expect(agentsInSandbox(['newer'], on, '/h')?.unknown.map((a) => a.id)).toEqual(['newer'])
  })
  it('every RuntimeId has sandbox facts', async () => {
    const { RuntimeId } = await import('@lingtai/domain')
    const { sandboxFactsOf } = await import('@lingtai/agent/sandbox-facts')
    for (const id of RuntimeId.options) expect(sandboxFactsOf(id)).toBeDefined()
  })
  it('the facts module imports neither @lingtai/env nor node:*', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../../packages/agent/src/sandbox-facts.ts', import.meta.url), 'utf8')
    const imports = src.split('\n').filter((l) => l.startsWith('import '))
    expect(imports.join('\n')).not.toMatch(/@lingtai\/env|node:/)
  })
})
