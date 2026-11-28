/**
 * One PR's page as data (#1320, 0130 §5): `/p/<project>/pr/<n>`, and `/p/<project>/pr/next` for the draft.
 *
 * Pure, like `pr-board.ts`: it takes the PR's events and the state folded from them, and returns every word the page
 * draws, so a test reads them without rendering. **Nothing here asks the log or the code host** — `lib/prs.ts` reads, and
 * the one thing the code host says is `hostLine`'s, drawn by a streamed part. The board appends nothing: the buttons
 * are the commands of `@lingtai/project`, called by server actions.
 *
 * What the page does not draw, because 0.16 does not read it: the review (who asked for a change), a summary run on
 * demand, a workflow re-run, and how far `main` has moved since the sync.
 */
import { PR_FIX_LABEL } from '@lingtai/conductor/labels'
import {
  type Envelope,
  type PayloadOf,
  type PrState,
  GENERATED_SECTIONS,
  firstFrozenSha,
  isOpen,
  prDescription,
  prStepRows,
  prWaitOf,
  reducePr,
  summaryEditTransition,
} from '@lingtai/domain'
import { type Recipe, ceilingOf, remoteOf, ticketSourceOf } from '@lingtai/recipe'
import { Effect } from 'effect'

import type { Tone } from '../app/object-title.tsx'
import { summarise } from './history.ts'
import { prPath } from './paths.ts'
import {
  type Button,
  DRAFT_NAME,
  type DraftTicket,
  type PrRead,
  WAIT_WORDS,
  UNFOLLOWED_WHY,
  failingChecks,
  failingRun,
  prName,
  slipsOf,
  unfollowedRemote,
} from './pr-board.ts'
import { type Drawing, layoutBranches, prBranches } from './pr-branches.ts'
import { type PrFixRead, claimedFixes, NOT_FIXING, fixingLines, fixingOf, unknownLine } from './pr-fix.ts'

/** Whether the PR is pushed to GitHub: the recipe names no remote of its own (`prHostOf`, 0130 §5). */
export const githubHosted = (recipe: Recipe): boolean => remoteOf(recipe) === null

/** Whether the project's *tickets* are on GitHub (`source.tickets`): a different axis from where the PR is pushed. */
export const ticketsOnGitHub = (recipe: Recipe): boolean => ticketSourceOf(recipe) === 'github'

// ── The ticket a person opens for a change the review asked for ────────────────────────────────────────────────────

export type PrFixLink =
  | { readonly kind: 'link'; readonly href: string }
  | { readonly kind: 'command'; readonly command: string; readonly note: string }

/**
 * *New pr-fix ticket* (0130 §5: *opened from the PR's page the label is put on for the person*). **The board creates no
 * issue** — it fills in what it knows (what the PR waits on, and for a red CI run every failing check with its link),
 * and the person reads it, adds what only they know, and submits it. On GitHub it is the new-issue form with the label,
 * a title and a body put in; on a project with no GitHub host it is the command, and the line to write.
 */
/** GitHub's new-issue URL is refused past about 8,000 characters; the whole URL is kept under this. */
const ISSUE_URL_LIMIT = 8000
/** How many failing checks the title and the Problem row name before `, and N more`. */
const NAMED_CHECKS = 3
/** A wait's `detail` is cut here, so the fixed part of the body cannot fill the URL on its own. */
const DETAIL_CUT = 500
/** A check's name is cut here in the title and the Problem row. */
const NAME_CUT = 100

/** Cut at `n` code points, never inside a surrogate pair: `encodeURIComponent` throws on a lone one. */
const cut = (text: string, n: number): string => {
  const chars = Array.from(text)
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : text
}

/** Any lone surrogate (from a name or a detail the board did not write) becomes U+FFFD, so the URL can be encoded. */
const wellFormed = (text: string): string =>
  text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')

/** What each tier of the draft keeps; a tier is tried only when the one before it did not fit the URL. */
type Keep = { named: number; name: number; detail: number; branch: number }
const TIERS: readonly Keep[] = [
  { named: NAMED_CHECKS, name: NAME_CUT, detail: DETAIL_CUT, branch: Infinity },
  { named: 1, name: 40, detail: 100, branch: 100 },
  { named: 0, name: 0, detail: 0, branch: 40 },
]

/** A value in a table row: `|` would end the cell and a newline would end the row. */
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s*[\r\n]+\s*/g, ' ')

/** The rest of a table row after its label: an empty value is `| |`, as the house shape writes it. */
const row = (text: string): string => (text === '' ? ' |' : ` ${cell(text)} |`)

/** One failing check's line in Evidence; a check with no link has nothing after its state. */
const checkLine = (c: { name: string; state: string; url: string }): string =>
  `  - ${c.name.replace(/[\r\n]+/g, ' ')} — ${c.state}${c.url === '' ? '' : ` — ${c.url}`}`

/**
 * What the board knows of the PR's wait, as the title and the body of the ticket (the four-row table, then Evidence).
 * Reads only `pr`: a wait counts only while the PR is waiting, and the failing checks only when they were read on the
 * head the wait names — never a failure the state does not hold.
 */
