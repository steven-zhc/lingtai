/**
 * What a run that never started costs the conductor, and for how long.
 *
 * [0031](../../../doc/decisions-archive/0031-a-run-that-never-started.md) §3 and §4.
 * Two decisions live here and they are different in kind, which is the whole
 * reason the file exists rather than an `if` beside the append:
 *
 * **How long.** A run that never started met something account-wide — a quota,
 * a signed-out runtime — and every other item in the queue would meet it
 * identically. Six of them proved that in ninety-two seconds, eighty events,
 * six worktrees and six branches, at a cost of nothing. So the conductor stops
 * rather than the item backing off, and the question is when it starts again.
 *
 * **Read the message for a time, never for a verdict.** The prose said `resets
 * 11pm (America/Chicago)` and the system waited out a flat hour instead, idle
 * for twelve minutes after the limit had already lifted. Reading it is worth
 * doing; reading it *for the classification* is not, and the difference is the
 * asymmetry: **a parse that misses costs efficiency and never correctness.**
 * A miss falls back to the recipe's backoff (0028), and resuming too early
 * meets the same wall, appends the same `never-started`, and pauses again. No
 * reading of this string can make the system do the wrong thing; it can only
 * make it slower. That is why the same brittle text is safe here and unsafe in
 * `neverStarted`.
 *
 * "Slower" has a figure behind a gate step, not just in front of the queue
 * (#317): a miss there wakes the conductor, which claims the ticket and pays
 * for a whole `implement` — about $10 — before the same step meets the same
 * wall again. A pause that is too long merely idles; one that is too short
 * spends real money rediscovering what the runtime already said.
 *
 * **Which way the cost runs depends on the wall, and that is what hid #210.**
 * A miss means waiting *longer* only while the true reset is sooner than the
 * backoff — a `five_hour` limit and a one-hour backoff. When the reset is
 * further out than the backoff, a miss means resuming early, meeting the wall
 * and pausing again, once per backoff until it lifts: a `seven_day` limit
 * worded `resets Sep 19 at 9am` was met forty-five times across a 45-hour wall,
 * because this file could read the session limit's wording and not the weekly
 * one's. Still correct; never cheap.
 *
 * And a miss is said as a miss. A message that named a reset this file could
 * not read is not a message that named none, and `standDown` tells the two
 * apart — the first is a fault in this parser, and the sentence quotes the
 * fragment so a reader is pointed at it rather than away from it.
 *
 * **The one reading that is a verdict is not here.** Whether a run that *did* start
 * ended on the runtime's own account-limit sentence is a `classify` row (#655,
 * #1011): a false match idles the projects using the account until `until`, a
 * miss is the behaviour from before it existed, and it never touches the
 * ticket's wait.
 *
 * **The second answer is what a failure buys** (0108 §19): `offerFor`, its two
 * bounds and `BUILT_IN_FOR`, below `standDown`.
 *
 * Nothing here does I/O and nothing here appends. `conduct.ts` is where the
 * lock is written, and it is one call.
 */
import type { Spent } from '../attempt-next.ts'
import type { PayloadOf, RuntimeId } from '../events.ts'
import type { BuiltInJudge } from '../judges.ts'
import type { JudgeWhen, Proposal } from '../proposal.ts'
import type { CandidateId, ExcludedCandidate } from '../route.ts'
import { ImpossibleRouteError, type Candidate, type RouteOffer, type RoutingPolicy } from '../routing.ts'
import { STEPS, type Step } from '../vocabulary.ts'
import { PERSON_ASKS, type Cause } from '../wait.ts'
import { classify } from './classify.ts'

/** Which of `standDown`'s four sources the `until` came from; `AccountLimitReached`'s own field. */
export type UntilFrom = PayloadOf<'AccountLimitReached'>['untilFrom']

/**
 * A reset time read out of a runtime's own message, or null.
 *
 * The forms it knows are the ones that have actually been seen, and it knows
 * them in the order of how much they can be trusted:
 *
 *   an ISO instant   `"resets_at":"2026-09-09T04:00:00Z"` — unambiguous, so it
 *                    is tried first and taken as it stands.
 *   a dated clock    `resets Sep 19 at 9am (America/Chicago)` — the weekly
 *                    limit's wording: a month and a day, then a time of day.
 *   a wall clock     `resets 11pm (America/Chicago)`, `resets at 3:30am`,
 *                    Codex's `try again at Sep 30th, 2026 2:00 AM` (#317) — a
 *                    time of day, and a zone when the sentence names one.
 *
 * The lead-in is either runtime's own word for it — `resets` or `try again
 * at` — everything after is one grammar, read the same way regardless of
 * which runtime wrote it (#317): a reset time is a fact about a wall, not
 * about a vendor.
 *
 * A wall clock with no zone is read in `zone`, when the caller names one, and
 * this host's zone otherwise. That is a guess, and it is allowed to be one for
 * the reason in the header: guessing wrong resumes at the wrong moment and
 * costs a pass, not a decision. `zone` exists so a test can pin a zone without
 * touching `process.env.TZ`, which is process-global; production calls this
 * with nothing in that slot, so a production read depends on the conducting
 * host's own zone matching whichever zone the runtime rendered its message
 * in.
 *
 * **A dated match (a month and a day given) does not degrade the way a bare
 * time does when the guess is wrong.** A bare time rolls forward to the next
 * occurrence regardless of which zone was guessed, so a wrong guess only
 * shifts the answer by hours. A date with its year already written is tried
 * once, in the guessed zone — and when the sentence named no zone of its own,
 * a second time at the latest instant that date and time could mean in any
 * civil zone (`now + 12h` on the naive reading, −12:00 being the westernmost
 * offset there is). **Null is the shortest possible wait** (`standDown` falls
 * back to `source.backoff`), so a date whose guessed zone has already gone by
 * is read at the latest instant it could still mean rather than given up on —
 * the second reading is off by at most about a day, where the backoff is
 * whatever the recipe says and is usually shorter than the wall that is
 * actually left. Only once *that* has passed too does this return null, which
 * is right at that point: the wall has lifted in every zone there is.
 *
 * A sentence that names its own zone (`(America/Chicago)`, which `QUOTA` and
 * `WEEKLY` both carry) never reaches the second reading — there is nothing
 * left to guess. What the second reading does not close: a wrong zone guess
 * whose reading is *still ahead of `now`* is still taken as the answer, and if
 * that guess was itself wrong the pause still resumes early. That costs one
 * pass, same as any other wrong guess here.
 *
 * Anything further out than a week is refused. A `seven_day` limit is the
 * longest thing this can legitimately be describing — the dated form is that
 * limit's own — and a match beyond it is more likely to be a number that was
 * not a time at all.
 *
 * Null covers two different facts, a message that named no reset and one that
 * named a reset this could not read; `standDown` needs them apart and uses
 * `readReset` for it.
 */
