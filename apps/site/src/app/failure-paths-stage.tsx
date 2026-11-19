'use client'

import { useEffect, useRef } from 'react'

/**
 * The drawing for "When it fails" (#1265; the agreed mock `doc/design/failure-paths.html`, whose script this is).
 * It holds no copy of its own: each item's words are read from the server-rendered list in the same section,
 * so the drawing and the list cannot disagree. What lives here is the *shape* of each path, which is drawing.
 * Imports nothing outside `react` — no `@lingtai/*` — which only the Next build can check.
 */

type Pt = [number, number, number?]
type Op = {
  mark?: Pt
  line?: Pt[]
  lines?: { pts: Pt[]; cls?: string }[]
  loop?: Pt
  pause?: number
  jump?: Pt
  kind?: string
  label?: string
  glyph?: string
  side?: string
  pre?: Pt[]
  who?: string | null
  cls?: string
  twin?: number
  labelAt?: Pt
  clock?: boolean
  n?: number
  hide?: string[]
  fadeOnly?: boolean
  slow?: boolean
  alt?: boolean
  dotLabel?: string
}
type Path = { base: Op[]; keep?: number; ext?: Op[] }
type Item = { key: string; say: string; what: string; bound: string; extText: string; ask: Element | null }

const R = 0
const L = 1
const Y = 2

const BR = [-16, -32, -48]
const RUN = [
  [38, 52],
  [52, 66],
  [66, 78],
]

function flaky(): Op[] {
  const o: Op[] = [{ mark: [R, 18], kind: 'fail', label: 'red again', side: 'above', alt: true }]
  let u = 26
  o.push({
    line: [
      [R, 18],
      [R, u],
    ],
  })
  for (let k = 1; k <= 6; k++) {
    o.push({
      line: [
        [R, u],
        [R, u + 7],
      ],
      twin: -7,
    })
    o.push({ mark: [R, u + 3.5, -7], kind: 'tick', label: String(k), side: 'above' })
    if (k === 3) o.push({ mark: [R, u + 3.5], kind: 'none', label: 'agent fixes on top · 1–6' })
    u += 7
  }
  o.push({ mark: [R, u], kind: 'fail', label: 'still red' })
  o.push({
    line: [
      [R, u],
      [L, u + 6],
    ],
  })
  o.push({ mark: [L, u + 6], kind: 'look', label: 'closer look' })
  o.push({
    line: [
      [L, u + 6],
      [Y, u + 12],
    ],
  })
  o.push({
    mark: [Y, u + 16],
    kind: 'you',
    glyph: '!',
    label: 'asks you',
    pre: [
      [Y, u + 12],
      [Y, u + 16],
    ],
  })
  return o
}

function review(): Op[] {
  const o: Op[] = []
  let u = 48
  for (let k = 2; k <= 6; k++) {
    o.push({
      line: [
        [R, u],
        [R, u + 1.5],
      ],
    })
    o.push({
      line: [
        [R, u + 1.5],
        [L, u + 3.5],
      ],
      who: 'main',
    })
    o.push({
      line: [
        [L, u + 3.5],
        [R, u + 5.5],
      ],
    })
    o.push({
      line: [
        [R, u + 5.5],
        [R, u + 7.5],
      ],
      twin: -7,
    })
    o.push({ mark: [R, u + 6.5, -7], kind: 'tick', label: String(k), side: 'above' })
    u += 7.5
  }
  o.push({
    mark: [R, u + 1],
    kind: 'fail',
    label: 'still refused',
    pre: [
      [R, u],
      [R, u + 1],
    ],
  })
  o.push({
    line: [
      [R, u + 1],
      [L, u + 5],
    ],
  })
  o.push({ mark: [L, u + 5], kind: 'look', label: 'closer look' })
  o.push({
    line: [
      [L, u + 5],
      [Y, u + 9],
    ],
  })
  o.push({
    mark: [Y, u + 12],
    kind: 'you',
    glyph: '!',
    label: 'asks you',
    pre: [
      [Y, u + 9],
      [Y, u + 12],
    ],
  })
  return o
}

function unclear(): Op[] {
  const o: Op[] = []
  let u = 28
  for (let k = 2; k <= 5; k++) {
    o.push({
      line: [
        [Y, u],
        [Y, u + 12],
      ],
    })
    o.push({ mark: [Y, u + 12], kind: 'ask', n: k, label: k === 2 ? 'asks again' : '' })
    o.push({ pause: 500 })
    o.push({ mark: [Y, u + 12], kind: 'answered', label: '' })
    u += 12
  }
  o.push({
    line: [
      [Y, u],
      [Y, u + 12],
    ],
  })
  o.push({ mark: [Y, u + 12], kind: 'you', glyph: '!', label: 'stops asking · 5 of 5' })
  return o
}

function mainExt(): Op[] {
  const o: Op[] = []
  let u = 30
  for (let k = 2; k <= 10; k++) {
    o.push({
      line: [
        [R, u + 1, -26],
        [R, u + 5, 0],
      ],
      cls: 'side',
      who: null,
      fadeOnly: true,
    })
    o.push({
      line: [
        [R, u],
        [R, u + 5],
      ],
    })
    o.push({ mark: [R, u + 1, -26], kind: 'tick', label: String(k), side: 'above' })
    u += 5
  }
  o.push({
    mark: [R, u + 3],
    kind: 'fail',
    label: 'still moving',
    pre: [
      [R, u],
      [R, u + 3],
    ],
  })
  o.push({
    line: [
      [R, u + 3],
      [Y, u + 10],
    ],
  })
  o.push({
    mark: [Y, u + 14],
    kind: 'you',
    glyph: '!',
    label: 'asks you',
    pre: [
      [Y, u + 10],
      [Y, u + 14],
    ],
  })
  return o
}