function prFixDraft(
  name: string,
  pr: PrState | null,
  keep: Keep,
): {
  title: string
  body: (n: number, more: number) => string
  checks: readonly { name: string; state: string; url: string }[]
  prUrl: string | null
} {
  // A pr-fix landing or an adopted head moves `lastPushed` and leaves `wait`, `checks` and `following` on the head before
  // it: until In progress starts again they are about a head that is no longer the PR's. `adopted` stays set until a build
  // of it is recorded, so it is stale only against a wait that names another head: a wait recorded on the adopted head is
  // the build's own, and is written.
  const moved = pr !== null && (pr.fixOwed || (pr.adopted !== null && pr.wait?.headSha !== pr.adopted))
  const wait = pr !== null && !moved && pr.status === 'waiting' && pr.wait !== null ? pr.wait : null
  // The head the state last knew: the wait's; else, when nothing has moved it since, the last checked or followed; else
  // what Lingtai means to push (a sync or an outside merge moves `target` past `lastPushed`).
  const head =
    wait !== null
      ? wait.headSha
      : pr === null
        ? null
        : moved
          ? (pr.lastPushed ?? pr.target)
          : (pr.checks?.headSha ?? pr.following ?? pr.target ?? pr.lastPushed)
  const sha = head === null ? null : head.slice(0, 7)
  const headWords = sha === null ? '' : ` (head \`${sha}\`)`
  const failing =
    pr !== null && wait !== null && wait.reason === 'ci-red' && pr.checks !== null && pr.checks.headSha === wait.headSha
      ? failingChecks(pr)
      : []
  const named = failing.slice(0, keep.named).map((c) => cut(c.name, keep.name))
  const namedWords =
    named.length === 0
      ? `${failing.length} failing checks`
      : named.join(', ') + (failing.length > named.length ? `, and ${failing.length - named.length} more` : '')

  let title = `pr-fix for ${name}: `
  let problem = ''
  let want = ''
  if (wait !== null) {
    const words = WAIT_WORDS[wait.reason]
    if (failing.length > 0) {
      title += `CI red in ${namedWords}`
      problem = `CI is red on ${name}${headWords}: ${namedWords}.`
      want = "CI is green on the PR's next head."
    } else {
      title += words
      const detail = wait.detail.trim()
      problem = `${words} on ${name}${headWords}${detail === '' ? '.' : `: ${cut(detail, keep.detail)}${/[.!?]$/.test(detail) ? '' : '.'}`}`
    }
  }

  const prUrl = pr?.host?.url ?? null
  const facts = [
    name,
    pr?.prBranch ? `branch \`${cut(pr.prBranch, keep.branch)}\`` : null,
    sha === null ? null : `head \`${sha}\``,
  ]
    .filter((x) => x !== null)
    .join(', ')

  const body = (n: number, more: number): string =>
    [
      '| | |',
      '|---|---|',
      `| **Problem** |${row(problem)}`,
      `| **Want** |${row(want)}`,
      '| **Fix** | |',
      '| **Watch out** | |',
      '',
      '---',
      '',
      '## Evidence',
      '',
      `- ${facts}.`,
      ...(more > 0 && prUrl !== null ? [`- PR page: ${prUrl}`] : []),
      ...(failing.length > 0 ? ['- Failing checks:', ...failing.slice(0, n).map(checkLine)] : []),
      ...(more > 0 ? [`  - … and ${more} more on the PR page`] : []),
      '',
    ].join('\n')

  return { title: cell(title), body, checks: failing, prUrl }
}

export function prFixTicketLink(input: {
  readonly project: string
  readonly owner: string | null
  /** Whether the project's tickets are on GitHub. */
  readonly github: boolean
  /** The PR's name as the page draws it: `PR #88`. */
  readonly name: string
  /** The PR's state, which holds what it waits on; null where there is no PR (the board's fallback link). */
  readonly pr?: PrState | null
}): PrFixLink | null {
  if (!input.github) {
    return {
      kind: 'command',
      command: `lingtai ticket new --project ${input.project}`,
      note: `put ${PR_FIX_LABEL} on its labels: line`,
    }
  }
  if (input.owner === null || input.owner === '') return null
  const urlOf = (title: string, body: string): string =>
    `https://github.com/${input.owner}/${input.project}/issues/new?labels=${encodeURIComponent(PR_FIX_LABEL)}` +
    `&title=${encodeURIComponent(wellFormed(title))}&body=${encodeURIComponent(wellFormed(body))}`
  // The most checks that fit, measured on the encoded URL; the "N more" line is held back for until the last one fits.
  // When even none fits, the draft keeps less of its names, detail and branch, tier by tier.
  for (const keep of TIERS) {
    const draft = prFixDraft(input.name, input.pr ?? null, keep)
    const total = draft.checks.length
    for (let n = total; n >= 0; n--) {
      const candidate = urlOf(draft.title, draft.body(n, total - n))
      if (candidate.length < ISSUE_URL_LIMIT) return { kind: 'link', href: candidate }
    }
  }
  // Nothing the state holds fits: the empty form with the PR's name, which is never guessed at and never long.
  const bare = prFixDraft(cut(input.name, NAME_CUT), null, TIERS[2]!)
  return { kind: 'link', href: urlOf(bare.title, bare.body(0, 0)) }
}

// ── What the code host says, as the one streamed part draws it ──────────────────────────────────────────────────────

/** `getPull`'s answer by the fields read, or why it could not be had. Never *closed* from a failed read. */
export type HostRead =
  | { readonly kind: 'ok'; readonly state: 'open' | 'closed'; readonly merged: boolean; readonly draft: boolean }
  | { readonly kind: 'failed'; readonly reason: string }