export function parseResetAt(detail: string, now: Date = new Date(), zone?: string): Date | null {
  const read = readReset(detail, now, zone)
  return read !== null && 'at' in read ? read.at : null
}

/** What a message said about when the wall lifts. */
type Reset =
  /**
   * A time was read. `guessedLatest` is set only for a dated match whose
   * guessed zone had already passed `now`: `at` is then the latest instant
   * the unzoned date and time could still mean, not the one read in the
   * guessed zone — `standDown`'s `reason` says so rather than claiming this
   * was read plainly.
   */
  | { readonly at: Date; readonly guessedLatest?: boolean }
  /** A reset was named and nothing usable came out of it — the fragment, clipped. */
  | { readonly named: string }
  /** Nothing in the message was about a reset. */
  | null

/**
 * Where a message talks about its reset: `resets`, a `resets_at` field,
 * Codex's `try again at <date> <time>`, or its `Try again in 3 hours`. The
 * last is not parsed — a relative duration is its own ticket — but it is a
 * reset that was named, and saying otherwise is the false sentence #210 is
 * about.
 */
const RESET_MARKER = /\bresets?\b|\bresets_at\b|\btry again at\b|\btry again in\b/i

/** English month names and their abbreviations, as the runtime writes them. */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const

/** The kinds of limit an account can be at (#1214). */
export type NamedLimit = { kind: LimitKind; resetsAt: string | null }

export type LimitKind = '5-hour' | 'weekly' | 'monthly-spend' | 'rate' | 'usage'

const KIND_CLAUSE = /\b(5-hour|five-hour|session|weekly|monthly(?: spend)?|usage|rate)\s+limit\b/gi

const kindOfWord = (word: string): LimitKind => {
  const w = word.toLowerCase()
  if (w === '5-hour' || w === 'five-hour' || w === 'session') return '5-hour'
  if (w === 'weekly') return 'weekly'
  if (w.startsWith('monthly')) return 'monthly-spend'
  if (w === 'rate') return 'rate'
  return 'usage'
}

/**
 * Which limit a runtime's message is about. The limit whose clause sits just before the reset marker
 * is the one that holds (`…monthly spend limit · … · your 5-hour limit resets 11:20pm` is the 5-hour);
 * a message with no reset falls back to the first limit it names. Pure, and reads no clock: the reset
 * itself is `standDown`'s one reading.
 */
export function limitOf(detail: string): LimitKind {
  const marker = RESET_MARKER.exec(detail)
  if (marker) {
    const before = [...detail.slice(0, marker.index).matchAll(KIND_CLAUSE)]
    const last = before[before.length - 1]
    if (last) return kindOfWord(last[1]!)
  }
  const first = [...detail.matchAll(KIND_CLAUSE)][0]
  return first ? kindOfWord(first[1]!) : 'usage'
}

function readReset(detail: string, now: Date, zone: string | undefined): Reset {
  const iso = /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/.exec(detail)
  const clock = iso ? toReset(within(new Date(iso[1]!.replace(' ', 'T')), now)) : clockReset(detail, now, zone)
  if (clock) return clock

  const marker = RESET_MARKER.exec(detail)
  if (!marker) return null
  const named = detail
    .slice(marker.index, marker.index + 60)
    .split('\n')[0]!
    .trim()
  return { named }
}

/** `at` wrapped as a `Reset`, or `null` when `at` is — so a caller can `return toReset(...)` directly. */
function toReset(at: Date | null, guessedLatest = false): { at: Date; guessedLatest?: boolean } | null {
  return at ? (guessedLatest ? { at, guessedLatest } : { at }) : null
}

