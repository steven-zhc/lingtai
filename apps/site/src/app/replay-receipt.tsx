'use client'

import { useEffect, useState } from 'react'

import { Receipt, type ReceiptProps, type ReceiptStatus } from './receipt'

/**
 * The one receipt beside the hero and the replay.
 *
 * It renders only the side column. The scenes are server markup in `page.tsx`
 * (`.rp-scene[data-step]`); this finds them in an effect and shows the step in
 * view, so the page stays static and the server render is state 0 — a reader
 * without script sees an empty receipt, never a landed one that script empties.
 *
 * Every value is an illustration and says so. The stamp is shown at step 6
 * alone, which is the empty sentinel past the last scene.
 */

export interface ReceiptState {
  statusKind: ReceiptStatus
  status: string
  impl: string
  checks: string
  review: string
  approve: string
  /** Cents, so "never decreases" is a comparison of numbers. */
  cents: number
  stamped: boolean
  hint: string
}

const DASH = '—'
const FIXED = '✗ → ✓ after 1 round'

export const STEPS = 6

// Step 1-4 are `running`, not the mock's `wait` for the fix rounds: `--signal`
// means a person is being waited on now (site.css), and that is step 5 alone.
const STATES: readonly ReceiptState[] = [
  {
    statusKind: 'queued',
    status: 'Queued',
    impl: DASH,
    checks: DASH,
    review: DASH,
    approve: DASH,
    cents: 0,
    stamped: false,
    hint: 'Scroll — the receipt fills in as it happens.',
  },
  {
    statusKind: 'running',
    status: 'Taken · 22:40',
    impl: DASH,
    checks: DASH,
    review: DASH,
    approve: DASH,
    cents: 0,
    stamped: false,
    hint: 'The ticket is taken.',
  },
  {
    statusKind: 'running',
    status: 'Implementing',
    impl: '3 files changed',
    checks: DASH,
    review: DASH,
    approve: DASH,
    cents: 14,
    stamped: false,
    hint: "The agent's commit is kept.",
  },
  {
    statusKind: 'running',
    status: 'Fix round 1',
    impl: '3 files changed',
    checks: FIXED,
    review: DASH,
    approve: DASH,
    cents: 23,
    stamped: false,
    hint: 'Your checks refused. A counted round.',
  },
  {
    statusKind: 'running',
    status: 'Fix round 2',
    impl: '3 files changed',
    checks: FIXED,
    review: FIXED,
    approve: DASH,
    cents: 38,
    stamped: false,
    hint: 'The review refused once. Another round.',
  },
  {
    statusKind: 'waiting',
    status: 'Waiting for you',
    impl: '3 files changed',
    checks: FIXED,
    review: FIXED,
    approve: 'waiting…',
    cents: 38,
    stamped: false,
    hint: 'Ready to land. It asks you first.',
  },
  {
    statusKind: 'landed',
    status: '✓ Landed',
    impl: '3 files changed',
    checks: FIXED,
    review: FIXED,
    approve: 'You, 07:31',
    cents: 40,
    stamped: true,
    hint: 'Landed. Each line opens its moment.',
  },
]

export function receiptAt(step: number): ReceiptState {
  return STATES[Math.max(0, Math.min(STEPS, Math.trunc(step)))]!
}

export const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`

function propsAt(step: number): ReceiptProps {
  const s = receiptAt(step)
  const row = (key: string, value: string, n: number, muted = false) => ({
    key,
    value,
    href: `#s${n}`,
    step: n,
    muted: muted || value === DASH,
  })
  return {
    live: true,
    announce: true,
    current: step,
    issue: 'ISSUE #1 · CHAPTER-GARDEN',
    title: 'Add a reading-time badge',
    status: { kind: s.statusKind, text: s.status },
    rows: [
      row('Implementation', s.impl, 2),
      row('Checks', s.checks, 3),
      row('Cold review', s.review, 4),
      row('Approved by', s.approve, 5, s.approve === 'waiting…'),
    ],
    costLabel: 'RECORDED COST',
    cost: dollars(s.cents),
    stamp: { text: 'LANDED', shown: s.stamped },
    footnote: (
      <>
        <span className="tag ill">ILLUSTRATION</span> <span>{s.hint}</span>
      </>
    ),
  }
}

export function ReplayReceipt() {
  const [step, setStep] = useState(0)

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const scenes = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setStep(Number((e.target as HTMLElement).dataset.step))
      },
      { rootMargin: '-48% 0px -48% 0px' },
    )
    document.querySelectorAll('.rp-scene[data-step]').forEach((n) => scenes.observe(n))
    const hero = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setStep(0)
      },
      { threshold: 0.6 },
    )
    const h = document.querySelector('.hero')
    if (h) hero.observe(h)
    return () => {
      scenes.disconnect()
      hero.disconnect()
    }
  }, [])

  return (
    <aside className="tale-side" id="rp-side" aria-label="The receipt for this ticket, filling in as you scroll">
      <Receipt {...propsAt(step)} />
    </aside>
  )
}