/**
 * The poster's small line for the host's word. **Nothing is appended from the render**: a host that says *merged* before
 * the log does gets a note, and #1317's sweep writes the event.
 */
export function hostLine(pr: Pick<PrState, 'status'>, read: HostRead): { text: string; failed: boolean } {
  if (read.kind === 'failed') return { text: `GitHub could not be asked: ${read.reason}`, failed: true }
  if (read.state === 'closed' && read.merged && pr.status !== 'merged') {
    return { text: 'merged on GitHub — Lingtai records it within five minutes', failed: false }
  }
  if (read.state === 'closed' && !read.merged && pr.status !== 'closed') {
    return { text: 'closed on GitHub — Lingtai records it within five minutes', failed: false }
  }
  if (read.state === 'closed') return { text: read.merged ? 'merged on GitHub' : 'closed on GitHub', failed: false }
  return { text: read.draft ? 'a draft on GitHub' : 'open on GitHub', failed: false }
}

// ── The page ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PageStep {
  readonly step: string
  readonly label: string
  /** `reached` ones say how they went; `running` is the one in flight; `not-reached` is after where the PR stopped. */
  readonly status: 'done' | 'waiting' | 'running' | 'not-reached' | 'skipped'
  readonly mark: '✓' | '✕' | '…' | '·' | '—'
  readonly text: string
  readonly duration: string | null
  readonly link: { readonly label: string; readonly href: string } | null
}

export interface StripState {
  readonly id: 'draft' | 'progress' | 'waiting' | 'review' | 'merged'
  readonly label: string
  readonly mode: 'done' | 'current' | 'idle'
}

export interface PageTicket {
  readonly ticket: string
  readonly title: string
  readonly fix: boolean
}

export interface PageCheck {
  readonly name: string
  readonly result: string
  readonly url: string | null
  readonly failing: boolean
}

export interface PageSummary {
  /** What the textarea starts as: the summary as it stands, never the generated rest. */
  readonly text: string
  readonly editable: boolean
  /** Why it cannot be edited, from the command's own refusal. */
  readonly refusal: string | null
  /** The generated rest of the description, read-only and regenerated from the log. */
  readonly generated: string
  readonly notes: readonly string[]
  readonly saveLabel: string
}

export interface PageWait {
  readonly word: string
  readonly detail: string
  readonly lines: readonly string[]
  readonly byHand: readonly string[]
}

export interface PrPageView {
  readonly kind: 'pr' | 'draft'
  readonly n: number | null
  readonly header: {
    readonly name: string
    readonly title: string
    readonly host: { readonly label: string; readonly href: string } | null
  }
  readonly sub: string
  readonly poster: {
    readonly word: string
    /** The tag's colour, from the status and not the display word: `requested` says SUBMITTED but is the queued card. */
    readonly tone: Tone
    readonly where: string
    readonly line: string
  }
  readonly strip: readonly StripState[]
  /** The three branches as the events draw them (#1373); null where it cannot be drawn rather than drawn empty. */
  readonly drawing: Drawing | null
  readonly steps: readonly PageStep[]
  readonly stepsNote: string | null
  readonly tickets: readonly PageTicket[]
  readonly summary: PageSummary | null
  readonly wait: PageWait | null
  readonly buttons: readonly Button[]
  readonly fixCommand: { readonly command: string; readonly note: string } | null
  readonly doNote: string | null
  /** The `fixing:` lines: a link to each pr-fix ticket on this PR, in place of *New pr-fix ticket* (#1506). */
  readonly fixing?: readonly { readonly text: string; readonly href: string }[]
  readonly facts: readonly { readonly label: string; readonly value: string }[]
  readonly checks: { readonly head: string; readonly rows: readonly PageCheck[] }
  readonly history: readonly { readonly at: string; readonly text: string }[]
  /** An empty Next PR's first sentence: where the last tickets went. Null on every other page. */
  readonly previous: {
    readonly lead: string
    readonly name: string
    readonly state: string
    readonly href: string | null
  } | null
}

/** The newest submitted PR, for an empty Next PR: where its tickets went and the point the drawing marks. */
export interface PreviousPr {
  readonly pr: PrState
  /** The commit the personal branch was frozen at (the PR's first `PrInProgress`); null where unknown or not wanted. */
  readonly frozenSha: string | null
  /** The newest caught-up point of any PR. */
  readonly caughtUp: { readonly sha: string; readonly n: number | null } | null
}

/**
 * What an empty Next PR page says about where the tickets went: the newest PR that is not a draft (`openAmong`'s walk without
 * its open-only cut), the commit its first `PrInProgress` froze the personal branch at, and the newest caught-up point.
 * The freeze commit is read from that PR's own events, because `PrState.frozenSha` is the latest walk's, and only when the
 * drawing needs it. **A PR that could not be read fails this** rather than being skipped: it may be the newest, and the page
 * would then name an older PR as where the tickets went. A freeze read that fails fails it too.
 */