function clockReset(detail: string, now: Date, zone: string | undefined): { at: Date; guessedLatest?: boolean } | null {
  // `resets` or Codex's `try again at`, optionally a month and a day (and a
  // year), optionally `at`, then a time; then a parenthesised zone if the
  // sentence carries one. Deliberately narrow — a looser pattern would start
  // reading times out of tickets, file names and shas. The date is a month
  // *name*, never a bare number, so `resets 11pm` cannot have its hour read
  // as a day.
  const clock = new RegExp(
    String.raw`(?:\bresets?\b|\btry again at\b)` +
      String.raw`(?:\s+(?:on\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?,?)?` +
      String.raw`(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?`,
    'i',
  ).exec(detail)
  if (!clock) return null

  const zoned = /\(([A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*)\)/.exec(
    detail.slice(clock.index + clock[0].length, clock.index + clock[0].length + 40),
  )

  let hour = Number(clock[4])
  const minute = clock[5] === undefined ? 0 : Number(clock[5])
  const meridiem = clock[6]?.toLowerCase()
  if (minute > 59) return null
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return null
    hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0)
  } else if (hour > 23) {
    return null
  }

  const inferredZone = zoned?.[1] ?? zone ?? hostZone()
  if (!knownZone(inferredZone)) return null

  if (clock[1] === undefined) return toReset(within(nextWallClock(now, inferredZone, hour, minute), now))

  // A date names *that* day. It is never rolled forward to the next one, which
  // is right for a bare time and wrong for a date: a date already gone by in
  // the guessed zone is read at the latest instant it could still mean (below)
  // before this gives up on it.
  const month = MONTHS.indexOf(clock[1].slice(0, 3).toLowerCase() as (typeof MONTHS)[number]) + 1
  const day = Number(clock[2])
  const thisYear = partsIn(now, inferredZone)['year']!
  const named = clock[3] === undefined ? null : Number(clock[3])
  for (const year of named === null ? [thisYear, thisYear + 1] : [named]) {
    // Date.UTC would read `Feb 30` as the 2nd of March; a day the month does
    // not have is not a date at all.
    if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null
    const at = wallClockOn(inferredZone, year, month, day, hour, minute)
    // The next year only for a date with no year that has gone by this one —
    // `resets Jan 2` read on the 30th of December. The week ceiling is what
    // refuses every other reading of it.
    if (at.getTime() > now.getTime()) return toReset(within(at, now))

    // The guessed zone's reading has already passed. When the sentence named
    // no zone of its own, that guess might simply be wrong rather than the
    // wall actually having lifted, so try once more at the latest instant
    // this date and time could mean in *any* civil zone, before giving up.
    // −12:00 is the westernmost offset in use, so that latest instant is the
    // naive UTC reading plus twelve hours.
    if (zoned === null) {
      const latest = new Date(Date.UTC(year, month - 1, day, hour, minute) + WESTERNMOST_LAG_MS)
      if (latest.getTime() > now.getTime()) return toReset(within(latest, now), true)
    }
  }
  return null
}

/**
 * Which agent never started — the run's own, or the one inside a gate.
 *
 * The pause is the same and the sentence is not, which is the whole reason this
 * is a parameter rather than a constant
 * ([0041](../../../doc/decisions-archive/0041-a-gate-that-never-ran.md) §3). A run that
 * never started took no turns and spent nothing, and 0031's sentence says so. A
 * *gate's* agent that never started sits inside a run that **did** start, took
 * turns and was paid for — the implementer produced the diff the reviewer was
 * being asked about. Telling a person `no turns taken, nothing spent` about that
 * pass is the same species of false sentence `#133` is against, one screen along
 * from the card it started on: the board's chip and `lingtai doctor` are exactly
 * where somebody woken at 2am reads it.
 *
 * **A variant is a set of clauses that are all true together, and that is what
 * makes them four rather than one** (`#265`). Each says *which* agent met the wall
 * and *what had already been paid for* by the time it did, so two agents share a
 * variant exactly where those answers are the same — the reviewer and a runtime
 * `judge:` do, both being `{of: "step"}` — and need their own where they differ.
 * A variant stretched over a case it is false about is `#133`.
 */
export type StandDownWhat =
  | { readonly of: 'run' }
  /** The point's action, as `point:action` — what the card and the chip name. */
  | { readonly of: 'step'; readonly step: string }
  /**
   * **The drafting agent, which is the first one a pass can buy** (`#265`) — the
   * `agent:` a recipe declares at `design`, as `design:action`.
   *
   * Its own variant because it is the one agent that sits inside a run that
   * started and has paid for **no** agent yet: `agentPlugin.at` opens at `design`
   * before any other step, so nothing ahead of it dispatches one. `{of: "run"}`
   * would say *no turns taken, nothing spent* about a run that claimed the ticket,
   * cut a worktree and installed; `{of: "step"}` would say *nothing judged the
   * diff*, and there is no diff at `design`.
   */
  | { readonly of: 'draft'; readonly step: string }
  /**
   * The agent a refusal bought (0038), which is the last agent in a pass and
   * meets the same wall the others do. `action` is what refused.
   */
  | { readonly of: 'fix'; readonly action: string; readonly round: number }
  /**
   * An agent that **started** and met the account's limit part-way (#655). Unlike
   * every other variant the run is not released: the ticket keeps its crash
   * wait, and this only locks the account.
   */
  | { readonly of: 'mid-run'; readonly step: string }

