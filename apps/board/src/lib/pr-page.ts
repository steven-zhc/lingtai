/**
 * One PR's page as data (#1320, 0130 §5): `/pr/<project>/<n>`, and `/pr/<project>/next` for the draft.
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
  isOpen,
  prDescription,
  prStepRows,
  prWaitOf,
  reducePr,
  summaryEditTransition,
} from '@lingtai/domain'
import { type Recipe, ceilingOf, remoteOf, ticketSourceOf } from '@lingtai/recipe'

import { summarise } from './history.ts'
import { type Button, DRAFT_NAME, type DraftTicket, WAIT_WORDS, failingRun, prName, slipsOf } from './pr-board.ts'

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
 * issue** — the body is the agent's prompt and the person writes it. On GitHub it is the new-issue form with the label
 * and a title put in; on a project with no GitHub host it is the command, and the line to write.
 */
export function prFixTicketLink(input: {
  readonly project: string
  readonly owner: string | null
  /** Whether the project's tickets are on GitHub. */
  readonly github: boolean
  /** The PR's name as the page draws it: `PR #88`. */
  readonly name: string
}): PrFixLink | null {
  if (!input.github) {
    return {
      kind: 'command',
      command: `lingtai ticket new --project ${input.project}`,
      note: `put ${PR_FIX_LABEL} on its labels: line`,
    }
  }
  if (input.owner === null || input.owner === '') return null
  const title = encodeURIComponent(`pr-fix for ${input.name}: `)
  return {
    kind: 'link',
    href: `https://github.com/${input.owner}/${input.project}/issues/new?labels=${encodeURIComponent(PR_FIX_LABEL)}&title=${title}`,
  }
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
  readonly poster: { readonly word: string; readonly where: string; readonly line: string }
  readonly strip: readonly StripState[]
  readonly drawing: {
    readonly main: string
    readonly personal: string
    readonly prBranch: string | null
    readonly dots: readonly PageTicket[]
    readonly more: number
  }
  readonly steps: readonly PageStep[]
  readonly stepsNote: string | null
  readonly tickets: readonly PageTicket[]
  readonly summary: PageSummary | null
  readonly wait: PageWait | null
  readonly buttons: readonly Button[]
  readonly fixCommand: { readonly command: string; readonly note: string } | null
  readonly doNote: string | null
  readonly facts: readonly { readonly label: string; readonly value: string }[]
  readonly checks: { readonly head: string; readonly rows: readonly PageCheck[] }
  readonly history: readonly { readonly at: string; readonly text: string }[]
}

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
  /** What the PR's stream cost, reported; null is unknown, never `$0`. */
  readonly spend: number | null
  /** What each ticket cost and whether it is still open, as the daemon's description reads them; absent is unknown. */
  readonly facts?: readonly { readonly ticket: string; readonly open: boolean | null; readonly spend: number | null }[]
  /** The two parts of `spend`, for Facts: what the tickets cost and what the PR's own runs cost. Null is unknown. */
  readonly spendParts?: { readonly tickets: number | null; readonly pr: number | null }
  /** The conductor's own step list, in order. */
  readonly stepNames: readonly string[]
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

/** The page's whole text for one PR, or for the draft when `pr` is null. */
export function prPage(input: PrPageInput): PrPageView {
  const { project, recipe, pr, events } = input
  const main = recipe.branch.main
  const personal = recipe.branch.personal ?? main
  const github = githubHosted(recipe)
  if (pr === null) return draftPage(input, main, personal)

  const name = prName(pr)
  const all = slipsOf(pr)
  const dots = all.slice(-3)
  const first = events[0]?.at ?? null
  const lastEvent = events[events.length - 1]?.at ?? null
  const hostOpen = github && pr.host !== null && isOpen(pr)
  const where = hostOpen ? 'ON GITHUB' : ''
  const poster = {
    word: POSTER[pr.status ?? ''] ?? String(pr.status).toUpperCase(),
    where,
    line: [where, lastEvent === null ? '' : age(lastEvent, input.now)].filter((x) => x !== '').join(' · '),
  }

  // Do — only what the state allows.
  const buttons: Button[] = []
  let fixCommand: PrPageView['fixCommand'] = null
  let doNote: string | null = null
  const fix = prFixTicketLink({ project, owner: input.owner, github: ticketsOnGitHub(recipe), name })
  const addFix = () => {
    if (fix === null) return
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
      first === null ? null : `submitted ${day(first)}`,
      plural(all.length, 'ticket', 'tickets'),
      spendNote,
    ]
      .filter((x): x is string => x !== null)
      .join(' · '),
    poster,
    strip: stripOf(pr),
    drawing: { main, personal, prBranch: pr.prBranch, dots, more: Math.max(0, all.length - dots.length) },
    steps: stepRows(pr, events, input.stepNames, recipe),
    stepsNote: pr.status === 'requested' ? 'not started: it is served when a conductor runs' : null,
    tickets: all,
    summary,
    wait: waitView,
    buttons,
    fixCommand,
    doNote,
    facts,
    checks: {
      head:
        pr.checks !== null
          ? `${rows.length} checks`
          : pr.ciSkipped !== null
            ? `no CI step — ${pr.ciSkipped.why}`
            : 'no checks ran',
      rows,
    },
    history: events.map((e) => ({ at: e.at.toISOString(), text: summarise(e, { attempts: new Map() }) })).reverse(),
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
  const dots = tickets.slice(-3)
  const buttons: Button[] = []
  if (error === null) {
    buttons.push({
      kind: 'submit',
      label: 'Submit PR',
      ...(open === null
        ? {}
        : { disabled: `one PR at a time — submit opens once ${prName(open)} is merged or closed` }),
    })
  }
  return {
    kind: 'draft',
    n: null,
    header: { name: DRAFT_NAME, title: 'no title yet — the agent writes one at submit', host: null },
    sub: `${personal} → ${main} · ${error === null ? plural(tickets.length, 'ticket', 'tickets') : 'tickets unknown'}`,
    poster: { word: 'DRAFT', where: 'ON YOUR MACHINE', line: 'ON YOUR MACHINE' },
    strip: stripOf(null),
    drawing: { main, personal, prBranch: null, dots, more: Math.max(0, tickets.length - dots.length) },
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