/** Lanes: R = Rule, L = One look, Y = You. A point is [lane, u, o]: u is progress 0–100 along time, o a pixel offset across it. */
const P: Record<string, Path> = {
  api: {
    base: [
      { mark: [R, 2], kind: 'start', label: 'working' },
      {
        line: [
          [R, 2],
          [R, 15],
        ],
      },
      { mark: [R, 15], kind: 'fail', label: 'API down' },
      {
        line: [
          [R, 15],
          [R, 27],
        ],
      },
      { mark: [R, 27], kind: 'commit', label: 'work saved' },
      {
        line: [
          [R, 27],
          [R, 40],
        ],
      },
      { loop: [R, 40], clock: true, label: 'wait 1 min', n: 1 },
      { mark: [R, 40], kind: 'none', label: 'redo from save' },
      {
        line: [
          [R, 40],
          [R, 66],
        ],
      },
      { mark: [R, 66], kind: 'ok', label: 'checks ✓ review ✓' },
      {
        line: [
          [R, 66],
          [R, 94],
        ],
      },
      { mark: [R, 94], kind: 'land', label: 'landed' },
    ],
    keep: 7,
    ext: [
      {
        line: [
          [R, 40],
          [R, 52],
        ],
      },
      { loop: [R, 52], clock: true, label: 'wait 5 min', n: 2 },
      {
        line: [
          [R, 52],
          [R, 64],
        ],
      },
      { loop: [R, 64], clock: true, label: 'wait 15 min', n: 3 },
      {
        line: [
          [R, 64],
          [R, 74],
        ],
      },
      { mark: [R, 74], kind: 'fail', label: 'down again' },
      {
        line: [
          [R, 74],
          [Y, 84],
        ],
      },
      {
        mark: [Y, 90],
        kind: 'you',
        glyph: '!',
        label: 'asks you · 3 of 3 used',
        pre: [
          [Y, 84],
          [Y, 90],
        ],
      },
    ],
  },
  flaky: {
    base: [
      { mark: [R, 2], kind: 'start', label: 'working' },
      {
        line: [
          [R, 2],
          [R, 18],
        ],
      },
      { mark: [R, 18], kind: 'fail', label: 'checks red' },
      { mark: [R, 18], kind: 'rerun', label: 'rerun at once', side: 'above' },
      { mark: [R, 18], kind: 'ok', label: '' },
      {
        line: [
          [R, 18],
          [R, 30, 34],
        ],
        cls: 'thin',
        who: null,
      },
      { mark: [R, 30, 34], kind: 'pin', label: 'flaky test noted', side: 'right' },
      {
        line: [
          [R, 18],
          [R, 62],
        ],
      },
      { mark: [R, 62], kind: 'ok', label: 'review ✓' },
      {
        line: [
          [R, 62],
          [R, 94],
        ],
      },
      { mark: [R, 94], kind: 'land', label: 'landed' },
    ],
    keep: 4,
    ext: flaky(),
  },
  review: {
    base: [
      { mark: [R, 2], kind: 'start', label: 'working' },
      {
        line: [
          [R, 2],
          [R, 14],
        ],
      },
      { mark: [R, 14], kind: 'fail', label: 'review: a bug' },
      {
        line: [
          [R, 14],
          [R, 32],
        ],
        cls: 'thin',
        who: null,
      },
      {
        line: [
          [R, 14],
          [L, 22],
        ],
      },
      {
        mark: [L, 24],
        kind: 'look',
        label: 'names the lines',
        pre: [
          [L, 22],
          [L, 24],
        ],
      },
      {
        line: [
          [L, 24],
          [R, 32],
        ],
      },
      {
        line: [
          [R, 32],
          [R, 48],
        ],
        twin: -7,
        label: 'fix on top',
        labelAt: [R, 40, -7],
      },
      {
        line: [
          [R, 48],
          [R, 64],
        ],
      },
      { mark: [R, 64], kind: 'ok', label: 'checks ✓ review ✓' },
      {
        line: [
          [R, 64],
          [R, 94],
        ],
      },
      { mark: [R, 94], kind: 'land', label: 'landed' },
    ],
    keep: 8,
    ext: review(),
  },
  unclear: {
    base: [
      { mark: [R, 2], kind: 'start', label: 'planning' },
      {
        line: [
          [R, 2],
          [R, 14],
        ],
      },
      { mark: [R, 14], kind: 'fail', glyph: '?', label: 'ticket unclear' },
      {
        line: [
          [R, 14],
          [R, 40],
        ],
        cls: 'thin',
        who: null,
      },
      {
        line: [
          [R, 14],
          [Y, 24],
        ],
      },
      {
        mark: [Y, 28],
        kind: 'ask',
        label: 'asks you 1 question',
        pre: [
          [Y, 24],
          [Y, 28],
        ],
      },
      { pause: 1500 },
      { mark: [Y, 28], kind: 'answered', label: 'you answered', side: 'above' },
      {
        line: [
          [Y, 28],
          [R, 40],
        ],
      },
      { mark: [R, 40], kind: 'none', label: 'carries on' },
      {
        line: [
          [R, 40],
          [R, 64],
        ],
      },
      { mark: [R, 64], kind: 'ok', label: 'checks ✓ review ✓' },
      {
        line: [
          [R, 64],
          [R, 94],
        ],
      },
      { mark: [R, 94], kind: 'land', label: 'landed' },
    ],
    keep: 8,
    ext: unclear(),
  },
  big: {
    base: [
      { mark: [R, 2], kind: 'start', label: 'working' },
      {
        line: [
          [R, 2],
          [R, 12],
        ],
      },
      { mark: [R, 12], kind: 'fail', label: 'out of time' },
      {
        line: [
          [R, 12],
          [L, 20],
        ],
      },
      {
        mark: [L, 23],
        kind: 'look',
        label: 'split into 3',
        pre: [
          [L, 20],
          [L, 23],
        ],
      },
      {
        line: [
          [L, 23],
          [R, 32],
        ],
      },
      {
        lines: [
          {
            pts: [
              [R, 32],
              [R, 36, BR[0]],
              [R, RUN[0]![0]!, BR[0]],
            ],
            cls: 'dash',
          },
          {
            pts: [
              [R, 32],
              [R, 36, BR[1]],
              [R, RUN[1]![0]!, BR[1]],
            ],
            cls: 'dash',
          },
          {
            pts: [
              [R, 32],
              [R, 36, BR[2]],
              [R, RUN[2]![0]!, BR[2]],
            ],
            cls: 'dash',
          },
          {
            pts: [
              [R, 32],
              [R, 84],
            ],
            cls: 'dash',
          },
        ],
      },
      { mark: [R, RUN[0]![0]!, BR[0]], kind: 'none', label: '#1', side: 'left' },
      { mark: [R, RUN[1]![0]!, BR[1]], kind: 'none', label: '#2', side: 'left' },
      { mark: [R, RUN[2]![0]!, BR[2]], kind: 'none', label: '#3', side: 'left' },
      { mark: [R, 58], kind: 'none', label: 'your ticket waits' },
      {
        line: [
          [R, RUN[0]![0]!, BR[0]],
          [R, RUN[0]![1]!, BR[0]],
        ],
        who: 'b0',
        dotLabel: '#1',
      },
      { mark: [R, RUN[0]![1]!, BR[0]], kind: 'okSm', label: '' },
      {
        line: [
          [R, RUN[1]![0]!, BR[1]],
          [R, RUN[1]![1]!, BR[1]],
        ],
        who: 'b1',
      },
      { mark: [R, RUN[1]![1]!, BR[1]], kind: 'okSm', label: '' },
      {
        line: [
          [R, RUN[2]![0]!, BR[2]],
          [R, RUN[2]![1]!, BR[2]],
        ],
        who: 'b2',
      },
      { mark: [R, RUN[2]![1]!, BR[2]], kind: 'okSm', label: '' },
      {
        lines: [
          {
            pts: [
              [R, RUN[0]![1]!, BR[0]],
              [R, 80, BR[0]],
              [R, 84, 0],
            ],
          },
          {
            pts: [
              [R, RUN[1]![1]!, BR[1]],
              [R, 80, BR[1]],
              [R, 84, 0],
            ],
          },
          {
            pts: [
              [R, RUN[2]![1]!, BR[2]],
              [R, 80, BR[2]],
              [R, 84, 0],
            ],
          },
        ],
        hide: ['b0', 'b1', 'b2'],
      },
      { mark: [R, 84], kind: 'none', label: 'back together' },
      { jump: [R, 84] },
      {
        line: [
          [R, 84],
          [R, 90],
        ],
      },
      { mark: [R, 90], kind: 'ok', label: 'checks its own list', side: 'above' },
      {
        line: [
          [R, 90],
          [R, 96],
        ],
      },
      { mark: [R, 96], kind: 'land', label: 'landed' },
    ],
    keep: 13,
    ext: [
      {
        line: [
          [R, RUN[1]![0]!, BR[1]],
          [R, 59, BR[1]],
        ],
        who: 'b1',
      },
      { mark: [R, 59, BR[1]], kind: 'failSm', label: '#2 too big too', side: 'right' },
      {
        line: [
          [R, 59, BR[1]],
          [Y, 70],
        ],
        who: 'b1',
      },
      {
        mark: [Y, 76],
        kind: 'you',
        glyph: '!',
        label: 'asks you · split once',
        pre: [
          [Y, 70],
          [Y, 76],
        ],
        who: 'b1',
      },
    ],
  },
  main: {
    base: [
      { mark: [R, 2], kind: 'start', label: 'working' },
      {
        line: [
          [R, 2],
          [R, 22],
        ],
      },
      { mark: [R, 12, -46], kind: 'none', label: 'someone merged to main', side: 'above' },
      {
        line: [
          [R, 6, -46],
          [R, 22, -46],
          [R, 30, 0],
        ],
        cls: 'side',
        who: 'm',
      },
      {
        line: [
          [R, 22],
          [R, 30],
        ],
      },
      { mark: [R, 30], kind: 'merge', label: 'merged in', hide: ['m'] },
      {
        line: [
          [R, 30],
          [R, 46],
        ],
      },
      { mark: [R, 46], kind: 'ok', label: 'checks again ✓' },
      {
        line: [
          [R, 46],
          [R, 94],
        ],
      },
      { mark: [R, 94], kind: 'land', label: 'landed' },
    ],
    keep: 6,
    ext: mainExt(),
  },
  limit: {
    base: [
      { mark: [R, 2], kind: 'start', label: 'queued' },
      {
        line: [
          [R, 2],
          [R, 14],
        ],
      },
      { mark: [R, 14], kind: 'lock', label: 'limit reached' },
      {
        line: [
          [R, 14],
          [R, 50],
        ],
        cls: 'dash',
        slow: true,
      },
      { mark: [R, 32], kind: 'none', label: 'waits for reset · $0' },
      { mark: [R, 50], kind: 'unlock', label: 'resumes here' },
      {
        line: [
          [R, 50],
          [R, 68],
        ],
      },
      { mark: [R, 68], kind: 'ok', label: 'checks ✓ review ✓' },
      {
        line: [
          [R, 68],
          [R, 94],
        ],
      },
      { mark: [R, 94], kind: 'land', label: 'landed' },
    ],
  },
}

