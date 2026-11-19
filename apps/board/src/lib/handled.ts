/**
 * The words and colours of *handled for you* (#1285), one row per problem kind
 * and the same wherever a kind is drawn — the `/report` panel's table, ticks,
 * bars and LATEST, and the home card. The wording is the design's third tab
 * (`doc/design/handled-for-you.html`) and is frozen: change it there first.
 *
 * **No colour here is a board state.** 0123 §7: amber never appears on
 * `/report`, because amber means a person is waited on. The mock drew `build`
 * in `--signal` and `too-big` in `--warn`; both are amber, so they take the
 * series colours `--s5` and `--s6`.
 */
import { PROBLEM_KINDS, type ProblemKind } from '@lingtai/domain'

export interface HandledRow {
  /** What went wrong. */
  wrong: string
  /** What Lingtai did — the *auto-* verb; absent where only a person can answer. */
  did?: string
  /** The sentence on hover. */
  hover: string
  colour: string
}

/** The kinds that have copy, **in the order the table shows them**; `PROBLEM_KINDS` stays the set. */
export const HANDLED_ROWS: Readonly<Record<Exclude<ProblemKind, 'other'>, HandledRow>> = {
  'review-fixed': {
    wrong: 'AI review found problems',
    did: 'auto-fixed',
    hover:
      'Before any code is accepted, an AI reviewer reads it. When it found problems, the agent fixed them and had the code reviewed again.',
    colour: 'var(--s1)',
  },
  'base-moved': {
    wrong: 'newer changes landed first',
    did: 'auto-merged, re-tested',
    hover:
      'Your project moved on while this work was in progress. Lingtai pulled in the newer code and ran the tests again, so nothing is built on an outdated copy.',
    colour: 'var(--accent)',
  },
  conflict: {
    wrong: 'two changes touched the same code',
    did: 'auto-combined',
    hover: 'This work and a newer change edited the same lines. The agent combined both versions so neither was lost.',
    colour: 'var(--s3)',
  },
  build: {
    wrong: 'tests or build broke',
    did: 'auto-fixed',
    hover: "Your project's tests or build failed on this change. The agent fixed the code until they passed.",
    colour: 'var(--s5)',
  },
  stopped: {
    wrong: 'agent stopped halfway',
    did: 'auto-restarted',
    hover:
      'The AI service dropped, the agent crashed or answered nothing. Lingtai ran that step again from the saved work.',
    colour: 'var(--s2)',
  },
  'review-restarted': {
    wrong: 'AI review rejected the approach',
    did: 'auto-started over',
    hover: 'Review found the approach wrong, not just a few lines. Lingtai started a fresh attempt from the base.',
    colour: 'var(--s4)',
  },
  disputed: {
    wrong: 'the agent disputed a review finding',
    did: 'AI judge decided',
    hover:
      'The agent argued a finding was wrong, mostly a test that was not its fault. An AI judge read both sides and chose the next step.',
    colour: 'var(--held)',
  },
  'too-big': {
    wrong: 'task too big for one change',
    did: 'auto-split',
    hover: 'The change grew too large to review in one go. Lingtai split the task into smaller tickets.',
    colour: 'var(--s6)',
  },
  asked: {
    wrong: 'the agent asked you a question',
    hover:
      'The ticket left something open that only you can decide. Your answer is written into the ticket and the work goes on.',
    colour: 'var(--rule-2)',
  },
  setup: {
    wrong: 'setup broke in your environment',
    hover: 'A tool or permission is missing on this machine. Passing glitches are retried; this one needs your hands.',
    colour: 'var(--rule-2)',
  },
}

/** The order the rows are drawn in, `other` last and without copy. */
export const HANDLED_ORDER: readonly ProblemKind[] = [
  ...(Object.keys(HANDLED_ROWS) as Exclude<ProblemKind, 'other'>[]),
  'other',
]

export const isProblemKind = (s: string): s is ProblemKind => (PROBLEM_KINDS as readonly string[]).includes(s)