export const previousOf = (
  draft: PrPageInput['draft'],
  reads: readonly PrRead[],
  readEvents: (n: number) => Effect.Effect<readonly Envelope[], Error>,
): Effect.Effect<PreviousPr | null, Error> =>
  Effect.gen(function* () {
    // Only an empty draft names a previous PR; a draft with tickets, or one that could not be read, reads nothing more.
    if ('error' in draft || draft.length > 0) return null
    const prs: PrState[] = []
    for (const r of reads) {
      if ('error' in r) return yield* Effect.fail(new Error(`PR ${r.n} could not be read: ${r.error}`))
      prs.push(r.pr)
    }
    let pr: PrState | null = null
    for (let i = prs.length - 1; i >= 0; i--) {
      if (prs[i]!.status !== 'draft') {
        pr = prs[i]!
        break
      }
    }
    if (pr === null) return null
    let caughtUp: PreviousPr['caughtUp'] = null
    for (let i = prs.length - 1; i >= 0; i--) {
      const c = prs[i]!.catchUp
      if (c?.outcome === 'caught-up') {
        caughtUp = { sha: c.mergeCommit ?? c.mainSha, n: prs[i]!.n }
        break
      }
    }
    let frozenSha: string | null = null
    if (caughtUp === null && pr.n !== null && pr.status !== 'closed' && pr.status !== 'refused') {
      frozenSha = firstFrozenSha(yield* readEvents(pr.n))
    }
    return { pr, frozenSha, caughtUp }
  })

export interface PrPageInput {
  readonly project: string
  readonly recipe: Recipe
  readonly owner: string | null
  /** The PR, or null for the draft. */
  readonly pr: PrState | null
  /** The PR's own events, oldest first: step durations and the history are read from them. */
  readonly events: readonly Envelope[]
  /** The draft's tickets, or why they could not be read. Only for the draft. */
  readonly draft: readonly DraftTicket[] | { readonly error: string }
  /** The PR that is open now, whose name a draft's Submit says it waits for. */
  readonly open: PrState | null
  /** The newest PR that is not a draft; only the draft's page reads it. */
  readonly previous?: PreviousPr
  /** What the PR's stream cost, reported; null is unknown, never `$0`. */
  readonly spend: number | null
  /** What each ticket cost and whether it is still open, as the daemon's description reads them; absent is unknown. */
  readonly facts?: readonly { readonly ticket: string; readonly open: boolean | null; readonly spend: number | null }[]
  /** The two parts of `spend`, for Facts: what the tickets cost and what the PR's own runs cost. Null is unknown. */
  readonly spendParts?: { readonly tickets: number | null; readonly pr: number | null }
  /** The conductor's own step list, in order. */
  readonly stepNames: readonly string[]
  /** The pr-fix tickets read for this PR (#1506); null or absent where nothing was asked. */
  readonly fixes?: PrFixRead | null
  readonly now: Date
}

const STEP_LABELS: Record<string, string> = {
  sync: 'Bring main in',
  build: 'Build',
  summary: 'Summary',
  push: 'Push',
  open: 'Open the draft PR',
  ci: 'CI',
  topup: 'Extend the summary',
  ready: 'Ready for review',
}

const STRIP: readonly Omit<StripState, 'mode'>[] = [
  { id: 'draft', label: 'Draft' },
  { id: 'progress', label: 'In progress' },
  { id: 'waiting', label: 'Waiting on you' },
  { id: 'review', label: 'In review' },
  { id: 'merged', label: 'Merged' },
]

const POSTER: Record<string, string> = {
  requested: 'SUBMITTED',
  'in-progress': 'IN PROGRESS',
  waiting: 'WAITING ON YOU',
  'in-review': 'IN REVIEW',
  refused: 'REFUSED',
  merged: 'MERGED',
  closed: 'CLOSED',
}

const POSTER_TONE: Record<string, Tone> = {
  waiting: 'fail',
  merged: 'pass',
  'in-progress': 'accent',
  requested: 'queued',
}

const CHECK_WORDS: Record<string, string> = {
  success: 'passed',
  failure: 'failed',
  'timed-out': 'timed out',
}

const money = (n: number | null): string => (n === null ? 'spend unknown' : `$${n.toFixed(2)}`)
function spendFact(input: Pick<PrPageInput, 'spend' | 'spendParts'>): string {
  const parts = input.spendParts
  if (input.spend === null || parts === undefined || parts.tickets === null || parts.pr === null)
    return money(input.spend)
  return `${money(input.spend)} · tickets ${money(parts.tickets)} · PR runs ${money(parts.pr)}`
}
const short = (sha: string | null): string => (sha === null ? '?' : sha.slice(0, 7))
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
const day = (d: Date): string => `${d.toISOString().slice(5, 10)} ${d.toISOString().slice(11, 16)}`

function span(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function age(from: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - from.getTime())
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}

/** The events of the last time through In progress: everything after the latest `PrInProgress`. */
function lastPass(events: readonly Envelope[]): readonly Envelope[] {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.type === 'PrInProgress') return events.slice(i)
  return []
}

/**
 * Each step's duration: the time from the previous step's completion (or the `PrInProgress`) to the event that recorded
 * the step as done — whichever event that was (`PrStepDone`, `BranchSynced`, `PrPushed`, `PrChecked`…). Found by folding the
 * events with `reducePr` and noting when each step first appears, so it spans the step's whole run rather than the append
 * gap before one event.
 */
