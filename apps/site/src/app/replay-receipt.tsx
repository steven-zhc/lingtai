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
 * alone, the scene where the change merges.
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
    hint: 'Scroll down to fill in the receipt.',
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
    hint: 'The agent picked up the ticket.',
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
    hint: 'The agent committed its change.',
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
    hint: 'Checks failed. Fix round 1.',
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
    hint: 'The cold review found a bug. Fix round 2.',
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
    hint: 'Ready to land. Waiting for you.',
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
    hint: 'Landed. Click a line to see that step.',
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

/** Pixels from the window's top: a scene's command crossing this line is that step reached. */
const READ_LINE = 340

export function ReplayReceipt() {
  const [step, setStep] = useState(0)

  useEffect(() => {
    // A step is reached when its scene's command — the terminal or the approval
    // frame — has scrolled up to a fixed line, where a reader's eye is. A fixed
    // distance from the top rather than a share of the window: the middle of the
    // window advanced the receipt while the scene was still below what was being
    // read.
    const marks = Array.from(document.querySelectorAll<HTMLElement>('.rp-scene[data-step]'), (scene) => ({
      n: Number(scene.dataset.step),
      at: scene.querySelector<HTMLElement>('.term, .frame') ?? scene,
    }))
    let frame = 0
    const settle = () => {
      frame = 0
      let n = 0
      for (const m of marks) if (m.at.getBoundingClientRect().top <= READ_LINE) n = Math.max(n, m.n)
      setStep(n)
    }
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(settle)
    }
    settle()
    addEventListener('scroll', onScroll, { passive: true })
    addEventListener('resize', onScroll)
    return () => {
      removeEventListener('scroll', onScroll)
      removeEventListener('resize', onScroll)
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <aside className="tale-side" id="rp-side" aria-label="The receipt for this ticket, filling in as you scroll">
      <Receipt {...propsAt(step)} />
    </aside>
  )
}
