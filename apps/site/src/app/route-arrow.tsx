'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * The hand-drawn line from the ledger's *When something breaks* row to the heading of the failure paths
 * (#1291, the mock `doc/design/smart-routing.html`). It is one SVG positioned from three things found by data
 * attribute inside the element it is rendered in: `data-route-from` (the row's *See how ↓*), `data-route-table`
 * (the ledger's table) and `data-route-to` (the heading and its legend).
 *
 * It never crosses the table by construction: every point it draws while it is level with the table is at
 * least `MARGIN` right of the table's edge, and it turns toward the bracket only below the table's bottom.
 * When the gutter is narrower than `MIN_GUTTER` nothing is drawn, and the *See how ↓* link is the way there.
 * Imports nothing outside `react`.
 */

const MIN_GUTTER = 90
const MARGIN = 14

type Geo = { w: number; h: number; line: string; head: string; bracket: string; noteX: number; noteY: number }

function measure(box: HTMLElement): Geo | null {
  const from = box.querySelector<HTMLElement>('[data-route-from]')
  const table = box.querySelector<HTMLElement>('[data-route-table]')
  const to = box.querySelector<HTMLElement>('[data-route-to]')
  if (!from || !table || !to) return null
  const b = box.getBoundingClientRect()
  const f = from.getBoundingClientRect()
  const t = table.getBoundingClientRect()
  const h = to.getBoundingClientRect()
  const tableRight = t.right - b.left
  const tableBottom = t.bottom - b.top
  const gutter = b.width - tableRight
  if (h.width === 0) return null
  const top = h.top - b.top
  const bottom = h.bottom - b.top
  // The bracket belongs to the heading and stays; only the line into it needs the gutter.
  const drawLine = gutter >= MIN_GUTTER && f.width > 0 && top - tableBottom >= 24

  const x0 = tableRight + MARGIN
  const y0 = f.top - b.top + f.height / 2
  const lane = tableRight + Math.min(gutter * 0.5, 56)
  const mid = (top + bottom) / 2
  const bx = Math.min(h.right - b.left + 14, b.width - 14)
  const tip = bx + 8
  const turn = Math.max(top, tableBottom + 8)
  const n = (v: number) => Math.round(v * 10) / 10

  const line = !drawLine
    ? ''
    : `M ${n(x0)} ${n(y0)} C ${n(x0 + 30)} ${n(y0 - 4)}, ${n(lane)} ${n(y0 + 6)}, ${n(lane)} ${n(y0 + 52)} ` +
      `L ${n(lane)} ${n(turn)} C ${n(lane)} ${n(mid)}, ${n(lane - 40)} ${n(mid - 4)}, ${n(tip + 6)} ${n(mid)}`
  const head = !drawLine
    ? ''
    : `M ${n(tip + 16)} ${n(mid - 7)} L ${n(tip + 5)} ${n(mid)} L ${n(tip + 15)} ${n(mid + 8)}`
  const bracket =
    `M ${n(bx - 8)} ${n(top + 2)} C ${n(bx + 2)} ${n(top)}, ${n(bx + 5)} ${n(top + 6)}, ${n(bx + 4)} ${n(top + 16)} ` +
    `L ${n(bx + 5)} ${n(bottom - 16)} C ${n(bx + 5)} ${n(bottom - 6)}, ${n(bx + 2)} ${n(bottom)}, ${n(bx - 8)} ${n(bottom - 2)}`
  return { w: n(b.width), h: n(bottom + 10), line, head, bracket, noteX: n(lane + 10), noteY: n(y0 + 86) }
}

export function RouteArrow() {
  const ref = useRef<HTMLDivElement>(null)
  const [geo, setGeo] = useState<Geo | null>(null)

  useEffect(() => {
    const box = ref.current?.parentElement
    if (!box) return
    let live = true
    const redraw = () => {
      if (!live) return
      const next = measure(box)
      setGeo((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
    }
    redraw()
    const ro = new ResizeObserver(redraw)
    ro.observe(box)
    // The body face may still be swapping in: the row and the heading move when it lands.
    document.fonts?.ready.then(redraw, () => {})
    return () => {
      live = false
      ro.disconnect()
    }
  }, [])

  return (
    <div className="route-arrow" ref={ref} aria-hidden="true">
      {geo ? (
        <svg width={geo.w} height={geo.h} viewBox={`0 0 ${geo.w} ${geo.h}`}>
          <defs>
            <filter id="route-rough" x="-5%" y="-5%" width="110%" height="110%">
              <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2" seed="4" result="n" />
              <feDisplacementMap in="SourceGraphic" in2="n" scale="3" />
            </filter>
          </defs>
          <g
            filter="url(#route-rough)"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {geo.line ? <path d={geo.line} /> : null}
            {geo.head ? <path d={geo.head} /> : null}
            <path d={geo.bracket} />
          </g>
          {geo.line ? (
            <text className="ra-note" x={geo.noteX} y={geo.noteY}>
              here&apos;s how
            </text>
          ) : null}
        </svg>
      ) : null}
    </div>
  )
}