/** A kind's copy, or the muted stand-in for one that has none yet (`other`). */
export function handledRow(kind: string): HandledRow {
  return (
    (HANDLED_ROWS as Readonly<Record<string, HandledRow | undefined>>)[kind] ?? {
      wrong: 'other',
      hover: '',
      colour: 'var(--muted)',
    }
  )
}

// --- the figures the panel is drawn from --------------------------------------------

/**
 * The share without you, rounded — but never 100% while somebody was needed and
 * never 0% while something was solved, so a page does not say *100%* beside
 * *1 needed you*. Null when nothing was raised.
 */
export function shareWithoutYou(system: number, you: number): number | null {
  const n = system + you
  if (n === 0) return null
  const pct = Math.round((system / n) * 100)
  if (you > 0 && pct >= 100) return 99
  if (system > 0 && pct <= 0) return 1
  return pct
}

/** Above this many problems the tick strip draws one weighted mark per (kind, group), not one each. */
export const TICK_LIMIT = 400

/** The height of the tallest day's stack, in px; the other days are scaled to it. */
export const DAY_STACK_PX = 106

/** One page of the drill-down. */
export const HANDLED_PAGE = 20

interface Placed {
  at: string
  ticket: string
}

/** Rows come newest first, ties by ticket: *after* the cursor is further down that order. */
const isAfter = (r: Placed, c: { at: Date; ticket: string }): boolean => {
  const t = Date.parse(r.at)
  const ct = c.at.getTime()
  return t < ct || (t === ct && r.ticket > c.ticket)
}

/**
 * Twenty rows after the cursor, and where they sit in the whole: *showing a–b of m*.
 * A cursor is a position in the order and not a row id, so one whose row has left
 * the window still works. Two problems on one ticket with the same millisecond
 * could straddle a page edge and one be skipped; that is accepted.
 */
export function pageHandled<T extends Placed>(
  rows: readonly T[],
  before: { at: Date; ticket: string } | null,
): { rows: T[]; from: number; to: number; total: number; next: { at: Date; ticket: string } | null } {
  const skipped = before === null ? 0 : rows.filter((r) => !isAfter(r, before)).length
  const page = rows.slice(skipped, skipped + HANDLED_PAGE)
  const last = page[page.length - 1]
  const more = skipped + page.length < rows.length
  return {
    rows: page,
    from: page.length === 0 ? 0 : skipped + 1,
    to: skipped + page.length,
    total: rows.length,
    next: more && last !== undefined ? { at: new Date(last.at), ticket: last.ticket } : null,
  }
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n: number): string => String(n).padStart(2, '0')

/** `Tue 18:40`, or `Nov 18 18:40` when the window is wider than a week. */
export function whenText(at: string | Date, withDate: boolean): string {
  const d = new Date(at)
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`
  return withDate ? `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}` : `${DAYS[d.getDay()]} ${time}`
}

/** `Thu 13` from a `YYYY-MM-DD` local day. */
export function dayText(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return `${DAYS[new Date(y!, m! - 1, d).getDay()]} ${d}`
}

/** The window as the panel's top right says it: `Nov 12 – 18 · 7 days`, `Oct 30 – Nov 5 · 7 days`, `Nov 19 · today`. */
export function windowText(which: 'today' | '7d' | 'custom', from: Date, to: Date): string {
  const last = new Date(to.getFullYear(), to.getMonth(), to.getDate() - 1)
  const n = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000))
  const a = `${MONTHS[from.getMonth()]} ${from.getDate()}`
  const sameDay =
    from.getFullYear() === last.getFullYear() &&
    from.getMonth() === last.getMonth() &&
    from.getDate() === last.getDate()
  const b = sameDay
    ? ''
    : from.getMonth() === last.getMonth() && from.getFullYear() === last.getFullYear()
      ? ` – ${last.getDate()}`
      : ` – ${MONTHS[last.getMonth()]} ${last.getDate()}`
  const tail = which === 'today' ? 'today' : `${n} day${n === 1 ? '' : 's'}`
  return `${a}${b} · ${tail}`
}