function stepDurations(events: readonly Envelope[]): Map<string, number> {
  const out = new Map<string, number>()
  let start = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === 'PrInProgress') {
      start = i
      break
    }
  }
  if (start < 0) return out
  let from = events[start]!.at.getTime()
  for (let i = start + 1; i < events.length; i++) {
    for (const s of reducePr(events.slice(0, i + 1)).steps) {
      if (out.has(s.step)) continue
      const at = events[i]!.at.getTime()
      out.set(s.step, at - from)
      from = at
    }
  }
  return out
}

/** The conflict agent's rounds for the last `BranchSynced`: those started after the sync before it, or the pass's start. */
function roundsOfLastSync(events: readonly Envelope[]): number {
  let end = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === 'BranchSynced') {
      end = i
      break
    }
  }
  if (end < 0) return 0
  let from = 0
  for (let i = end - 1; i >= 0; i--) {
    if (events[i]!.type === 'BranchSynced' || events[i]!.type === 'PrInProgress') {
      from = i
      break
    }
  }
  let n = 0
  for (let i = from; i < end; i++) {
    const e = events[i]!
    if (e.type === 'SyncRoundStarted' && (e.data as PayloadOf<'SyncRoundStarted'>).merging === 'main') n++
  }
  return n
}

const last = <T>(xs: readonly T[], f: (x: T) => boolean): T | undefined => {
  for (let i = xs.length - 1; i >= 0; i--) if (f(xs[i]!)) return xs[i]
  return undefined
}

function stepRows(pr: PrState, events: readonly Envelope[], names: readonly string[], recipe: Recipe): PageStep[] {
  const pass = lastPass(events)
  const times = stepDurations(events)
  const synced = last(pass, (e) => e.type === 'BranchSynced')?.data as PayloadOf<'BranchSynced'> | undefined
  const pushed = last(pass, (e) => e.type === 'PrPushed')?.data as PayloadOf<'PrPushed'> | undefined
  const view = prWaitOf(pr, {
    project: pr.project ?? '',
    checkout: null,
    conflictResolutions: ceilingOf(recipe).attempt.conflictResolutions,
  })
  const notWritten = (at: string) => {
    const e = last(
      pass,
      (x) => x.type === 'PrSummaryNotWritten' && (x.data as PayloadOf<'PrSummaryNotWritten'>).at === at,
    )
    return e === undefined ? null : (e.data as PayloadOf<'PrSummaryNotWritten'>).why
  }
  const topupWhy = notWritten('pr-fix')
  const rows = prStepRows(names, pr)
  const inFlight =
    pr.status === 'in-progress' || pr.status === 'requested' ? rows.find((r) => r.status === 'pending') : undefined
  const out: PageStep[] = []
  for (const row of rows) {
    const label = STEP_LABELS[row.step] ?? row.step
    const ms = times.get(row.step)
    const duration = ms === undefined || ms <= 0 ? null : span(ms)
    const base = { step: row.step, label, duration, link: null as PageStep['link'] }
    if (row.status === 'pending' && (row.step === 'ci' || row.step === 'ready') && unfollowedRemote(pr)) {
      out.push({
        ...base,
        status: 'skipped',
        mark: '—',
        text:
          row.step === 'ci'
            ? `no CI step — ${UNFOLLOWED_WHY}`
            : 'opening the PR and marking it ready is yours to do on this remote',
        duration: null,
      })
      continue
    }
    if (row.status === 'pending') {
      if (inFlight !== undefined && inFlight.step === row.step) {
        out.push({ ...base, status: 'running', mark: '…', text: 'running now', duration: null })
      } else if (row.step === 'topup') {
        // The top-up runs only when a pr-fix joined since the summary was tried: not reached is not worth a row.
        continue
      } else {
        out.push({
          ...base,
          status: 'not-reached',
          mark: '·',
          text: 'not reached — the PR stopped before it',
          duration: null,
        })
      }
      continue
    }
    if (row.status === 'waiting') {
      const run = row.step === 'ci' ? failingRun(pr) : null
      out.push({
        ...base,
        status: 'waiting',
        mark: '✕',
        text: view !== null ? `${WAIT_WORDS[view.reason]} — ${view.detail}` : (pr.wait?.detail ?? 'waiting'),
        duration: null,
        link: run === null ? null : { label: 'runs ↗', href: run },
      })
      continue
    }
    // done
    let text = 'done'
    let status: PageStep['status'] = 'done'
    if (row.step === 'topup') {
      // `topup` answers done with no run when no pr-fix joined: only a run (`PrSummaryWritten` at `pr-fix`) is a row.
      if (
        topupWhy === null &&
        !pass.some((e) => e.type === 'PrSummaryWritten' && (e.data as PayloadOf<'PrSummaryWritten'>).at === 'pr-fix')
      )
        continue
    }
    let link: PageStep['link'] = null
    if (row.step === 'sync') {
      if (synced === undefined) text = 'main brought in'
      else if (synced.how === 'already') text = 'nothing to bring in'
      else if (synced.how === 'clean') text = 'main brought in, clean'
      else {
        // Rounds are the PR's for its lifetime: this sync's are the ones started since the sync before it finished, or
        // since this pass began — a retried sync of the same `main` commit does not inherit the failed one's.
        const used = roundsOfLastSync(events)
        text = `a conflict resolved by the agent · ${plural(used, 'round', 'rounds')}`
      }
    } else if (row.step === 'build') {
      text = 'built'
    } else if (row.step === 'push') {
      text = `${pushed?.found === 'existing' ? 'already on the branch' : 'pushed'} · ${short(pushed?.headSha ?? row.headSha)} → ${pr.prBranch ?? 'the PR branch'}`
    } else if (row.step === 'ci') {
      if (pr.ciSkipped !== null && pr.checks === null) {
        text = `no CI step — ${pr.ciSkipped.why}`
      } else if (pr.checks !== null) {
        const ok = pr.checks.checks.filter((c) => ['success', 'neutral', 'skipped'].includes(c.state)).length
        text = `${ok} of ${pr.checks.checks.length} checks green`
        const run = failingRun(pr) ?? pr.checks.checks.find((c) => c.url !== '')?.url ?? null
        link = run === null ? null : { label: 'runs ↗', href: run }
      }
    } else if (row.step === 'summary') {
      // A top-up that wrote nothing is the top-up row's: the Summary row keeps its own attempt's outcome.
      // Only this pass's own events: `pr.summaryNotWritten` lives for the PR and would blame a row for an earlier pass.
      // `summaryStep` does not run again once tried, so a retry's pass holds no summary event: the submit outcome is the
      // latest one at `submit` in the whole stream, a later write clearing an earlier failure.
      const submitted = last(
        events,
        (x) =>
          (x.type === 'PrSummaryNotWritten' || x.type === 'PrSummaryWritten') &&
          (x.data as { at?: string }).at === 'submit',
      )
      const why =
        submitted?.type === 'PrSummaryNotWritten' ? (submitted.data as PayloadOf<'PrSummaryNotWritten'>).why : null
      if (why !== null) {
        status = 'skipped'
        text = `no summary: ${why}`
      } else if (pr.edited !== null) text = 'written, then edited by you'
      else text = pr.summary?.text != null ? 'written by the agent' : 'done'
    } else if (row.step === 'topup') {
      if (topupWhy !== null) {
        status = 'skipped'
        text = `no summary: ${topupWhy}`
      } else text = 'the summary extended for the pr-fix'
    } else if (row.step === 'ready') {
      text = 'ready for review'
    }
    out.push({ ...base, status, mark: status === 'skipped' ? '—' : '✓', text, link })
  }
  return out
}

