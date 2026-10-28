import type { SpendRow } from '@lingtai/projector'
/**
 * The `/spend` table never prints `$0.00` for a bill with an unknown run in
 * it (`#498`, the ticket's own `Done when`).
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SpendTable } from '../src/app/spend-table.tsx'
import { billOf } from '../src/lib/spend.ts'

function row(over: Partial<SpendRow> = {}): SpendRow {
  return {
    seq: '1',
    at: new Date('2026-09-10T00:00:00Z'),
    streamId: 'pass-1',
    ticket: 'ticket-pin-1',
    project: 'pin',
    pass: 'pass-1',
    purpose: 'Action',
    step: 'proposed',
    action: 'build',
    round: 0,
    runtime: 'claude-code',
    turns: 1,
    durationMs: 1000,
    costUsd: 0.1,
    usage: [],
    estimatedUsd: null,
    estimateFetched: null,
    kind: null,
    ...over,
  }
}

describe('the /spend table', () => {
  /**
   * One ticket: a reported Work run, an unreported Work run, and one run of
   * every other `for` — the shape the ticket's `Done when` asks for.
   */
  it('shows the reported total, the unknown count, and no $0.00 for the unknown', () => {
    const rows = [
      row({ purpose: 'Action', round: 0, costUsd: 3.1 }),
      row({ purpose: 'Action', round: 0, costUsd: null }),
      row({ purpose: 'Action', round: 1, costUsd: 1.5 }),
      row({ purpose: 'Judge', round: null, costUsd: 0.5 }),
      row({ purpose: 'Triage', round: null, costUsd: null }),
      row({ purpose: 'Discussion', round: null, costUsd: 0.25 }),
    ]
    const byPurpose = billOf(rows)
    const total = { project: 'all', cards: 1, byPurpose }

    const html = renderToStaticMarkup(<SpendTable rows={[{ project: 'pin', cards: 1, byPurpose }]} total={total} />)

    // Work: one reported $3.10 and one unknown — shown together, never as $0.00.
    expect(html).toContain('$3.10 + 1 unknown')
    expect(html).not.toContain('$0.00')
    // Answering, Judge and Discussion each reported in full.
    expect(html).toContain('$1.50')
    expect(html).toContain('$0.50')
    expect(html).toContain('$0.25')
    // Triage reported nothing at all — unknown, not a dollar figure.
    expect(html).toContain('unknown (1 run)')
  })

  it('says — for a repository with nothing spent', () => {
    const empty = billOf([])
    const html = renderToStaticMarkup(
      <SpendTable
        rows={[{ project: 'quiet', cards: 1, byPurpose: empty }]}
        total={{ project: 'all', cards: 1, byPurpose: empty }}
      />,
    )
    expect(html).toContain('—')
    expect(html).not.toContain('$0.00')
  })

  it('says the fetched-prices note on a run priced from the snapshot', () => {
    const byPurpose = billOf([row({ costUsd: null, estimatedUsd: 0.5, estimateFetched: true })])
    const total = { project: 'all', cards: 1, byPurpose }
    const html = renderToStaticMarkup(<SpendTable rows={[{ project: 'pin', cards: 1, byPurpose }]} total={total} />)
    expect(html).toContain('~$0.50 est. (1 at fetched LiteLLM prices)')
  })
})
