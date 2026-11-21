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
  /** A footnote's label for the kind (#1345), singular and plural; absent where `did` is. */
  short?: { one: string; many: string }
  /** The sentence on hover. */
  hover: string
  colour: string
}

/** The kinds that have copy, **in the order the table shows them**; `PROBLEM_KINDS` stays the set. */
export const HANDLED_ROWS: Readonly<Record<Exclude<ProblemKind, 'other'>, HandledRow>> = {
  'review-fixed': {
    wrong: 'AI review found problems',
    did: 'auto-fixed',
    short: { one: 'review fix', many: 'review fixes' },
    hover:
      'Before any code is accepted, an AI reviewer reads it. When it found problems, the agent fixed them and had the code reviewed again.',
    colour: 'var(--s1)',
  },
  'base-moved': {
    wrong: 'newer changes landed first',
    did: 'auto-merged, re-tested',
    short: { one: 're-merged', many: 're-merged' },
    hover:
      'Your project moved on while this work was in progress. Lingtai pulled in the newer code and ran the tests again, so nothing is built on an outdated copy.',
    colour: 'var(--accent)',
  },
  conflict: {
    wrong: 'two changes touched the same code',
    did: 'auto-combined',
    short: { one: 'combined', many: 'combined' },
    hover: 'This work and a newer change edited the same lines. The agent combined both versions so neither was lost.',
    colour: 'var(--s3)',
  },
  build: {
    wrong: 'tests or build broke',
    did: 'auto-fixed',
    short: { one: 'build fix', many: 'build fixes' },
    hover: "Your project's tests or build failed on this change. The agent fixed the code until they passed.",
    colour: 'var(--s5)',
  },
  stopped: {
    wrong: 'agent stopped halfway',
    did: 'auto-restarted',
    short: { one: 'restarted', many: 'restarted' },
    hover:
      'The AI service dropped, the agent crashed or answered nothing. Lingtai ran that step again from the saved work.',
    colour: 'var(--s2)',
  },
  'review-restarted': {
    wrong: 'AI review rejected the approach',
    did: 'auto-started over',
    short: { one: 'started over', many: 'started over' },
    hover: 'Review found the approach wrong, not just a few lines. Lingtai started a fresh attempt from the base.',
    colour: 'var(--s4)',
  },
  disputed: {
    wrong: 'the agent disputed a review finding',
    did: 'AI judge decided',
    short: { one: 'judged', many: 'judged' },
    hover:
      'The agent argued a finding was wrong, mostly a test that was not its fault. An AI judge read both sides and chose the next step.',
    colour: 'var(--held)',
  },
  'too-big': {
    wrong: 'task too big for one change',
    did: 'auto-split',
    short: { one: 'split', many: 'split' },
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

/** Why a ticket waited for a person, in the words *Handled for you* uses where it has them (#1294). */
const WAIT_REASON_WORDS: Readonly<Record<string, string>> = {
  AgentCrashed: HANDLED_ROWS.stopped.wrong,
  AgentQuestion: HANDLED_ROWS.asked.wrong,
  SetupRefused: HANDLED_ROWS.setup.wrong,
  FixerDisagrees: HANDLED_ROWS.disputed.wrong,
  ProposedEscalated: 'a failure handed to you',
  AskLimit: 'asked too many times',
}

/** A wait reason as the page says it; a tag with no entry shows itself, never blank. */
export const waitReasonText = (tag: string): string => WAIT_REASON_WORDS[tag] ?? tag

// --- what the person did (#1288) ----------------------------------------------------

export interface MoveRow {
  /** The *→ you …* half of a NEEDED YOU row. */
  verb: string
  hover: string
}

const APPROVED = 'You read what was left and let the work land.'

/** A resolution's tag → its row; two tags with one verb are one row. */
const MOVE_ROWS: Record<string, MoveRow> = {
  Approve: { verb: 'you approved', hover: APPROVED },
  FixRefusal: {
    verb: 'you gave it another round',
    hover: 'You sent the work back to the agent for one more fix round.',
  },
  RedoStep: { verb: 'you had the step run again', hover: 'You asked for the step that stopped to run again.' },
  StartNewAttempt: {
    verb: 'you started it over',
    hover: 'You had the work started again from the current code, with or without changing the ticket.',
  },
  AnswerQuestions: { verb: 'you answered', hover: "You answered the agent's question and the work went on." },
  ConfirmSatisfied: {
    verb: 'you confirmed it was already done',
    hover: "You confirmed the ticket's work was already in place.",
  },
  Close: { verb: 'you closed it', hover: 'You closed the ticket.' },
  triage: {
    verb: 'Lingtai answered',
    hover:
      'Triage answered it before it reached you; it is counted here because only you are meant to answer this kind.',
  },
}
MOVE_ROWS.EditBodyAndStartNewAttempt = MOVE_ROWS.StartNewAttempt!
MOVE_ROWS.AnswerQuestion = MOVE_ROWS.AnswerQuestions!

/** What `Approve` means where the kind changes it; every other kind uses the generic sentence. */
const APPROVE_HOVER: Readonly<Record<string, string>> = {
  'review-fixed':
    'The AI review still had findings when the rounds ran out, so it asked you; you read them and let the work land.',
  conflict: 'The agent could not combine the two versions of the same lines, so it asked you; you let the work land.',
  build: 'The tests or build were still red when the rounds ran out, so it asked you; you let the work land anyway.',
  'base-moved': 'Newer code landed first and could not be merged cleanly, so it asked you; you let the work land.',
  disputed: 'The agent and the review still disagreed, so it asked you; you decided and let the work land.',
}

export const WAITING_ON_YOU = 'waiting on you'
export const YOU_DECIDED = 'you decided'

/**
 * A move's row. `null` is a problem still open; an unknown tag, or `'unknown'` (a problem stored
 * before the rebuild), is *you decided*. `kind` words an `Approve`.
 */
export function moveRow(move: string | null, kind?: string): MoveRow {
  if (move === null) return { verb: WAITING_ON_YOU, hover: 'It is in the Waiting column now.' }
  const row = MOVE_ROWS[move]
  if (row === undefined) return { verb: YOU_DECIDED, hover: '' }
  return move === 'Approve' && kind !== undefined && APPROVE_HOVER[kind] !== undefined
    ? { verb: row.verb, hover: APPROVE_HOVER[kind] }
    : row
}

/** A problem's stored `yourMove`, as `moveRow` reads it: a missing key is `'unknown'`. */
export const moveOf = (p: { yourMove?: string | null }): string | null =>
  p.yourMove === undefined ? 'unknown' : p.yourMove

/**
 * NEEDED YOU folded by verb: two tags with one verb are one row. Per kind, count descending,
 * *you decided* just before *waiting on you*, which is last.
 */
export function neededRows(
  needed: readonly { kind: string; move: string | null; count: number }[],
): { kind: string; verb: string; hover: string; count: number }[] {
  const rank = (verb: string) => (verb === WAITING_ON_YOU ? 2 : verb === YOU_DECIDED ? 1 : 0)
  const out: { kind: string; verb: string; hover: string; count: number }[] = []
  for (const kind of HANDLED_ORDER) {
    const folded = new Map<string, { kind: string; verb: string; hover: string; count: number }>()
    for (const n of needed) {
      if (n.kind !== kind) continue
      const r = moveRow(n.move, kind)
      const hit = folded.get(r.verb)
      if (hit === undefined) folded.set(r.verb, { kind, verb: r.verb, hover: r.hover, count: n.count })
      else hit.count += n.count
    }
    out.push(...[...folded.values()].sort((a, b) => rank(a.verb) - rank(b.verb) || b.count - a.count))
  }
  return out
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

/** "5 review fixes", or null for a kind with no short label (`other`, an unknown one, or one only a person answers). */
export function handledShort(kind: string, count: number): string | null {
  const s = handledRow(kind).short
  return s === undefined ? null : `${count} ${count === 1 ? s.one : s.many}`
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
export const TICK_LIMIT = 60

/** The height of the tallest day's stack, in px; the other days are scaled to it. */
export const DAY_STACK_PX = 106

/** One page of the drill-down. */
export const HANDLED_PAGE = 20

interface Placed {
  at: string
  ticket: string
}

type Cursor = { at: Date; ticket: string; seen: number }

const sameKey = (r: Placed, c: { at: Date; ticket: string }): boolean =>
  Date.parse(r.at) === c.at.getTime() && r.ticket === c.ticket

/**
 * Twenty rows after the cursor, and where they sit in the whole: *showing a–b of m*.
 * Rows come newest first, ties by ticket. A cursor is a position in that order and
 * not a row id, so one whose row has left the window still works: it names the last
 * row's `(at, ticket)` and how many rows of that very key were already shown, so
 * problems sharing both a millisecond and a ticket are neither skipped nor repeated.
 */
export function pageHandled<T extends Placed>(
  rows: readonly T[],
  before: Cursor | null,
): { rows: T[]; from: number; to: number; total: number; next: Cursor | null } {
  let skipped = 0
  if (before !== null) {
    const ct = before.at.getTime()
    const ahead = rows.filter((r) => {
      const t = Date.parse(r.at)
      // The same comparison `handledProblems` sorts by, or the two disagree on `a_b` against `a-b`.
      return t > ct || (t === ct && r.ticket !== before.ticket && r.ticket.localeCompare(before.ticket) < 0)
    }).length
    const tied = rows.filter((r) => sameKey(r, before)).length
    skipped = ahead + Math.min(before.seen, tied)
  }
  const page = rows.slice(skipped, skipped + HANDLED_PAGE)
  const last = page[page.length - 1]
  const end = skipped + page.length
  const first =
    last === undefined ? -1 : rows.findIndex((r) => sameKey(r, { at: new Date(last.at), ticket: last.ticket }))
  return {
    rows: page,
    from: page.length === 0 ? 0 : skipped + 1,
    to: end,
    total: rows.length,
    next:
      end < rows.length && last !== undefined
        ? { at: new Date(last.at), ticket: last.ticket, seen: end - first }
        : null,
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