/** What each opens with, and whose words the quote at the end is. */
function subject(what: StandDownWhat): { opening: string; whose: string } {
  if (what.of === 'run') {
    return {
      opening: 'a run ended without ever starting — no turns taken, nothing spent',
      whose: 'The run said',
    }
  }
  if (what.of === 'draft') {
    return {
      opening:
        `the ${what.step} step's agent never started, so nothing drafted the design — ` +
        `the run that reached it did start, and had paid for no agent yet`,
      whose: `The ${what.step} step's agent said`,
    }
  }
  if (what.of === 'fix') {
    return {
      opening:
        `the agent bought to fix ${what.action} (round ${what.round}) never started, so nothing ` +
        `answered the refusal — the run that reached it did start, and was paid for`,
      whose: 'The fixing agent said',
    }
  }
  if (what.of === 'mid-run') {
    return {
      opening:
        `the ${what.step} step's agent met the account's usage limit after it had started and been ` +
        `paid for; the ticket waits on its crash as usual`,
      whose: `The ${what.step} step's agent said`,
    }
  }
  return {
    opening:
      `the ${what.step} step's agent never started, so nothing judged the diff — ` +
      `the run that reached it did start, and was paid for`,
    whose: `The ${what.step} step's agent said`,
  }
}

/**
 * When the locked account's projects take work again, and the sentence saying why.
 *
 * The sentence is what the run's log line carries, so it has to carry three things a person woken by it
 * would ask: what happened, until when, and where the time came from. The
 * runtime's own words are quoted rather than summarised — they are the evidence
 * the classification refused to read, and dropping them here would leave the
 * reason for an account-wide stop nowhere at all.
 *
 * *What* happened is `what`, and it is required rather than defaulted: the two
 * callers are the two depths the same wall is met at, and a default would let a
 * third arrive wearing whichever sentence happened to be first.
 */
export function standDown(input: {
  detail: string
  /** `source.backoff` in milliseconds, for when the message named no time. */
  backoffMs: number
  what: StandDownWhat
  /** The runtime that met the wall: the account the sentence says is locked. */
  runtime: RuntimeId
  now?: Date
  /** The zone a wall clock with no zone of its own is read in. Tests only — production leaves it to `hostZone()`. */
  zone?: string
}): { until: Date; untilFrom: UntilFrom; said: string; reason: string; limit: NamedLimit } {
  const now = input.now ?? new Date()
  const reset = readReset(input.detail, now, input.zone)
  const until = reset !== null && 'at' in reset ? reset.at : new Date(now.getTime() + input.backoffMs)
  const said = input.detail.trim().replace(/\s+/g, ' ').slice(0, 200)
  // Three branches and not two (#210). A reset that was named and could not be
  // read is a fault in `parseResetAt`, not a fact about the account, and it is
  // said as one — quoting the fragment, so the reader is sent to the string
  // rather than told there is nothing to look for.
  const untilFrom: UntilFrom =
    reset === null
      ? 'backoff'
      : 'at' in reset
        ? reset.guessedLatest
          ? 'message-latest'
          : 'message'
        : 'backoff-unreadable'
  const from =
    reset === null
      ? "it named no reset time, so this is the recipe's backoff"
      : 'at' in reset
        ? reset.guessedLatest
          ? 'read from the message, at the latest instant its unzoned date could mean, because ' +
            "this host's reading of it had already passed"
          : 'read from the message itself'
        : `it named a reset time (\`${reset.named}\`) this build could not read, so this is the ` +
          `recipe's backoff — that is a bug in parseResetAt, not the account`
  const { opening, whose } = subject(input.what)
  return {
    until,
    untilFrom,
    said,
    limit: {
      kind: limitOf(input.detail),
      resetsAt: untilFrom === 'message' || untilFrom === 'message-latest' ? until.toISOString() : null,
    },
    reason:
      `${opening}. ` +
      `Every queued item would meet the same thing, so every project whose recipe uses ${input.runtime} ` +
      `takes no new work until ${until.toISOString()} (${from}). ${whose}: ${said || 'nothing at all'}`,
  }
}

/**
 * When GitHub's rate limit lifts (0126 §2): `retry-after` (seconds from now), else
 * `x-ratelimit-reset` (UTC epoch seconds), else one minute doubling up to an hour.
 * Never sooner than a minute from now. A header that is absent, negative or not a
 * number is absent.
 */
export function githubLimitUntil(input: {
  failed: {
    detail: string
    retryAfter: number | null
    ratelimitReset: number | null
  }
  now: Date
  account: { doublings: number }
}): { until: Date; untilFrom: UntilFrom; said: string; reason: string; limit: NamedLimit } {
  const { failed, now } = input
  const minimum = now.getTime() + 60_000
  const usable = (n: number | null): n is number => n !== null && Number.isFinite(n) && n >= 0
  let at: number
  let untilFrom: UntilFrom
  let from: string
  if (usable(failed.retryAfter)) {
    at = now.getTime() + failed.retryAfter * 1000
    untilFrom = 'retry-after'
    from = `GitHub said retry-after ${failed.retryAfter}s`
  } else if (usable(failed.ratelimitReset)) {
    at = failed.ratelimitReset * 1000
    untilFrom = 'ratelimit-reset'
    from = 'GitHub said x-ratelimit-reset'
  } else {
    const n = Math.max(0, Math.floor(input.account.doublings))
    at = now.getTime() + Math.min(60_000 * 2 ** Math.min(n, 20), 3_600_000)
    untilFrom = 'doubling'
    from = `GitHub named no time, so one minute doubling (${n} before)`
  }
  const until = new Date(Math.max(at, minimum))
  const said = failed.detail.trim().replace(/\s+/g, ' ').slice(0, 200)
  return {
    until,
    untilFrom,
    said,
    limit: { kind: 'rate', resetsAt: untilFrom === 'doubling' ? null : until.toISOString() },
    reason:
      `GitHub's rate limit was met. Every project with a GitHub owner takes no new work until ` +
      `${until.toISOString()} (${from}). GitHub said: ${said || 'nothing at all'}`,
  }
}