const NS = 'http://www.w3.org/2000/svg'
const LANE = ['rule', 'look', 'you']
const LANE_NAME = ['Rule', 'One look', 'You']
const LANE_SUB = [
  ['Free.', 'No AI decides.'],
  ['One quick look,', 'cents.'],
  ['Only when', 'it must.'],
]
const RAD = 14

type Geo = {
  wide: boolean
  W: number
  H: number
  head: number
  lanes: { top: number; h: number; line: number }[]
  cols: number[]
  top: number
  LX: number
  T: (u: number) => number
  Pl: (lane: number) => number
}

const f = (n: number) => Math.round(n * 10) / 10
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

function text(parent: Element, tag: string, className: string, content: string, attrs: Record<string, string> = {}) {
  const e = document.createElement(tag)
  e.className = className
  e.textContent = content
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  parent.append(e)
  return e
}

/** Mounts the picker and the drawing into `host`, reading the section's list. Returns what undoes it. */
function mount(host: HTMLElement, section: HTMLElement): () => void {
  const chipsBox = host.querySelector<HTMLElement>('.fp-chips')!
  const stage = host.querySelector<HTMLElement>('.fp-stage')!
  const svg = host.querySelector<SVGSVGElement>('.fp-svg')!
  const result = host.querySelector<HTMLElement>('.fp-result')!
  const askSlot = host.querySelector<HTMLElement>('.fp-askslot')!
  const out = host.querySelector<HTMLElement>('.fp-out')!
  const all = section.querySelector<HTMLDetailsElement>('.fp-all')

  const items: Item[] = [...section.querySelectorAll<HTMLElement>('.fp-item')].map((el) => ({
    key: el.dataset.key ?? '',
    say: el.querySelector('.fp-say')?.textContent ?? '',
    what: el.querySelector('.fp-what')?.textContent ?? '',
    bound: el.querySelector('.fp-bound')?.textContent ?? '',
    extText: el.querySelector('.fp-ext')?.textContent ?? '',
    ask: el.querySelector('.fp-ask'),
  }))

  const mq = matchMedia('(prefers-reduced-motion: reduce)')
  const reduce = () => mq.matches

  let G: Geo
  let trail: SVGGElement, dots: SVGGElement, marks: SVGGElement, labels: SVGGElement
  let boxes: { x0: number; y: number; w: number; h: number }[] = []
  let dotEls: Record<string, SVGCircleElement> = {}
  let lastLabelY = -Infinity
  let lastMark: SVGGElement | null = null
  let token = 0
  let state: { key: string; ext: boolean } | null = null
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const frames = new Set<number>()

  function layout() {
    const W = stage.clientWidth
    const wide = W >= 640
    if (wide) {
      const head = 150
      const padR = 30
      const lanes = [
        { top: 0, h: 140, line: 96 },
        { top: 140, h: 96, line: 44 },
        { top: 236, h: 96, line: 44 },
      ]
      G = {
        wide,
        W,
        H: 332,
        head,
        lanes,
        cols: [],
        top: 0,
        LX: 0,
        T: (u) => head + 24 + ((W - head - 24 - padR) * u) / 100,
        Pl: (lane) => lanes[lane]!.top + lanes[lane]!.line,
      }
    } else {
      const cols = [62, 116, 160]
      const top = 40
      const step = 6.4
      G = {
        wide,
        W,
        H: top + 100 * step + 30,
        head: 0,
        lanes: [],
        cols,
        top,
        LX: 196,
        T: (u) => top + step * u,
        Pl: (lane) => cols[lane]!,
      }
    }
  }
  const tp = ([lane, u, o = 0]: Pt) => ({ T: G.T(u), P: G.Pl(lane) + o })
  const xy = ({ T, P: p }: { T: number; P: number }) => (G.wide ? { x: T, y: p } : { x: p, y: T })
  const pt = (p: Pt) => xy(tp(p))

  function pathD(pts: Pt[]) {
    const q = pts.map(tp)
    let d = ''
    q.forEach((c, i) => {
      const a = xy(c)
      if (i === 0) {
        d += `M${f(a.x)} ${f(a.y)}`
        return
      }
      const p = q[i - 1]!
      if (Math.abs(c.P - p.P) < 0.5) {
        d += ` L${f(a.x)} ${f(a.y)}`
        return
      }
      const m = (p.T + c.T) / 2
      const c1 = xy({ T: m, P: p.P })
      const c2 = xy({ T: m, P: c.P })
      d += ` C${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(a.x)} ${f(a.y)}`
    })
    return d
  }
  function loopD(p: Pt) {
    const c = tp(p)
    const a = xy(c)
    const b = xy({ T: c.T, P: c.P - 2 * RAD })
    const sweep = G.wide ? 0 : 1
    return `M${f(a.x)} ${f(a.y)} A${RAD} ${RAD} 0 1 ${sweep} ${f(b.x)} ${f(b.y)} A${RAD} ${RAD} 0 1 ${sweep} ${f(a.x)} ${f(a.y)}`
  }

  /** Where a dot is a fraction of the way along a path, sampled from the same coordinates the path is drawn from. */
  type At = (frac: number) => { x: number; y: number }
  const sampled = (pts: { x: number; y: number }[]): At => {
    const cum = [0]
    for (let i = 1; i < pts.length; i++)
      cum.push(cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y))
    const total = cum[cum.length - 1] || 1
    return (frac) => {
      const want = Math.min(1, Math.max(0, frac)) * total
      let i = 1
      while (i < cum.length - 1 && cum[i]! < want) i++
      const span = cum[i]! - cum[i - 1]! || 1
      const k = Math.min(1, Math.max(0, (want - cum[i - 1]!) / span))
      const a = pts[i - 1]!
      const b = pts[i]!
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }
    }
  }
  function trackOf(pts: Pt[]): At {
    const q = pts.map(tp)
    const out = [xy(q[0]!)]
    for (let i = 1; i < q.length; i++) {
      const p = q[i - 1]!
      const c = q[i]!
      if (Math.abs(c.P - p.P) < 0.5) {
        out.push(xy(c))
        continue
      }
      const m = (p.T + c.T) / 2
      const p0 = xy(p)
      const c1 = xy({ T: m, P: p.P })
      const c2 = xy({ T: m, P: c.P })
      const p3 = xy(c)
      for (let n = 1; n <= 24; n++) {
        const t = n / 24
        const u = 1 - t
        out.push({
          x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
          y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
        })
      }
    }
    return sampled(out)
  }
  function loopTrack(p: Pt): At {
    const c = tp(p)
    const a = xy(c)
    const mid = xy({ T: c.T, P: c.P - RAD })
    const phi0 = Math.atan2(a.y - mid.y, a.x - mid.x)
    const dir = G.wide ? -1 : 1
    const out = []
    for (let n = 0; n <= 48; n++) {
      const th = phi0 + dir * ((2 * Math.PI * n) / 48)
      out.push({ x: mid.x + RAD * Math.cos(th), y: mid.y + RAD * Math.sin(th) })
    }
    return sampled(out)
  }

  function el<K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs: Record<string, string | number> = {},
    parent?: Element,
  ) {
    const e = document.createElementNS(NS, tag)
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
    if (parent) parent.append(e)
    return e
  }
  const size = () => {
    svg.setAttribute('viewBox', `0 0 ${G.W} ${G.H}`)
    svg.setAttribute('height', String(G.H))
  }

  function frame() {
    svg.replaceChildren()
    const title = el('title', { id: 'fp-svg-title' }, svg)
    title.textContent = 'The path this failure takes'
    size()
    const g = el('g', {}, svg)
    if (G.wide) {
      G.lanes.forEach((ln, i) => {
        el('rect', { x: 0, y: ln.top, width: G.W, height: ln.h, class: 'fp-band-' + LANE[i] }, g)
        if (i) el('line', { x1: 0, x2: G.W, y1: ln.top, y2: ln.top, class: 'fp-band-sep' }, g)
        el('line', { x1: G.head + 10, x2: G.W - 16, y1: ln.top + ln.line, y2: ln.top + ln.line, class: 'fp-guide' }, g)
        el('text', { x: 20, y: ln.top + ln.line - 6, class: 'fp-lane-name fp-' + LANE[i] }, g).textContent =
          LANE_NAME[i]!
        LANE_SUB[i]!.forEach((s, j) => {
          el('text', { x: 20, y: ln.top + ln.line + 12 + j * 14, class: 'fp-lane-sub' }, g).textContent = s
        })
      })
      el('line', { x1: G.head, x2: G.head, y1: 0, y2: G.H, class: 'fp-band-sep' }, g)
    } else {
      G.cols.forEach((x, i) => {
        const w = i === 0 ? 92 : 44
        const x0 = i === 0 ? x - 66 : x - 22
        el('rect', { x: x0, y: 0, width: w, height: G.H, class: 'fp-band-' + LANE[i] }, g)
        el('line', { x1: x, x2: x, y1: G.top - 6, y2: G.H - 14, class: 'fp-guide' }, g)
        el('text', { x, y: 18, class: 'fp-lane-head-sm fp-lane-name fp-' + LANE[i] }, g).textContent = LANE_NAME[i]!
      })
    }
    trail = el('g', {}, svg)
    dots = el('g', {}, svg)
    marks = el('g', {}, svg)
    labels = el('g', {}, svg)
    boxes = []
    dotEls = {}
    lastLabelY = -Infinity
    lastMark = null
  }

  function mark(op: Op) {
    const a = pt(op.mark!)
    const outer = el('g', { transform: `translate(${f(a.x)} ${f(a.y)})` }, marks)
    const g = el('g', { class: 'fp-mk' }, outer)
    const inner = el('g', {}, g)
    const circ = (r: number) => el('circle', { r, class: 'fp-bg' }, inner)
    const glyph = (s: string) => {
      el('text', {}, inner).textContent = s
    }
    switch (op.kind) {
      case 'start':
        g.classList.add('fp-mk-commit')
        circ(4.5)
        break
      case 'none':
        outer.remove()
        return { g: null, a }
      case 'fail':
        g.classList.add('fp-mk-fail')
        circ(9)
        glyph(op.glyph || '✕')
        break
      case 'failSm':
        g.classList.add('fp-mk-fail')
        circ(7)
        glyph('✕')
        break
      case 'ok':
        g.classList.add('fp-mk-ok')
        circ(9)
        glyph('✓')
        break
      case 'okSm':
        g.classList.add('fp-mk-ok')
        circ(7)
        glyph('✓')
        break
      case 'land':
        g.classList.add('fp-mk-land')
        circ(11)
        glyph('✓')
        break
      case 'commit':
        g.classList.add('fp-mk-commit')
        circ(6.5)
        break
      case 'rerun':
        g.classList.add('fp-mk-rule')
        el('circle', { r: 13, class: 'fp-bg', style: 'fill:none' }, inner)
        el('circle', { r: 17, class: 'fp-bg', style: 'fill:none;opacity:.5' }, inner)
        break
      case 'look':
        g.classList.add('fp-mk-look')
        circ(9)
        glyph('◆')
        break
      case 'you':
        g.classList.add('fp-mk-you')
        circ(10)
        glyph(op.glyph || '!')
        break
      case 'ask': {
        g.classList.add('fp-mk-you')
        el('circle', { r: 11, class: 'fp-ring' }, inner)
        el(
          'path',
          {
            d: 'M-11 -9 h22 a3 3 0 0 1 3 3 v10 a3 3 0 0 1 -3 3 h-13 l-5 5 v-5 h-4 a3 3 0 0 1 -3 -3 v-10 a3 3 0 0 1 3 -3z',
            class: 'fp-bg',
            transform: 'translate(0 -1)',
          },
          inner,
        )
        el('text', { y: 0 }, inner).textContent = op.n ? String(op.n) : '?'
        break
      }
      case 'answered':
        g.classList.add('fp-mk-ok')
        el('circle', { r: 6.5, class: 'fp-bg', transform: 'translate(11 9)' }, inner)
        el('text', { x: 11, y: 9, style: 'font-size:8px' }, inner).textContent = '✓'
        break
      case 'pin':
        g.classList.add('fp-mk-rule')
        el('circle', { r: 6, class: 'fp-bg' }, inner)
        el('circle', { r: 2, style: 'fill:var(--ink-2)' }, inner)
        break
      case 'merge':
        g.classList.add('fp-mk-commit')
        circ(6)
        break
      case 'lock':
      case 'unlock': {
        g.classList.add('fp-mk-rule')
        el('rect', { x: -8, y: -4, width: 16, height: 12, rx: 2.5, class: 'fp-bg' }, inner)
        const sh = op.kind === 'lock' ? 'M-4.5 -4 v-3 a4.5 4.5 0 0 1 9 0 v3' : 'M-4.5 -4 v-3 a4.5 4.5 0 0 1 9 0'
        el(
          'path',
          {
            d: sh,
            style: 'fill:none;stroke:var(--ink-2);stroke-width:1.75',
            transform: op.kind === 'unlock' ? 'translate(0 -2)' : '',
          },
          inner,
        )
        break
      }
      case 'tick':
        g.classList.add('fp-mk-commit')
        circ(2.5)
        break
    }
    return { g, a }
  }

  function label(content: string | undefined, a: { x: number; y: number }, side: string, kind: string, extraUp = 0) {
    if (!content) return null
    const t = el('text', { class: 'fp-lbl k-' + kind }, labels)
    t.textContent = content
    if (G.wide) {
      const w = t.getComputedTextLength()
      const h = 14
      const tries =
        side === 'left'
          ? ['left']
          : side === 'right'
            ? ['right', 'above', 'below']
            : side === 'above'
              ? ['above', 'below']
              : ['below', 'above']
      const boxAt = (s: string, dx = 0) => {
        let x = a.x + dx
        let y: number
        let anchorMiddle = true
        if (s === 'below') y = a.y + 24
        else if (s === 'above') y = a.y - 16 - extraUp
        else if (s === 'left') {
          x = a.x - 10 - w
          y = a.y + 4
          anchorMiddle = false
        } else {
          x = a.x + 12 + dx
          y = a.y + 4
          anchorMiddle = false
        }
        let x0 = anchorMiddle ? x - w / 2 : x
        if (x0 < G.head + 6) x0 = G.head + 6
        if (x0 + w > G.W - 6) x0 = G.W - 6 - w
        return { x0, y, w, h }
      }
      const hit = (b: { x0: number; y: number; w: number }) =>
        boxes.some((o) => b.x0 < o.x0 + o.w + 8 && o.x0 < b.x0 + b.w + 8 && b.y - h < o.y && o.y - o.h < b.y)
      let b: ReturnType<typeof boxAt> | null = null
      for (const s of tries) {
        const c = boxAt(s)
        if (!hit(c)) {
          b = c
          break
        }
      }
      if (!b) {
        for (let dx = 12; dx < 240 && !b; dx += 12) {
          const c = boxAt(tries[0]!, dx)
          if (!hit(c)) b = c
        }
      }
      b = b || boxAt(tries[0]!)
      boxes.push(b)
      t.setAttribute('x', String(f(b.x0)))
      t.setAttribute('y', String(f(b.y)))
      return [t]
    }
    const y = Math.max(a.y + 4, lastLabelY + 16)
    lastLabelY = y
    t.setAttribute('x', String(G.LX))
    t.setAttribute('y', String(f(y)))
    const ld = el(
      'path',
      { class: 'fp-leader', d: `M${f(a.x + 8)} ${f(a.y)} L${G.LX - 14} ${f(a.y)} L${G.LX - 5} ${f(y - 4)}` },
      labels,
    )
    if (y + 10 > G.H) {
      G.H = y + 18
      size()
    }
    return [t, ld]
  }

  function dot(who: string) {
    if (!dotEls[who]) {
      const small = who !== 'main'
      dotEls[who] = el('circle', { r: small ? 5.5 : 7, class: 'fp-dot' + (small ? ' fp-sm' : '') }, dots)
    }
    return dotEls[who]!
  }
  function place(who: string, x: number, y: number, lane: number) {
    const d = dot(who)
    d.setAttribute('cx', String(f(x)))
    d.setAttribute('cy', String(f(y)))
    d.classList.toggle('fp-you', lane === Y)
    d.classList.toggle('fp-look', lane === L)
  }

  const wait = (ms: number, tk: number) =>
    new Promise<boolean>((res) => {
      const id = setTimeout(() => {
        timers.delete(id)
        res(tk === token)
      }, ms)
      timers.add(id)
    })
  const nextFrame = (fn: FrameRequestCallback) => {
    const id = requestAnimationFrame((n) => {
      frames.delete(id)
      fn(n)
    })
    frames.add(id)
  }
  function draw(paths: SVGPathElement[], who: string | null, lane: number, ms: number, tk: number, at?: At) {
    const lens = paths.map((p) => p.getTotalLength())
    paths.forEach((p, i) => {
      p.style.strokeDasharray = `${lens[i]} ${lens[i]}`
      p.style.strokeDashoffset = String(lens[i])
    })
    const clear = () =>
      paths.forEach((p) => {
        p.style.strokeDasharray = ''
        p.style.strokeDashoffset = ''
      })
    if (ms === 0) {
      clear()
      if (who) {
        const e = at!(1)
        place(who, e.x, e.y, lane)
      }
      return Promise.resolve(true)
    }
    return new Promise<boolean>((res) => {
      const t0 = performance.now()
      const step = (now: number) => {
        if (tk !== token) return res(false)
        const t = Math.min(1, (now - t0) / ms)
        const e = ease(t)
        paths.forEach((p, i) => {
          p.style.strokeDashoffset = String(lens[i]! * (1 - e))
        })
        if (who) {
          const q = at!(e)
          place(who, q.x, q.y, lane)
        }
        if (t < 1) nextFrame(step)
        else {
          clear()
          res(true)
        }
      }
      nextFrame(step)
    })
  }
  const laneCls = (pts: Pt[]) => 'fp-ln-' + LANE[pts[pts.length - 1]![0]]
  const show = (els: (Element | null | undefined)[] | null | undefined) =>
    els?.forEach((e) => e?.classList.add('fp-on'))

  async function run(ops: Op[], instantUpTo: number, tk: number) {
    for (let i = 0; i < ops.length; i++) {
      if (tk !== token) return
      const op = ops[i]!
      const fast = reduce() || i < instantUpTo
      if (op.line) {
        const who = op.who === undefined ? 'main' : op.who
        const p = el(
          'path',
          {
            d: pathD(op.line),
            class: `fp-seg ${op.cls ? 'fp-' + op.cls : ''} ${op.cls === 'side' ? '' : laneCls(op.line)}`,
          },
          trail,
        )
        const paths = [p]
        if (op.twin) {
          const tw = op.line.map(([l, u, o = 0]) => [l, u, o + op.twin!] as Pt)
          paths.push(el('path', { d: pathD(tw), class: 'fp-seg fp-fix' }, trail))
        }
        if (op.fadeOnly) {
          p.classList.add('fp-fade')
          nextFrame(() => p.classList.add('fp-on'))
          continue
        }
        const len = p.getTotalLength()
        const ms = fast ? 0 : Math.max(380, Math.min(op.slow ? 2200 : 1100, len * (op.slow ? 6 : 2.6)))
        if (who) dot(who)
        const ok = await draw(paths, who, op.line[op.line.length - 1]![0], ms, tk, trackOf(op.line))
        if (!ok) return
        if (op.label) show(label(op.label, pt(op.labelAt || op.line[0]!), 'above', 'fix'))
      } else if (op.lines) {
        const ps = op.lines.map((l) =>
          el('path', { d: pathD(l.pts), class: `fp-seg ${l.cls ? 'fp-' + l.cls : ''} fp-ln-rule` }, trail),
        )
        op.hide?.forEach((w) => dotEls[w]?.remove())
        const ok = await draw(ps, null, R, fast ? 0 : 650, tk)
        if (!ok) return
      } else if (op.loop) {
        const p = el('path', { d: loopD(op.loop), class: 'fp-seg fp-loop' }, trail)
        const c = tp(op.loop)
        const far = xy({ T: c.T, P: c.P - 2 * RAD })
        const ctr = xy({ T: c.T, P: c.P - RAD })
        let clock: SVGGElement | undefined
        if (op.clock) {
          const co = el('g', { transform: `translate(${f(far.x)} ${f(far.y)})` }, marks)
          clock = el('g', { class: 'fp-mk fp-mk-rule' }, co)
          const ci = el('g', {}, clock)
          el('circle', { r: 7, class: 'fp-bg' }, ci)
          el(
            'path',
            { d: 'M0 -4 V0 L3 2', style: 'fill:none;stroke:var(--ink-2);stroke-width:1.5;stroke-linecap:round' },
            ci,
          )
        }
        let num: SVGTextElement | undefined
        if (op.n) {
          num = el(
            'text',
            {
              x: f(ctr.x),
              y: f(ctr.y),
              class: 'fp-mk fp-numeral',
              'text-anchor': 'middle',
              'dominant-baseline': 'central',
            },
            marks,
          )
          num.textContent = String(op.n)
        }
        const ok = await draw([p], 'main', op.loop[0], fast ? 0 : 900, tk, loopTrack(op.loop))
        if (!ok) return
        show([clock, num])
        show(label(op.label, far, 'above', 'rule', 4))
      } else if (op.mark) {
        if (op.pre) {
          const p = el('path', { d: pathD(op.pre), class: 'fp-seg ' + laneCls(op.pre) }, trail)
          const ok = await draw(
            [p],
            op.who || 'main',
            op.pre[op.pre.length - 1]![0],
            fast ? 0 : 300,
            tk,
            trackOf(op.pre),
          )
          if (!ok) return
        }
        const { g, a } = mark(op)
        op.hide?.forEach((w) => dotEls[w]?.remove())
        if (g) {
          nextFrame(() => g.classList.add('fp-on'))
          lastMark = g
        }
        const kinds: Record<string, string> = {
          fail: 'fail',
          failSm: 'fail',
          ok: 'ok',
          okSm: 'ok',
          land: 'land',
          look: 'look',
          you: 'you',
          ask: 'you',
          answered: 'ok',
          tick: 'tick',
        }
        show(
          label(
            op.label,
            a,
            op.side || 'below',
            kinds[op.kind ?? ''] || 'rule',
            op.kind === 'rerun' ? 8 : op.kind === 'ask' ? 2 : 0,
          ),
        )
        if (!fast && op.kind !== 'start' && op.kind !== 'none') {
          if (!(await wait(op.kind === 'rerun' ? 380 : 160, tk))) return
        }
      } else if (op.pause) {
        if (fast) continue
        const m = lastMark
        m?.classList.add('fp-pulse')
        if (!(await wait(op.pause, tk))) return
        m?.classList.remove('fp-pulse')
      } else if (op.jump) {
        const a = pt(op.jump)
        place('main', a.x, a.y, R)
      }
    }
  }

  function opsFor(key: string, ext: boolean) {
    const p = P[key]!
    if (!ext) return { ops: p.base, keep: 0 }
    return { ops: [...p.base.slice(0, p.keep), ...(p.ext ?? [])], keep: p.keep ?? 0 }
  }
  function endLane(ops: Op[]) {
    for (let i = ops.length - 1; i >= 0; i--) {
      const o = ops[i]!
      if (o.mark) return o.mark[0]
      if (o.line) return o.line[o.line.length - 1]![0]
    }
    return R
  }

  function render(it: Item, ext: boolean) {
    const lane = endLane(opsFor(it.key, ext).ops)
    result.replaceChildren()
    const where = text(result, 'p', 'fp-where', ext ? 'Past the limit, it stops at ' : 'It ends at ')
    text(where, 'b', 'fp-' + LANE[lane]!, LANE_NAME[lane]!)
    text(result, 'p', 'fp-what', ext ? it.extText : it.what)
    text(result, 'p', 'fp-bound', it.bound)
    if (P[it.key]!.ext && !ext) {
      const more = text(result, 'button', 'fp-more', 'And if it keeps happening? →', { type: 'button' })
      more.addEventListener('click', () => {
        state!.ext = true
        go(true)
      })
    } else if (!P[it.key]!.ext) {
      text(
        result,
        'p',
        'fp-nomore',
        'Nothing to repeat here: waiting costs nothing, and it resumes at the reset on its own.',
      )
    }
    askSlot.replaceChildren()
    const ask = it.key === 'unclear' && !ext && it.ask
    out.classList.toggle('fp-no-ask', !ask)
    if (ask) askSlot.append(ask.cloneNode(true))
  }

  function go(animate: boolean) {
    const tk = ++token
    const it = items.find((x) => x.key === state!.key)!
    layout()
    frame()
    const { ops, keep } = opsFor(state!.key, state!.ext)
    render(it, state!.ext)
    void run(ops, animate ? keep : ops.length, tk)
  }

  const chips = items.map((it) => {
    const b = text(chipsBox, 'button', 'fp-chip', it.say, { type: 'button', 'aria-pressed': 'false' })
    b.addEventListener('click', () => choose(it.key, true))
    return b
  })
  function choose(key: string, animate: boolean) {
    state = { key, ext: false }
    chips.forEach((c, i) => c.setAttribute('aria-pressed', String(items[i]!.key === key)))
    go(animate)
  }

  // The script is running: the drawing replaces the open list, which stays one click away.
  host.hidden = false
  if (all) all.open = false
  section.querySelectorAll<HTMLDetailsElement>('.fp-item').forEach((d) => (d.open = false))

  let lastW = 0
  const ro = new ResizeObserver(() => {
    const w = stage.clientWidth
    if (state && Math.abs(w - lastW) > 2) {
      lastW = w
      go(false)
    }
  })
  ro.observe(stage)
  // Reduced motion changed under a drawing: redraw its end state at once.
  const onMotion = () => state && go(false)
  mq.addEventListener('change', onMotion)

  choose(items[0]?.key ?? 'api', false)

  return () => {
    token++
    ro.disconnect()
    mq.removeEventListener('change', onMotion)
    timers.forEach(clearTimeout)
    frames.forEach(cancelAnimationFrame)
    chipsBox.replaceChildren()
    svg.replaceChildren()
    result.replaceChildren()
    askSlot.replaceChildren()
  }
}

export function FailurePathsStage() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = ref.current
    const section = host?.closest('section')
    if (!host || !section) return
    return mount(host, section)
  }, [])
  return (
    <div className="fp-live" ref={ref} hidden>
      <div className="fp-chips" role="group" aria-label="Pick a failure" />
      <div className="fp-stage">
        <svg className="fp-svg" role="img" aria-labelledby="fp-svg-title" />
      </div>
      <div className="fp-out fp-no-ask" aria-live="polite">
        <div className="fp-result" />
        <div className="fp-askslot" />
      </div>
    </div>
  )
}
