import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { DecideFinding } from '../src/app/backlog/decide-finding.tsx'
import { Card } from '../src/app/page.tsx'
import type { BoardCard } from '../src/lib/board.ts'
import { emptyBill } from '../src/lib/spend.ts'

// #1458: a decision block (one card, one row, one panel) shows at most one primary, and a list of them
// keeps one on each. The task page's own count lives in standing.test.tsx.
const base = {
  taskId: 't',
  project: 'p',
  ref: '1',
  kind: 'bug',
  title: 'T',
  costUsd: emptyBill(),
  repairCostUsd: emptyBill(),
} as unknown as BoardCard

const count = (html: string) => html.match(/\bbtn pri\b/g)?.length ?? 0

describe('one primary per decision block', () => {
  it('a waiting home card has exactly one, small', () => {
    const card = {
      ...base,
      column: 'waiting',
      note: null,
      short: null,
      cause: null,
      triage: null,
      waitId: 'w1',
      move: { resolution: 'StartNewAttempt', onSha: null, note: null },
    } as unknown as BoardCard
    const html = renderToStaticMarkup(<Card card={card} showProject={false} issue={null} paused={false} />)
    expect(count(html)).toBe(1)
    expect(html).toContain('btn pri sm')
  })

  it('a queued home card has none, and its Close is small', () => {
    const html = renderToStaticMarkup(
      <Card card={{ ...base, column: 'queued' } as BoardCard} showProject={false} issue={null} paused={false} />,
    )
    expect(count(html)).toBe(0)
    expect(html).toContain('btn sm')
  })

  it('a backlog row has exactly one, small', () => {
    const html = renderToStaticMarkup(<DecideFinding project="p" entryKey="k" />)
    expect(count(html)).toBe(1)
    expect(html).toContain('btn pri sm')
  })
})