// ------------------------------------------------------------------ time ----

/** A week out is the longest a reset can honestly be. See `parseResetAt`. */
const A_WEEK_MS = 7 * 24 * 3_600_000

/**
 * How much later than a naive UTC reading of a wall clock the same reading can
 * mean in the westernmost civil zone, `Etc/GMT+12` (−12:00). Added, never
 * applied through `wallClockOn`: that function's zone is a POSIX `Etc/GMT+N`
 * name, where the sign is inverted from the offset it names, which is a
 * mistake waiting for the next reader of this file.
 */
const WESTERNMOST_LAG_MS = 12 * 3_600_000

function within(at: Date, now: Date): Date | null {
  const ms = at.getTime()
  if (Number.isNaN(ms)) return null
  if (ms <= now.getTime()) return null
  if (ms - now.getTime() > A_WEEK_MS) return null
  return at
}

function hostZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

function partsIn(at: Date, zone: string): Record<string, number> {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts: Record<string, number> = {}
  for (const part of format.formatToParts(at)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return parts
}

/** How far `zone` is from UTC at a given instant, in milliseconds. */
function offsetAt(at: Date, zone: string): number {
  const p = partsIn(at, zone)
  return Date.UTC(p['year']!, p['month']! - 1, p['day']!, p['hour']!, p['minute']!, p['second']!) - at.getTime()
}

/**
 * The instant whose wall clock in `zone` reads `hour:minute` on that day.
 * `month` is 1-based, as it is written.
 *
 * The offset is applied twice because the first application can cross a
 * daylight-saving boundary and change which offset was the right one. Two
 * passes settle every ordinary case, and the residue — the hour that does not
 * exist on a spring-forward morning — is off by an hour, which the header's
 * asymmetry already says is affordable.
 */
function wallClockOn(zone: string, year: number, month: number, day: number, hour: number, minute: number): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute)
  const once = new Date(naive - offsetAt(new Date(naive), zone))
  return new Date(naive - offsetAt(once, zone))
}

/** The next instant whose wall clock in `zone` reads `hour:minute`. */
function nextWallClock(now: Date, zone: string, hour: number, minute: number): Date {
  const today = partsIn(now, zone)
  const at = (day: number): Date => wallClockOn(zone, today['year']!, today['month']!, day, hour, minute)
  const candidate = at(today['day']!)
  // Date.UTC normalises the overflow, so "the 32nd" is the 1st of next month.
  return candidate.getTime() > now.getTime() ? candidate : at(today['day']! + 1)
}

// ─── What a failure buys (0108 §19) ───

/**
 * **The mechanical bounds** (0108 §8, §15), the one place their values are written. A
 * constant and not a recipe knob: a knob is a value somebody can set to a loop. Each is
 * counted on the attempt's own stream (`personAsks` on the ticket's), so a continuation
 * does not reset it.
 */
export const BOUNDS = {
  /** At most this many redos of a step that crashed, answered unreadably or got a registry 5xx, per attempt (#1200, #1201, #1224). */
  stepRedos: 3,
  /** The growing waits before each step redo: the first, second and third. A landing retry waits on the same schedule. */
  stepRedoWaits: ['1 minute', '5 minutes', '15 minutes'],
  /** At most this many landings again after origin refused one, per attempt (#1221); a count of its own, never `stepRedos`. */
  landingRetries: 3,
  /** At most this many base merges per attempt, then a person (#593). They cost no agent, so it bounds a base that keeps moving. */
  baseBranchMerges: 10,
  /** At most this many times a ticket stops to ask a person, then a person decides: the sixth stop is the `AskLimit` wait and an agent never assumes (0108 §22, #1254). */
  personAsks: PERSON_ASKS,
  /** A triage whose answer failed or went stale is asked this many more times, then the wait is a person's (0118 §3, #1258). */
  triageRetries: 1,
  /** A ticket is split at most once per root (#1261): spent by its first `SplitStarted` for any wait. */
  ticketSplits: 1,
} as const

/**
 * **Whether a crash is redone in place, and after how long** (0108 §12, #1249): null when the
 * cause is not `crash` (a wall is the recipe's bound), when the words are the account's limit
 * (§11's, which locks and releases — checked first), or when `spent` has used the attempt's
 * `BOUNDS.stepRedos`. Any other crash is redone; `expected` says only whether the runtime's words
 * are on a transient row, i.e. whether the redo is expected to clear it.
 */
export function rerunInPlace(
  cause: 'crash' | 'timeout' | 'aborted',
  detail: string,
  spent: number,
): { readonly wait: (typeof BOUNDS.stepRedoWaits)[number]; readonly expected: boolean } | null {
  if (cause !== 'crash' || spent >= BOUNDS.stepRedos) return null
  const seen = classify({ platform: 'runtime', text: detail })
  if (seen?.platform === 'runtime' && seen.kind === 'account-limit') return null
  const wait = BOUNDS.stepRedoWaits[spent]
  return wait === undefined ? null : { wait, expected: seen?.platform === 'runtime' && seen.kind === 'transient' }
}

/**
 * **Whether an `implement` that declared nothing usable — `AgentFailed` — is redone, and after how
 * long** (0108 §21, #1250): by rule, bounded by `BOUNDS.stepRedos` like any other redo of a step,
 * and null once `spent` has used them, when the wait stands for a person.
 */
