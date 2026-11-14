import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { reduceAttempt, STEPS, type Envelope } from '@lingtai/domain'
import { makeStream } from '@lingtai/domain/test/support'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SandboxMark, SandboxPanel } from '@/app/sandbox-panel'
import { allowHrefOf, markOfAction, METADATA_HOSTS, sandboxViewOf } from '@/lib/sandbox-view'
import { attemptOfQuery, defaultTabOf, sameTab, sandboxTabPath, tabPath } from '@/lib/tabs'

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
const policy = (over: Partial<{ allowedDomains: string[]; weaker: boolean }> = {}) => ({
  allowedDomains: over.allowedDomains ?? ['api.anthropic.com', 'example.org'],
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

  it('says none refused only once the step has ended, and says the read was lost when the run ended inside it', () => {
    const afterStep = fold((e) => [e('SandboxBoundaryRecorded', { ...keys('c1'), boundary: sandboxed }), ended(e)])
    expect(sandboxViewOf(afterStep, 'p').rows[0]!.refusals).toEqual({ kind: 'none' })

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
    expect(sandboxViewOf(state, 'p').rows[0]!.refusals).toEqual({ kind: 'none' })
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
    expect(view.blocked.hosts[0]!.from).toEqual(['implement · agent', 'review · cold'])
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
      [['implement · agent'], '0.0.83'],
      [['review · cold'], '0.0.90'],
    ])
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
      '/recipe/my%20proj?edit=1&allow=registry.example.com#sandbox',
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
    expect(html).toContain('href="/recipe/p?edit=1&amp;allow=ok.example.com#sandbox"')
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
    expect(tabPath('ticket-p-1', 'sandbox')).toBe('/task/ticket-p-1/sandbox')
    expect(sandboxTabPath('ticket-p-1', 2)).toBe('/task/ticket-p-1/sandbox?attempt=2')
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