function stripOf(pr: PrState | null): StripState[] {
  const at =
    pr === null
      ? 0
      : pr.status === 'requested' || pr.status === 'in-progress'
        ? 1
        : pr.status === 'waiting'
          ? 2
          : pr.status === 'in-review'
            ? 3
            : pr.status === 'merged'
              ? 4
              : -1
  return STRIP.map((s, i) => ({
    ...s,
    mode: i === at ? 'current' : i < at && !(s.id === 'waiting' && at !== 2) ? 'done' : 'idle',
  }))
}

const checkRows = (pr: PrState): PageCheck[] =>
  (pr.checks?.checks ?? []).map((c) => ({
    name: c.name,
    result: CHECK_WORDS[c.state] ?? c.state,
    url: c.url === '' ? null : c.url,
    failing: c.failing === true || c.state === 'failure' || c.state === 'timed-out',
  }))

/** The generated rest of the description: what the daemon regenerates from the log, under the person's summary. */
export function generatedBody(pr: PrState, facts: PrPageInput['facts']): string {
  return prDescription(
    {
      title: null,
      // Only whether there is a summary: it decides what the tickets section writes, and its text is not shown here.
      summary: pr.summary?.text ?? null,
      tickets: pr.tickets.map((t) => {
        const read = facts?.find((f) => f.ticket === t.ticket)
        return { ...t, open: read?.open ?? null }
      }),
    },
    GENERATED_SECTIONS,
  ).body
}

/** The drawing's width: the card's, as a viewBox; the SVG scales to it and nothing scrolls sideways. */
const DRAWING_WIDTH = 1000

function drawingOf(
  pr: PrState | null,
  events: readonly Envelope[],
  input: PrPageInput,
  main: string,
  personal: string,
): Drawing | null {
  const model = prBranches(pr, events, input.draft, { main, personal, stepNames: input.stepNames }, input.previous)
  return model === null ? null : layoutBranches(model, DRAWING_WIDTH)
}