export function redoAgentFailed(spent: number): { readonly wait: (typeof BOUNDS.stepRedoWaits)[number] } | null {
  if (spent >= BOUNDS.stepRedos) return null
  const wait = BOUNDS.stepRedoWaits[spent]
  return wait === undefined ? null : { wait }
}

/**
 * **Whether a setup a registry refused is run again in place, and after how long** (0108 §18,
 * #1224): null when the output is on no registry row, or when `spent` has used the attempt's
 * `BOUNDS.stepRedos`. The wait is the one a crash's count would get.
 */
export function rerunSetup(
  output: string,
  spent: number,
): { readonly wait: (typeof BOUNDS.stepRedoWaits)[number] } | null {
  if (spent >= BOUNDS.stepRedos) return null
  const seen = classify({ platform: 'registry', text: output })
  if (seen?.platform !== 'registry' || seen.kind !== 'transient') return null
  const wait = BOUNDS.stepRedoWaits[spent]
  return wait === undefined ? null : { wait }
}

/**
 * Whether a proposal born at `step` got far enough for `implement` to have
 * something to fix — `judge.ts`'s own `anAgentHasRun`, read off `STEPS`
 * rather than a second list of the steps that qualify.
 */
function bornAtOrAfterImplement(step: Step): boolean {
  return STEPS.indexOf(step) >= STEPS.indexOf('implement')
}

/**
 * **0120 §3's offer, built from the proposal, the two ceilings and what this
 * pass has already spent.**
 *
 * Each candidate a paid round or restart would cost carries exactly one
 * exclusion when it is withheld — a criterion first, then a ceiling
 * (`judged`'s own order, `attempt-steps.ts:891-907`): a refusal with nothing to
 * hold an agent to buys nothing at either extent (0038 §2), and raising a
 * ceiling would not have helped where that is why it is missing.
 * `'hand-to-person'` is always available, so the set returned here is never
 * empty — the same floor `onOffer` keeps today (`run-attempt.ts:974-976`).
 *
 * **No fix candidate ever sends `merge` back to `build`**: `FixRound.to` admits
 * only `'design' | 'implement'`, so a `merge`-born proposal's `fix-lines`
 * lands at `'implement'` by the type it is built from, not by a check here.
 * `merge-base` is the one candidate that does, and it is a `MergeBase` and not a
 * `FixRound` for that reason: it spends no round (#593).
 */
