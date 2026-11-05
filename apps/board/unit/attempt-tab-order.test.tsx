import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AttemptTab } from '../src/app/attempt-tab.tsx'
import { RecordTabRow } from '../src/app/record-tab-row.tsx'
import type { AttemptTabDetail, AttemptView, StandingView } from '../src/lib/task.ts'

const run = (attempt: number, over: Partial<AttemptView> = {}): AttemptView =>
  ({
    runId: `pass-0000000${attempt}-aaaa-bbbb-cccc-dddddddddddd`,
    attempt,
    at: '2026-11-01T10:00:00.000Z',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    configHash: null,
    turns: 12,
    costUsd: { reportedCents: 438, reportedRuns: 1, estimates: [], unknown: 0 },
    durationMs: 60_000,
    outcome: { state: 'finished', detail: null },
    files: [{ path: 'apps/board/a.ts', op: 'edit' }],
    diff: { branch: 'agent/885', files: 1, insertions: 3, deletions: 1 },
    prompt: { version: 'ticket@1', bytes: 1234, text: 'do the thing' },
    awaitingSha: null,
    steps: [],
    progress: null,
    ...over,
  }) as unknown as AttemptView

const standing = (over: Partial<StandingView> = {}): StandingView =>
  ({
    state: 'blocked',
    runId: null,
    deciding: { attempt: 1 },
    diagnosis: { raw: 'the refusal, verbatim', what: 'it refused', done: null, recommendation: null },
    saidBy: 'proposed:review',
    ...over,
  }) as unknown as StandingView

const tab = (r: AttemptView, s: StandingView) => {
  const detail: AttemptTabDetail = {
    taskId: 'ticket-lingtai-885',
    project: 'lingtai',
    run: r,
    standing: s,
    events: [],
    promptShown: null,
    expanded: new Map(),
  }
  return renderToStaticMarkup(<AttemptTab detail={detail} now={Date.parse('2026-11-02T10:00:00Z')} />)
}

describe("an attempt's tab (#885)", () => {
  it('reads summary, base/head, Steps, then Changes, Prompt, Recipe, Run log and Events, closed', () => {
    const html = tab(run(1), standing({ state: 'landed', diagnosis: null }))
    const order = [
      'class="asum"',
      'class="ameta"',
      '>Steps<',
      '>Changes<',
      '>Prompt<',
      '>Recipe<',
      '>run log<',
      '>Events<',
    ]
    const at = order.map((s) => html.indexOf(s))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(html).not.toContain('open=""')
  })

  it('puts the wait’s reasoning only on the attempt the page is deciding on, before the sections', () => {
    const deciding = tab(run(1), standing())
    expect(deciding).toContain('the refusal, verbatim')
    expect(deciding.indexOf('the refusal, verbatim')).toBeLessThan(deciding.indexOf('>Changes<'))
    expect(deciding.indexOf('>Steps<')).toBeLessThan(deciding.indexOf('the refusal, verbatim'))
    // Attempt 2 of the same blocked ticket is not the one being decided.
    expect(tab(run(2), standing())).not.toContain('the refusal, verbatim')
  })

  it('shows no run id as text, and keeps it in the title', () => {
    const r = run(1)
    const html = tab(r, standing({ state: 'landed', diagnosis: null }))
    expect(html.replace(/<[^>]*>/g, ' ')).not.toContain('pass-')
    expect(html).toContain(`title="${r.runId}"`)
    expect(html.replace(/<[^>]*>/g, ' ')).not.toContain('the run')
  })

  it('captions the prompt by its size, with the version in a title', () => {
    const html = tab(run(1), standing({ state: 'landed', diagnosis: null }))
    expect(html).toContain('<span class="hdocsize" title="ticket@1">1234 bytes</span>')
  })
})

describe('the tab row', () => {
  const facts = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ attempt: i + 1, outcome: 'finished', cost: '$4.38' }))
  const row = (n: number, deciding: number | null, fallback: number | 'ticket') =>
    renderToStaticMarkup(
      <RecordTabRow
        taskId="ticket-lingtai-885"
        attempts={facts(n)}
        deciding={deciding}
        events={12}
        fallback={fallback === 'ticket' ? 'ticket' : { attempt: fallback }}
      />,
    )

  it('marks the default tab selected at /task/<id>, where the router names none', () => {
    const html = row(3, null, 3)
    expect(html).toMatch(
      /href="\/task\/ticket-lingtai-885\/attempt\/3"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/task\/ticket-lingtai-885\/attempt\/3"/,
    )
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
  })

  it('labels a tab with its outcome and cost, and the Ticket with its event count', () => {
    const html = row(1, null, 1)
    expect(html).toContain('Attempt 1')
    expect(html).toContain('finished · $4.38')
    expect(html).toContain('12 events')
  })

  it('puts attempts beyond the three newest, the deciding one apart, under earlier attempts', () => {
    const html = row(6, 2, 6)
    expect(html.indexOf('Attempt 2')).toBeLessThan(html.indexOf('Earlier attempts'))
    const earlier = html.slice(html.indexOf('Earlier attempts'))
    expect(earlier).toContain('Attempt 3')
    expect(earlier).toContain('Attempt 1')
    expect(earlier).not.toContain('Attempt 2')
  })
})