/** The page's whole text for one PR, or for the draft when `pr` is null. */
export function prPage(input: PrPageInput): PrPageView {
  const { project, recipe, pr, events } = input
  const main = recipe.branch.main
  const personal = recipe.branch.personal ?? main
  const github = githubHosted(recipe)
  if (pr === null) return draftPage(input, main, personal)

  const name = prName(pr)
  const all = slipsOf(pr)
  const lastEvent = events[events.length - 1]?.at ?? null
  const hostOpen = github && pr.host !== null && isOpen(pr)
  const where = hostOpen ? 'ON GITHUB' : ''
  const poster = {
    word: POSTER[pr.status ?? ''] ?? String(pr.status).toUpperCase(),
    tone: POSTER_TONE[pr.status ?? ''] ?? 'navy',
    where,
    line: [where, lastEvent === null ? '' : age(lastEvent, input.now)].filter((x) => x !== '').join(' · '),
  }

  // Do — only what the state allows.
  const buttons: Button[] = []
  let fixCommand: PrPageView['fixCommand'] = null
  let doNote: string | null = null
  const fix = prFixTicketLink({ project, owner: input.owner, github: ticketsOnGitHub(recipe), name, pr })
  // Only a PR that is waiting or in review can be fixed now; the read may also have been made for History alone.
  const fixing =
    pr.status === 'waiting' || pr.status === 'in-review'
      ? fixingOf(pr, input.fixes ?? null)
      : input.fixes?.kind === 'failed'
        ? { ...NOT_FIXING, unknown: input.fixes.error }
        : NOT_FIXING
  const addFix = () => {
    if (fix === null || fixing.tickets.length > 0) return
    if (fix.kind === 'link') buttons.push({ kind: 'link', label: 'New pr-fix ticket', href: fix.href })
    else fixCommand = { command: fix.command, note: fix.note }
  }
  const wait =
    pr.status === 'waiting'
      ? prWaitOf(pr, {
          project,
          checkout: null,
          conflictResolutions: ceilingOf(recipe).attempt.conflictResolutions,
        })
      : null
  let waitView: PageWait | null = null

  if (pr.status === 'requested') doNote = 'submitted — it is served when a conductor runs'
  else if (pr.status === 'in-progress') {
    const run = stepRows(pr, events, input.stepNames, recipe).find((s) => s.status === 'running')
    doNote = run === undefined ? 'Lingtai is working on it' : `Lingtai is working on it — ${run.label}`
  } else if (pr.status === 'waiting' && wait !== null) {
    if (wait.kind === 'conflict') {
      if (wait.reason === 'sync-conflict' && wait.commit !== null && wait.merging !== null) {
        buttons.push({
          kind: 'rounds',
          label: 'Give the agent 3 more rounds',
          grant: { merging: wait.merging, commit: wait.commit },
        })
      }
      buttons.push({ kind: 'retry', label: 'I resolved it — check again' })
      waitView = {
        word: WAIT_WORDS[wait.reason],
        detail: wait.detail,
        lines: [
          `${wait.merging === 'back' ? 'at merge back' : 'at submit'} · ${wait.paths === null ? 'files unknown' : wait.paths.join(', ')}`,
          wait.roundsUsed === null || wait.roundsAllowed === null
            ? 'rounds: unknown'
            : `${wait.roundsUsed} of ${wait.roundsAllowed} rounds spent`,
          wait.ours === null
            ? 'ours: unknown'
            : `ours ${wait.ours.map((o) => `#${o.issue} ${o.title}`).join(', ') || 'none'}`,
          wait.theirs === null
            ? 'theirs: unknown'
            : `theirs ${wait.theirs.map((t) => `${short(t.sha)} ${t.author}`).join(', ') || 'none'}`,
          ...(wait.lastRefusal === null ? [] : [`last refusal: ${wait.lastRefusal.step}`]),
        ],
        byHand: wait.commands,
      }
    } else {
      const ci = wait.reason === 'ci-red' || wait.reason === 'ci-none-started' || wait.reason === 'ci-timeout'
      // Only the waits a retry ends have a button; `draft-unsupported` and the rest say what happened.
      if (wait.commands.length > 0) buttons.push({ kind: 'retry', label: 'Check again' })
      if (ci) {
        addFix()
        const run = failingRun(pr)
        if (run !== null) buttons.push({ kind: 'link', label: 'Open the run ↗', href: run })
      }
      waitView = {
        word: WAIT_WORDS[wait.reason],
        detail: wait.detail,
        lines: wait.reason === 'draft-unsupported' ? [] : [`stopped at ${STEP_LABELS[wait.step] ?? wait.step}`],
        byHand: wait.commands,
      }
    }
  } else if (pr.status === 'in-review') {
    addFix()
    if (pr.host !== null) buttons.push({ kind: 'link', label: 'Review on GitHub ↗', href: pr.host.url })
  } else if (pr.status === 'merged') doNote = 'its tickets are closed'
  else if (pr.status === 'closed') doNote = 'closed without merging — its tickets are back in the draft'
  else if (pr.status === 'refused') doNote = pr.refusal?.detail ?? 'the submit was refused'

  if (fixing.unknown !== null)
    doNote = doNote === null ? unknownLine(fixing.unknown) : `${doNote} — ${unknownLine(fixing.unknown)}`

  // The summary and the generated rest.
  const edit = summaryEditTransition(pr, 'team', project, { by: 'page', summary: 'x' })
  const editedAt = last(events, (e) => e.type === 'PrSummaryEdited')?.at ?? null
  const notes: string[] = []
  if (pr.summaryNotWritten !== null) notes.push(`no summary: ${pr.summaryNotWritten}`)
  if (editedAt !== null) notes.push(`edited by you ${day(editedAt)} · the Closes lines are kept`)
  if (pr.descriptionOwed) {
    notes.push(
      github
        ? "GitHub's copy is behind; Lingtai puts it there on its next pass"
        : 'the description is printed for you to paste',
    )
  } else if (!github) notes.push('this remote is not GitHub: the description is printed for you to paste (lingtai pr)')
  notes.push('an unsaved edit lives in this form only and is lost on reload')
  const summary: PageSummary = {
    text: pr.summary?.text ?? '',
    editable: edit.kind === 'request',
    refusal: edit.kind === 'refused' ? edit.detail : null,
    generated: generatedBody(pr, input.facts),
    notes,
    saveLabel: 'Save',
  }

  // Facts.
  const mb = pr.mergeBack
  const head = pr.lastPushed ?? pr.target ?? pr.frozenSha
  const synced = last(events, (e) => e.type === 'BranchSynced')
  const facts: { label: string; value: string }[] = [
    { label: 'Branch', value: pr.prBranch ?? '?' },
    { label: 'Base', value: pr.main ?? main },
    { label: 'Head', value: `${short(head)}${pr.lastPushed === null ? '' : ' · pushed by Lingtai'}` },
    { label: 'Main', value: synced === undefined ? 'not brought in yet' : `brought in ${day(synced.at)}` },
    { label: 'Spend', value: spendFact(input) },
  ]
  if (mb !== null && mb.outcome === 'failed' && mb.prHead === head) {
    facts.push({
      label: 'Merge back',
      value: `a pr-fix change is on this PR's branch and not yet on ${personal}${mb.why === 'unknown' ? ' — will be tried again' : ''}`,
    })
  }

  const spendNote = input.spend === null ? 'spend unknown' : `${money(input.spend)} so far`
  const rows = checkRows(pr)
  return {
    kind: 'pr',
    n: pr.n,
    header: {
      name,
      title: pr.summary?.title ?? all[0]?.title ?? '',
      host: pr.host === null ? null : { label: `GitHub #${pr.host.number} ↗`, href: pr.host.url },
    },
    sub: [
      `${pr.prBranch ?? '?'} → ${pr.main ?? main}`,
      `Lingtai PR ${pr.n ?? '?'}`,
      pr.requestedAt === null ? null : `submitted ${day(pr.requestedAt)}`,
      plural(all.length, 'ticket', 'tickets'),
      spendNote,
    ]
      .filter((x): x is string => x !== null)
      .join(' · '),
    poster,
    strip: stripOf(pr),
    drawing: drawingOf(pr, events, input, main, personal),
    steps: stepRows(pr, events, input.stepNames, recipe),
    stepsNote: pr.status === 'requested' ? 'not started: it is served when a conductor runs' : null,
    tickets: all,
    summary,
    wait: waitView,
    buttons,
    fixCommand,
    doNote,
    fixing: fixingLines(project, fixing),
    facts,
    checks: {
      head:
        pr.checks !== null
          ? `${rows.length} checks`
          : pr.ciSkipped !== null
            ? `no CI step — ${pr.ciSkipped.why}`
            : unfollowedRemote(pr)
              ? `no CI step — ${UNFOLLOWED_WHY}`
              : 'no checks ran',
      rows,
    },
    history: [
      ...events.map((e) => ({ at: e.at.toISOString(), text: summarise(e, { attempts: new Map() }) })),
      // No event records the opening of an issue, so a pr-fix is dated at its claim; an unclaimed one adds no line.
      ...claimedFixes(pr, input.fixes ?? null).map((c) => ({ at: c.at, text: `pr-fix #${c.issue} taken` })),
    ]
      .sort((a, b) => a.at.localeCompare(b.at))
      .reverse(),
    previous: null,
  }
}