export function offerFor(proposal: Proposal, policy: RoutingPolicy, spent: Spent): RouteOffer {
  const available: Candidate[] = []
  const unavailable: ExcludedCandidate[] = []

  function round(id: CandidateId, to: 'design' | 'implement', hasCriterion: boolean): void {
    if (!hasCriterion) {
      unavailable.push({ id, because: { _tag: 'NoCriterion' } })
      return
    }
    if (spent.rounds >= policy.refusalFixes) {
      unavailable.push({ id, because: { _tag: 'CeilingReached', ceiling: 'refusalFixes' } })
      return
    }
    available.push({ id, next: { _tag: 'FixRefusal', to, round: spent.rounds + 1 } })
  }

  function restart(hasCriterion: boolean): void {
    if (!hasCriterion) {
      unavailable.push({ id: 'restart', because: { _tag: 'NoCriterion' } })
      return
    }
    if (spent.newAttempts >= policy.newAttempts) {
      unavailable.push({ id: 'restart', because: { _tag: 'CeilingReached', ceiling: 'newAttempts' } })
      return
    }
    available.push({
      id: 'restart',
      next: { _tag: 'Requeued', cause: { _tag: 'NewAttempt', newAttempt: spent.newAttempts + 1 } },
    })
  }

  // `default` assigns `proposal` to a `never`, so a new `Proposal` variant
  // left without a cell here is a `tsc` error, not a silent fallthrough.
  switch (proposal._tag) {
    case 'InputNeeded':
      // Nothing is offered, as for `SandboxRefused`: an agent never decides in a person's place (0108 §22), so a
      // question is answered by `askPerson` within `personAsks` and no judge is paid a round for it (#1254).
      break
    case 'BuildRed':
      round('fix-lines', 'implement', proposal.output.trim() !== '')
      break
    case 'SandboxRefused':
      // Nothing is pushed, not even to `unavailable`: allowing a host or
      // installing the sandbox is the operator's, so the hold says *nothing
      // but a person was on offer* (#1157).
      break
    case 'VerifyRed':
      round('fix-lines', 'implement', proposal.output.trim() !== '')
      break
    case 'MergeConflict': {
      // Its own budget, never `rounds`: `round` stays what `rounds` is so the
      // review's counter is not reset by the lap this buys.
      const conflict = (spent.conflictRounds ?? 0) + 1
      if (conflict > policy.conflictResolutions) {
        unavailable.push({ id: 'fix-lines', because: { _tag: 'CeilingReached', ceiling: 'conflictResolutions' } })
      } else {
        available.push({
          id: 'fix-lines',
          next: { _tag: 'FixRefusal', to: 'implement', round: spent.rounds, conflict },
        })
      }
      break
    }
    case 'BaseMoved': {
      // Free, so neither a criterion nor `rounds` applies: only the base
      // having moved on again and again, and a `toSha` to merge.
      if (proposal.toSha === null) {
        unavailable.push({ id: 'merge-base', because: { _tag: 'NoCriterion' } })
      } else if ((spent.baseMerges ?? 0) >= BOUNDS.baseBranchMerges) {
        unavailable.push({ id: 'merge-base', because: { _tag: 'CeilingReached', ceiling: 'baseBranchMerges' } })
      } else {
        available.push({
          id: 'merge-base',
          next: { _tag: 'MergeBaseBranch', toSha: proposal.toSha, merge: (spent.baseMerges ?? 0) + 1 },
        })
      }
      break
    }
    case 'ReviewFindings': {
      // `fix.ts:375`'s `actionable`: a finding without a failure scenario is an opinion.
      const hasCriterion = proposal.findings.some((f) => f.failureScenario.trim() !== '')
      round('fix-lines', 'implement', hasCriterion)
      restart(hasCriterion)
      break
    }
    case 'ReviewEmpty':
    // 0108 §14: no reviewer was paid and nothing holds an agent to a round, so
    // only a person is on offer and no judge is asked.
    case 'DiffTooLarge':
      round('fix-lines', 'implement', false)
      restart(false)
      break
    case 'SetupRefused': {
      // #1224, 0108 §18: a registry's 5xx is a rule's. Free, and absent (never `unavailable`) when
      // the output is on no row or the retries are spent, as `land-again` is.
      if (rerunSetup(proposal.output, spent.stepRedos ?? 0) !== null) {
        available.push({
          id: 'rerun-setup',
          next: { _tag: 'RerunStep', step: 'prepared', retry: (spent.stepRedos ?? 0) + 1 },
        })
      }
      const hasCriterion = proposal.output.trim() !== ''
      if (bornAtOrAfterImplement(proposal.from)) round('fix-lines', 'implement', hasCriterion)
      restart(hasCriterion)
      break
    }
    case 'CheckRefused': {
      const hasCriterion = proposal.output.trim() !== ''
      round('fix-lines', 'implement', hasCriterion)
      restart(hasCriterion)
      break
    }
    case 'AnswerUnreadable': {
      // 0108 §12, §18, #1249: an answer that could not be read, empty or not, is a rule's: the
      // same agent is asked again while `stepRedos` is left, then only a person. It judged
      // nothing, so it buys no fix round and no restart.
      if ((spent.stepRedos ?? 0) < BOUNDS.stepRedos) {
        available.push({
          id: 'ask-again',
          next: { _tag: 'RerunStep', step: proposal.from, retry: (spent.stepRedos ?? 0) + 1 },
        })
      }
      round('fix-lines', 'implement', false)
      restart(false)
      break
    }
    case 'NothingProduced': {
      // Retired (0108 §21, #1250): nothing proposes it any more, but a wait on the log may
      // still be answered. It offers no round — it is `AgentFailed` now, and a rule's.
      round('fix-lines', 'implement', false)
      restart(false)
      break
    }
    case 'FixerDisagrees': {
      const hasCriterion = proposal.said !== null && proposal.said.trim() !== ''
      round('fix-lines', 'implement', hasCriterion)
      // 0108 §7: a restart is offered only for `findings`.
      restart(false)
      break
    }
    case 'MergeRefused': {
      // #1221, 0108 §15: origin not answering is a rule's to answer, by landing
      // again from the same head. Free, and offered only while the attempt has
      // retries left. When spent it is simply absent, never `unavailable`: a
      // rule's candidate is never shown to a chooser, and the offer is then
      // byte for byte what it was before this existed.
      if (
        (proposal.reason === 'unreachable' || proposal.reason === 'remote-error') &&
        (spent.landingRetries ?? 0) < BOUNDS.landingRetries
      ) {
        available.push({ id: 'land-again', next: { _tag: 'LandAgain', retry: (spent.landingRetries ?? 0) + 1 } })
      }
      const hasCriterion = proposal.output.trim() !== ''
      round('fix-lines', 'implement', hasCriterion)
      restart(hasCriterion)
      break
    }
    case 'AlreadyDone': {
      // #1251, 0108 §18: the check is a rule's, free, and the only move: there is no criterion yet,
      // so no fix round and no restart is offered, and a person is the floor.
      available.push({
        id: 'check-done',
        next: {
          _tag: 'CheckDone',
          baseSha: proposal.baseSha,
          bodyVersion: proposal.bodyVersion,
          items: proposal.items,
        },
      })
      break
    }
    case 'BudgetExhausted': {
      if (bornAtOrAfterImplement(proposal.from)) round('fix-lines', 'implement', true)
      restart(true)
      break
    }
    default: {
      const unhandled: never = proposal
      throw new ImpossibleRouteError(`unhandled proposal: ${JSON.stringify(unhandled)}`)
    }
  }

  available.push({ id: 'hand-to-person', next: { _tag: 'HandToPerson' } })

  return { proposal, available, unavailable }
}

/**
 * Which directions a built-in answers, and which cost money.
 *
 * A **total** record over the thirteen, so a fourteenth direction does not
 * compile until somebody has said which kind it is — `RUN_OWNER`'s argument in
 * `attribution.ts`, and `#197`'s receipt for what a default costs.
 *
 * `null` does not mean *no judge*. It means **no judge that spends nothing**:
 * the ten are the directions where deciding is a judgement, and 0061 §3's
 * measurement is the whole argument for the split on the first five —
 *
 *     red           34   back to implement with the error       mechanical
 *     verify-failed   26   back to implement with the new base    mechanical
 *     conflict       6   text: resolve · intent: a person
 *     needs-input    —   interrupt, or go round stating the assumption
 *     findings     231   the lines or the approach              ← the judgement
 *
 * — one judge for all twelve pays an agent sixty times to reach a mechanical
 * conclusion, and makes anyone replacing it reimplement the mechanical branches
 * correctly or the loop breaks.
 *
 * **`#471`'s seven are `null` too**, which brings the ten to this count. Each
 * is a judgement nothing built-in should make unasked — rebasing a
 * `MergeRefused{dirty-base}`, restarting a `BudgetExhausted` from the kept
 * work once something builds that (#468; today's `restart` releases the
 * ticket and starts from the base in a fresh worktree, keeping nothing) — so
 * declaring nothing reaches a person, the same floor every direction already
 * has.
 */
export const BUILT_IN_FOR: Record<JudgeWhen, BuiltInJudge | null> = {
  red: 'same-worktree',
  'verify-failed': 'same-worktree',
  conflict: null,
  'needs-input': null,
  findings: null,
  'setup-refused': null,
  'check-refused': null,
  'answer-unreadable': null,
  'fixer-disagrees': null,
  'merge-refused': null,
  'budget-exhausted': null,
  // Allowing a host or installing the sandbox is the operator's (#1157).
  'sandbox-refused': null,
  // Free and mechanical: the base moved on the branch's own files, so merge it in
  // and build and review again (#593). Bounded by `BOUNDS.baseBranchMerges`, not by a judge.
  'base-moved': 'merge-the-base',
  // The check of the declared evidence is a rule's move (`check-done`), taken before any judge (#1251).
  'already-done': 'check-the-evidence',
}

// ─── What follows a cause (0108 §6) ───

/** Every bound a cause's action can spend, by the name 0108 §8 gives it. */
export type CauseBound =
  | 'refusalFixes'
  | 'newAttempts'
  | 'ticketSplits'
  | 'stepRedos'
  | 'conflictResolutions'
  | 'personAsks'

/** Where the wait a triage answered came from: a run that met `run.turns`/`run.wall`, a diff too large to review (0108 §14), or anything else. */
export type CauseOrigin = 'run-limit' | 'diff-too-large' | 'other'

/** What the log says of one bound: how many times it has been spent, and how many it allows. */
export type CauseCounter = { readonly used: number; readonly allowed: number }

/** Why a person is asked rather than anything done: the question is theirs, the environment is, or a bound is spent. */
export type AskPersonWhy =
  | { readonly _tag: 'unclear' }
  | { readonly _tag: 'environment' }
  | { readonly _tag: 'limit'; readonly bound: CauseBound; readonly used: number }

/** What the system does about a cause. `Approve` and `Close` are never one: they are a person's (0118 §11). */
export type CauseAction =
  | { readonly _tag: 'fixRefusal' }
  | { readonly _tag: 'startNewAttempt' }
  | { readonly _tag: 'splitTicket' }
  | { readonly _tag: 'writeSpentOnThenRedoStep'; readonly spentOn: string | null }
  | { readonly _tag: 'redoStep' }
  | { readonly _tag: 'resolveConflict' }
  | { readonly _tag: 'askPerson'; readonly why: AskPersonWhy }

/**
 * **The one table from a cause to what the system does** (0108 §6), pure. `bounds` is what the log says of each
 * bound; nothing here reads it from anywhere, and nothing calls this yet — acting on a cause is #1258's. Exhaustive
 * over `Cause`, no `default`: a later cause is a compile error here.
 *
 * A `ConflictingHunks` is read in order: a hunk only a person can answer, then two sides that contradict, then the
 * rest — a conflict with more hunks than are listed (`hunks: []`) is the rest. A `TicketTooBig` with a plan or
 * `spentOn` null alike is *without a plan* when `plan` is null; from `diff-too-large` redoing does not make a diff
 * smaller, so it asks a person, and from any other origin it is read as `run-limit` is.
 */
export function actionFor(
  cause: Cause,
  origin: CauseOrigin,
  bounds: Readonly<Record<CauseBound, CauseCounter>>,
): CauseAction {
  const within = (bound: CauseBound, action: CauseAction): CauseAction => {
    const { used, allowed } = bounds[bound]
    return used < allowed ? action : { _tag: 'askPerson', why: { _tag: 'limit', bound, used } }
  }
  switch (cause._tag) {
    case 'FixableLines':
      return within('refusalFixes', { _tag: 'fixRefusal' })
    case 'WrongApproach':
      return within('newAttempts', { _tag: 'startNewAttempt' })
    case 'TicketTooBig':
      if (cause.plan !== null) return within('ticketSplits', { _tag: 'splitTicket' })
      if (origin === 'diff-too-large') return { _tag: 'askPerson', why: { _tag: 'unclear' } }
      return within('stepRedos', { _tag: 'writeSpentOnThenRedoStep', spentOn: cause.spentOn })
    case 'Unfinished':
      return within('stepRedos', { _tag: 'redoStep' })
    case 'ConflictingHunks':
      if (cause.hunks.some((h) => h._tag === 'Divergent'))
        return within('personAsks', { _tag: 'askPerson', why: { _tag: 'unclear' } })
      if (cause.hunks.some((h) => h._tag === 'Contradicting')) return within('newAttempts', { _tag: 'startNewAttempt' })
      return within('conflictResolutions', { _tag: 'resolveConflict' })
    case 'SetupBroken':
      return { _tag: 'askPerson', why: { _tag: 'environment' } }
    case 'UndecidedQuestion':
      return within('personAsks', { _tag: 'askPerson', why: { _tag: 'unclear' } })
  }
}