function draftPage(input: PrPageInput, main: string, personal: string): PrPageView {
  const { project, open } = input
  const error = 'error' in input.draft ? input.draft.error : null
  const tickets: PageTicket[] = ('error' in input.draft ? [] : input.draft).map((t) => ({
    ticket: t.ticket,
    title: t.title,
    fix: false,
  }))
  const empty = error === null && tickets.length === 0
  const buttons: Button[] = []
  if (error === null && !empty) {
    buttons.push({
      kind: 'submit',
      label: 'Submit PR',
      ...(open === null
        ? {}
        : { disabled: `one PR at a time — submit opens once ${prName(open)} is merged or closed` }),
    })
  }
  // A closed or refused PR gave its tickets back (or never held them): *went into* would be false.
  const prev = input.previous?.pr
  const named = empty && prev !== undefined && prev.status !== 'closed' && prev.status !== 'refused' ? prev : null
  const count = named === null ? 0 : named.status === 'requested' ? named.draft.length : slipsOf(named).length
  return {
    kind: 'draft',
    n: null,
    header: {
      name: DRAFT_NAME,
      title: empty ? 'Next PR — nothing in it yet' : 'no title yet — the agent writes one at submit',
      host: null,
    },
    sub: `${personal} → ${main} · ${error === null ? plural(tickets.length, 'ticket', 'tickets') : 'tickets unknown'}`,
    poster: {
      word: 'DRAFT',
      tone: 'draft',
      where: 'ON YOUR MACHINE',
      line: empty
        ? `the next ticket that lands on ${personal} starts this draft · Submit appears once it has one`
        : 'ON YOUR MACHINE',
    },
    previous:
      named === null
        ? null
        : {
            lead: `Nothing is waiting for the next PR. The ${plural(count, 'ticket', 'tickets')} before went into`,
            name: prName(named),
            state: (POSTER[named.status ?? ''] ?? String(named.status)).toLowerCase(),
            href: named.n === null ? null : prPath(project, named.n),
          },
    strip: stripOf(null),
    drawing: drawingOf(null, [], input, main, personal),
    steps: [],
    stepsNote: null,
    tickets,
    summary: null,
    wait: null,
    buttons,
    fixCommand: null,
    doNote: error === null ? null : `The draft could not be read: ${error}`,
    facts: [
      { label: 'Branch', value: personal },
      { label: 'Base', value: main },
      { label: 'Project', value: project },
    ],
    checks: { head: 'no checks ran', rows: [] },
    history: [],
  }
}
