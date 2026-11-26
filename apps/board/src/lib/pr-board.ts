/**
 * The PRs board as data (#1319, 0130 §5): five columns, each PR a card drawn as a branch.
 *
 * Pure: it imports types and the domain's pure folds, never a store, so a test reads every word the page draws
 * without rendering. The page and `lib/prs.ts` (which reads the log) share it. The step names are handed in — they
 * are the conductor's list, and the conductor stays out of this file so a client graph may import it.
 */
import { type PayloadOf, type PrState, isOpen, openAmong, prStepRows, prWaitOf } from '@lingtai/domain'
import { type Recipe, callForPr, ceilingOf, modeOf, remoteOf } from '@lingtai/recipe'

type WaitReason = PayloadOf<'PrWaiting'>['reason']

/** One PR as read: its state, or why that stream could not be. */
export type PrRead = { readonly n: number; readonly pr: PrState } | { readonly n: number; readonly error: string }

export interface DraftTicket {
  readonly ticket: string
  readonly mergeCommit: string
  readonly title: string
}

/** Whether a conductor holds the lock: `unknown` when that could not be read, never taken as `none`. */
export type Daemon = 'running' | 'none' | 'unknown'

/** The clock time of an instant, UTC as the PR page prints it. */
export const clock = (d: Date): string => d.toISOString().slice(11, 16)

export type Tone = 'draft' | 'progress' | 'queued' | 'waiting' | 'review' | 'merged'

/** The board's five columns, once: the view and the loading skeleton both read this, so a rename moves both (#1419). */
export const PR_COLUMNS = [
  { id: 'draft', title: 'Draft', tone: 'draft' },
  { id: 'progress', title: 'In progress', tone: 'progress' },
  { id: 'waiting', title: 'Waiting on you', tone: 'waiting' },
  { id: 'review', title: 'In review', tone: 'review' },
  { id: 'merged', title: 'Merged', tone: 'merged' },
] as const satisfies readonly { readonly id: string; readonly title: string; readonly tone: Tone }[]

const [COL_DRAFT, COL_PROGRESS, COL_WAITING, COL_REVIEW, COL_MERGED] = PR_COLUMNS

export interface Slip {
  readonly ticket: string
  readonly title: string
  readonly fix: boolean
}

export interface Chip {
  readonly step: string
  readonly text: string
  readonly status: 'done' | 'running' | 'waiting' | 'pending' | 'skipped'
}

export type ButtonKind = 'submit' | 'rounds' | 'retry' | 'link' | 'command'

/** *New pr-fix ticket* where the tickets are: a link to the new-issue form, or the command to run for a local one. */
export type FixTicket =
  | { readonly kind: 'link'; readonly href: string }
  | { readonly kind: 'command'; readonly command: string; readonly note: string }

export interface Button {
  readonly kind: ButtonKind
  readonly label: string
  /** For `link`. */
  readonly href?: string
  /** For `command`: what to run, drawn as code, and the line that goes with it. Pressing nothing: a person types it. */
  readonly command?: string
  readonly note?: string
  /** The sentence that says why it cannot be pressed; set means disabled. */
  readonly disabled?: string
  /** For `rounds`: what the grant is about, as the page showed it. */
  readonly grant?: { readonly merging: 'main' | 'back' | 'outside'; readonly commit: string }
}

export interface CardView {
  readonly failed?: false
  readonly key: string
  readonly n: number | null
  readonly tone: Tone
  readonly name: string
  readonly pill: string | null
  /** *14 tickets*, shown in the header only when the card holds more than three. */
  readonly count: string | null
  readonly href: string | null
  readonly sub: readonly string[]
  readonly slips: readonly Slip[]
  /** Tickets past the three drawn. */
  readonly more: number
  readonly chips: readonly Chip[]
  /** Facts under the chips: the conflict's sides, rounds, spend. */
  readonly meta: readonly string[]
  /** The by-hand commands, for a conflict. */
  readonly byHand: readonly string[]
  readonly buttons: readonly Button[]
}

export interface FailedCard {
  readonly failed: true
  readonly key: string
  readonly n: number
  readonly text: string
}

export interface ColumnView {
  readonly id: 'draft' | 'progress' | 'waiting' | 'review' | 'merged'
  readonly title: string
  readonly tone: Tone
  readonly count: number
  readonly cards: readonly (CardView | FailedCard)[]
  readonly empty: string
  /** Set when a PR stream could not be read and may belong here: the count is a floor and the empty line says so. */
  readonly unread?: boolean
  readonly note: string | null
}

export interface PrBoardView {
  /** The `✓ PR n submitted` line, drawn from the log while the latest PR is `requested`; null otherwise. */
  readonly submitted: {
    readonly n: number
    readonly at: string | null
    readonly href: string
    /** Whether a daemon is known to be running, which decides the sentence after the time. */
    readonly daemon: Daemon
  } | null
  readonly strip: { readonly branches: string; readonly notInPr: string; readonly mainNote: string }
  readonly columns: readonly ColumnView[]
  /** PRs waiting on the person: what `PRs` on the place line counts. */
  readonly waiting: number
}

/** How many slips a card draws. */
export const SLIPS_SHOWN = 3
/** Merged PRs the Merged column shows: the most recent, and nothing older is read (#1422). */
export const MERGED_SHOWN = 5

/** What a person reads for each reason a PR waits. Typed on the enum, so a new reason is a type error here. */
export const WAIT_WORDS: Record<WaitReason, string> = {
  denied: 'push denied',
  'branch-moved': 'branch moved',
  'several-open': 'several pull requests open',
  'draft-unsupported': 'drafts unsupported',
  'ci-red': 'CI failed',
  'ci-none-started': 'CI never started',
  'ci-timeout': 'CI timed out',
  'sync-conflict': 'conflicts with main',
  'sync-red': 'build red',
  'sync-unknown': 'sync could not tell',
  'sync-rewritten': 'branch rewritten',
  'sync-locked': 'conflicts, agent locked out',
  'outside-conflict': 'conflicts with commits others pushed',
  'outside-red': 'build red after merging commits others pushed',
}

const CI_WAITS: ReadonlySet<WaitReason> = new Set<WaitReason>(['ci-red', 'ci-none-started', 'ci-timeout'])

/** `PR #<host number>` once the code host has one, else `PR <n>`: Lingtai's own id, never with a `#`. */
export const prName = (pr: Pick<PrState, 'host' | 'n'>): string =>
  pr.host !== null ? `PR #${pr.host.number}` : `PR ${pr.n ?? '?'}`

/**
 * The PR that holds `ticket` by the store's own rules (a closed PR gives its tickets back; a merge holds what its
 * commit held): an open PR, else a merged one that held it, else a merge whose commit is not yet known exactly.
 */
export function prHolding(
  ticket: string,
  prs: readonly PrState[],
): { readonly kind: 'open' | 'merged' | 'merging'; readonly pr: PrState } | null {
  const holds = (p: PrState) =>
    p.tickets.some((t) => t.ticket === ticket) || p.fixesLanded.some((f) => f.ticket === ticket)
  const open = prs.find((p) => isOpen(p) && holds(p))
  if (open !== undefined) return { kind: 'open', pr: open }
  const merged = prs.find((p) => p.status === 'merged' && p.mergedTickets.includes(ticket))
  if (merged !== undefined) return { kind: 'merged', pr: merged }
  const merging = prs.find((p) => p.status === 'merged' && !p.mergedExact && holds(p))
  if (merging !== undefined) return { kind: 'merging', pr: merging }
  return null
}

export const DRAFT_NAME = 'Next PR'

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/**
 * One slip per ticket the PR holds. `PrFixLanded` puts a pr-fix into `tickets` *and* `fixesLanded`, so `tickets` is the
 * list and `fixesLanded` only says which of them are fixes. `only` narrows it, as to the tickets a merge carried.
 */
export const slipsOf = (pr: PrState, only?: ReadonlySet<string>): Slip[] => {
  const fixes = new Map(pr.fixesLanded.map((f) => [f.ticket, f.title]))
  return pr.tickets
    .filter((t) => only === undefined || only.has(t.ticket))
    .map((t) => ({
      ticket: t.ticket,
      title: t.title === '' ? (fixes.get(t.ticket) ?? '') : t.title,
      fix: fixes.has(t.ticket),
    }))
}

/** The newest three, then how many more. Newest is last: tickets are held in the order they landed. */
const shown = (all: readonly Slip[]): { slips: Slip[]; more: number } => ({
  slips: all.slice(-SLIPS_SHOWN),
  more: Math.max(0, all.length - SLIPS_SHOWN),
})

const usd = (n: number | null): string => (n === null ? 'unknown' : `$${n.toFixed(2)}`)

/** The failing check's link, picked as `lingtai pr` picks it. */
export function failingRun(pr: PrState): string | null {
  const read = pr.checks
  if (read === null) return null
  const flagged = read.checks.some((c) => c.failing === true)
  const failing = read.checks.filter((c) =>
    flagged ? c.failing === true : !['success', 'neutral', 'skipped', 'queued', 'running'].includes(c.state),
  )
  return failing.find((c) => c.url !== '')?.url ?? null
}

/** Why nothing follows a PR whose remote is not GitHub: the one sentence the page's rows and the card's chip share. */
export const UNFOLLOWED_WHY = 'the remote is not GitHub, so nothing follows the PR there'

/**
 * A PR opened on a remote that is not GitHub (`PrOpened { host: 'none' }`): the PR went to In review unfollowed (0131),
 * so `ci` and `ready` never ran and are the person's rather than stopped. Read from this pass's own record, never from
 * `host`: `PrInProgress` does not reset `host`, so an earlier GitHub pass's draft would hide a later pass that opened
 * with `host: 'none'`. `PrOpened` is the only event that moves a PR to In review; `host: 'none'` records `open` there
 * and a GitHub one records `ready`, so In review with `open` and no `ready` in `steps` (the current pass only) is it.
 */
export function unfollowedRemote(pr: PrState): boolean {
  return (
    pr.status === 'in-review' && pr.steps.some((s) => s.step === 'open') && !pr.steps.some((s) => s.step === 'ready')
  )
}

function chipsOf(pr: PrState, stepNames: readonly string[]): Chip[] {
  const chips: Chip[] = []
  const rows = prStepRows(stepNames, pr)
  // The first row that is neither done nor waiting is the one running now while the PR is in progress.
  const running = pr.status === 'in-progress' ? rows.find((r) => r.status === 'pending')?.step : undefined
  for (const row of rows) {
    if (row.step === 'topup' && row.status === 'pending') continue
    let status: Chip['status'] = row.status === 'done' ? 'done' : row.status === 'waiting' ? 'waiting' : 'pending'
    if (row.step === running) status = 'running'
    let text = `${row.step} ${status === 'done' ? '✓' : status === 'waiting' ? '✕' : status === 'running' ? '…' : '·'}`
    if (unfollowedRemote(pr) && (row.step === 'ci' || row.step === 'ready') && row.status === 'pending') {
      chips.push(
        row.step === 'ci'
          ? { step: row.step, text: 'no CI', status: 'done' }
          : { step: row.step, text: 'ready — yours', status: 'skipped' },
      )
      continue
    }
    if (row.step === 'ci') {
      if (pr.ciSkipped !== null && pr.checks === null) {
        text = 'no CI'
        status = 'done'
      } else if (pr.checks !== null) {
        const ok = pr.checks.checks.filter((c) => ['success', 'neutral', 'skipped'].includes(c.state)).length
        text =
          pr.checks.verdict === 'green'
            ? `CI ✓ ${ok}/${pr.checks.checks.length}`
            : `CI ✕ ${pr.checks.checks
                .filter((c) => c.failing === true)
                .map((c) => c.name)
                .join(', ')}`.trimEnd()
      }
    }
    if (row.step === 'summary' && status === 'done' && pr.summaryNotWritten !== null) {
      text = 'summary — skipped'
      status = 'skipped'
    }
    if (row.step === 'sync' && status === 'done' && pr.resolutions.length > 0) text = 'sync ✓ conflicts resolved'
    chips.push({ step: row.step, text, status })
  }
  return chips
}

export interface PrBoardInput {
  readonly project: string
  readonly recipe: Recipe
  readonly prs: readonly PrRead[]
  /** The draft, or why it could not be read: never an empty draft for a read that failed. */
  readonly draft: readonly DraftTicket[] | { readonly error: string }
  /** The conductor's own step list, in order. */
  readonly stepNames: readonly string[]
  /** Reported spend on each PR's stream, by `n`; absent is unknown. */
  readonly spend: ReadonlyMap<number, number>
  /** Whether a daemon holds the conductor lock, for a submitted-and-unserved PR. */
  readonly daemon: Daemon
  /** The viewing actor, so a queued card says *by you*. */
  readonly viewer: string
  /** Where *New pr-fix ticket* goes, or null where the repository has no owner on record. */
  readonly newFixHref: FixTicket | null
  /** The same, for one PR: its name is in the prefilled title. Absent, `newFixHref` serves every PR. */
  readonly newFixFor?: (pr: PrState) => FixTicket | null
}

const href = (project: string, n: number | 'next'): string => `/pr/${encodeURIComponent(project)}/${n}`

export function prBoard(input: PrBoardInput): PrBoardView {
  const { recipe, project } = input
  const main = recipe.branch.main
  const personal = recipe.branch.personal ?? main
  const good = input.prs.flatMap((r) => ('pr' in r ? [r] : []))
  const latest = good[good.length - 1]?.pr ?? null
  const open = openAmong(good.map((r) => r.pr))
  const call = callForPr(recipe)

  const unreadPrs = input.prs.flatMap((r) => ('pr' in r ? [] : [r.n]))
  const unread = unreadPrs.length > 0
  const unreadEmpty = `PR ${unreadPrs.join(', ')} could not be read, so this may not be empty`
  const draftTickets: readonly DraftTicket[] = 'error' in input.draft ? [] : input.draft
  const draftError = 'error' in input.draft ? input.draft.error : null

  const cardOf = (pr: PrState, tone: Tone, extra: Partial<CardView> = {}, only?: ReadonlySet<string>): CardView => {
    const all = slipsOf(pr, only)
    const { slips, more } = shown(all)
    const n = pr.n ?? 0
    return {
      key: `pr-${n}`,
      n,
      tone,
      name: prName(pr),
      pill: null,
      count: all.length > SLIPS_SHOWN ? plural(all.length, 'ticket', 'tickets') : null,
      href: href(project, n),
      sub: [],
      slips,
      more,
      chips: [],
      meta: [],
      byHand: [],
      buttons: [],
      ...extra,
      // A summary that was skipped says why on every card the PR has, never a blank and never a ✓.
      ...(pr.summaryNotWritten === null
        ? {}
        : { meta: [`no summary: ${pr.summaryNotWritten}`, ...(extra.meta ?? [])] }),
    }
  }

  // ── Draft ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const draftCards: (CardView | FailedCard)[] = []
  const requested = latest !== null && latest.status === 'requested' ? latest : null
  const refused = latest !== null && latest.status === 'refused' ? latest : null
  if (draftError !== null) {
    draftCards.push({ failed: true, key: 'draft', n: 0, text: `The draft could not be read: ${draftError}` })
  } else if (requested === null && draftTickets.length > 0) {
    const all = draftTickets.map((t) => ({ ticket: t.ticket, title: t.title, fix: false }))
    const { slips, more } = shown(all)
    const sub: string[] = []
    const buttons: Button[] = []
    sub.push(
      open !== null
        ? `landed on ${personal} since ${prName(open)} was submitted`
        : `landed on ${personal}, not yet on ${main}`,
    )
    if (refused?.refusal != null) sub.push(`the last submit was refused: ${refused.refusal.detail}`)
    buttons.push({
      kind: 'submit',
      label: 'Submit PR',
      ...(open === null
        ? {}
        : { disabled: `one PR at a time — submit opens once ${prName(open)} is merged or closed` }),
    })
    if (open === null) {
      sub.push(
        `submit: brings ${main} in, builds, pushes, runs CI on a GitHub draft PR, writes the summary (≤ ${call.turns} turns, ${Math.round(call.wallMs / 60_000)} min)`,
      )
    }
    draftCards.push({
      key: 'draft',
      n: null,
      tone: 'draft',
      name: DRAFT_NAME,
      pill: null,
      count: plural(all.length, 'ticket', 'tickets'),
      href: href(project, 'next'),
      sub,
      slips,
      more,
      chips: [],
      meta: [],
      byHand: [],
      buttons,
    })
  }

  // ── The PRs, by state ───────────────────────────────────────────────────────────────────────────────────────────
  const progress: (CardView | FailedCard)[] = []
  const waiting: (CardView | FailedCard)[] = []
  const review: (CardView | FailedCard)[] = []
  const mergedAll: (CardView | FailedCard)[] = []
  let waitingCount = 0

  // Newest first within a column: a number is a position, not a string.
  for (const read of [...input.prs].sort((a, b) => b.n - a.n)) {
    if (!('pr' in read)) {
      // Unreadable: it belongs to no column we can name, so the failure is drawn where the open work is.
      progress.push({
        failed: true,
        key: `pr-${read.n}`,
        n: read.n,
        text: `PR ${read.n} could not be read: ${read.error}`,
      })
      continue
    }
    const pr = read.pr
    if (pr.status === 'requested') {
      // The tickets of a queued PR are the draft's: it has none of its own until the freeze (ADR 0131 §1).
      const all = draftTickets.map((t) => ({ ticket: t.ticket, title: t.title, fix: false }))
      const { slips, more } = shown(all)
      const by =
        pr.requestedBy === null
          ? ''
          : pr.requestedBy === input.viewer
            ? ' by you'
            : ` by ${pr.requestedBy.replace(/^human:/, '')}`
      const submittedAt = pr.requestedAt === null ? '' : ` ${clock(pr.requestedAt)}`
      const line = `submitted${submittedAt}${by}${input.daemon === 'running' ? ' · waiting for the daemon to start it' : ''}`
      const buttons: Button[] = []
      if (input.daemon === 'none') {
        buttons.push({
          kind: 'command',
          label: 'No daemon is running, so nothing will start it. Start one',
          command: 'lingtai start',
          note: 'it picks the PR up when it next looks for work',
        })
      } else if (input.daemon === 'unknown') {
        buttons.push({
          kind: 'command',
          label: 'could not tell whether a daemon is running',
          command: 'lingtai doctor',
          note: 'says',
        })
      }
      progress.push(
        cardOf(pr, 'queued', {
          pill: 'queued',
          sub: [line],
          chips: chipsOf(pr, input.stepNames),
          buttons,
          ...(draftError !== null
            ? { slips: [], more: 0, count: null, meta: ['tickets: unknown'] }
            : { slips, more, count: all.length > SLIPS_SHOWN ? plural(all.length, 'ticket', 'tickets') : null }),
        }),
      )
    } else if (pr.status === 'in-progress') {
      const fix = pr.fixesLanded.length > 0 && pr.steps.length === 0
      progress.push(
        cardOf(pr, 'progress', {
          name: fix ? `${prName(pr)} · pr-fix` : prName(pr),
          pill: 'in progress',
          sub: [
            [
              pr.requestedAt === null ? null : `submitted ${clock(pr.requestedAt)}`,
              pr.startedAt === null ? null : `started ${clock(pr.startedAt)}`,
              pr.frozenSha === null ? null : `frozen at ${pr.frozenSha.slice(0, 7)}`,
            ]
              .filter((x): x is string => x !== null)
              .join(' · '),
            `then merged back once into ${personal}`,
            ...(pr.host !== null ? [] : ['not yet a GitHub draft']),
          ].filter((x) => x !== ''),
          chips: chipsOf(pr, input.stepNames),
        }),
      )
    } else if (pr.status === 'waiting') {
      waitingCount++
      waiting.push(waitingCard(pr))
    } else if (pr.status === 'in-review') {
      const ci = pr.ciSkipped !== null && pr.checks === null ? 'no CI' : pr.checks === null ? null : ciText(pr)
      review.push(
        cardOf(pr, 'review', {
          pill: 'in review',
          sub: [`${pr.prBranch ?? '?'} → ${pr.main ?? main}`],
          meta: ci === null ? [] : [ci],
        }),
      )
    } else if (pr.status === 'merged') {
      // What the merged head held, not what the PR holds now: a pr-fix that landed on a later head is not in the merge
      // and is not closed. An unrecorded head makes the count a floor.
      const carried = new Set(pr.mergedTickets)
      const closed = carried.size
      mergedAll.push(
        cardOf(
          pr,
          'merged',
          {
            pill: 'merged',
            sub: [
              `${pr.ended === null ? '' : `${pr.ended.at.toISOString().slice(5, 10)} · `}${pr.mergedExact ? '' : 'at least '}${plural(closed, 'ticket', 'tickets')} closed`,
            ],
          },
          carried,
        ),
      )
    }
  }

  function waitingCard(pr: PrState): CardView | FailedCard {
    const view = prWaitOf(pr, {
      project,
      checkout: localCheckout(recipe),
      conflictResolutions: ceilingOf(recipe).attempt.conflictResolutions,
    })
    const n = pr.n ?? 0
    const stillDraft =
      pr.host !== null && !pr.markedReady ? ['still a GitHub draft — nobody was asked to review it'] : []
    if (view === null) {
      return cardOf(pr, 'waiting', { pill: 'waiting', sub: ['waiting on you'] })
    }
    const header = `${prName(pr)} · ${WAIT_WORDS[view.reason]}`
    if (view.kind === 'conflict') {
      const spent = input.spend.get(n) ?? null
      const rounds =
        view.roundsUsed === null || view.roundsAllowed === null
          ? 'rounds: unknown'
          : `${view.roundsUsed} of ${view.roundsAllowed} rounds spent`
      const buttons: Button[] = []
      if (
        (view.reason === 'sync-conflict' || view.reason === 'outside-conflict' || view.reason === 'outside-red') &&
        view.commit !== null &&
        view.merging !== null
      ) {
        buttons.push({
          kind: 'rounds',
          label: 'Give the agent 3 more rounds',
          grant: { merging: view.merging, commit: view.commit },
        })
      }
      buttons.push({ kind: 'retry', label: 'I resolved it — check again' })
      return cardOf(pr, 'waiting', {
        name: header,
        pill: 'waiting',
        sub: [
          ...stillDraft,
          `at ${view.merging === 'back' ? 'merge back' : 'submit'} · ${
            view.paths === null ? 'files unknown' : view.paths.join(', ')
          } · ${rounds} · ${usd(spent)}`,
        ],
        meta: [
          view.ours === null
            ? 'ours: unknown'
            : `ours ${view.ours.map((o) => `#${o.issue} ${o.title}`).join(', ') || 'none'}`,
          view.theirs === null
            ? 'theirs: unknown'
            : `theirs ${view.theirs.map((t) => `${t.sha.slice(0, 7)} ${t.author}`).join(', ') || 'none'}`,
          ...(view.lastRefusal === null ? [] : [`last refusal: ${view.lastRefusal.step}`]),
        ],
        byHand: view.commands,
        buttons,
      })
    }
    const buttons: Button[] = []
    if (CI_WAITS.has(view.reason)) {
      const run = failingRun(pr)
      if (run !== null) buttons.push({ kind: 'link', label: 'Open the run ↗', href: run })
      const fix = input.newFixFor === undefined ? input.newFixHref : input.newFixFor(pr)
      if (fix !== null) {
        buttons.push(
          fix.kind === 'link'
            ? { kind: 'link', label: 'New pr-fix ticket', href: fix.href }
            : { kind: 'command', label: 'New pr-fix ticket', command: fix.command, note: fix.note },
        )
      }
    }
    // Only the waits a retry ends have a way out here; the others show what happened and nothing to press.
    if (view.commands.length > 0) buttons.push({ kind: 'retry', label: 'Check again' })
    return cardOf(pr, 'waiting', {
      name: header,
      pill: 'waiting',
      sub: [...stillDraft, view.detail],
      chips: chipsOf(pr, input.stepNames),
      buttons,
    })
  }

  const notInPr =
    requested !== null
      ? `PR ${requested.n ?? 0} queued`
      : draftError !== null
        ? 'tickets not in a PR: unknown'
        : open !== null && draftTickets.length === 0
          ? `${prName(open)} ${open.status === 'in-progress' ? 'in progress' : open.status === 'waiting' ? 'waiting on you' : 'in review'}`
          : `${plural(draftTickets.length, 'ticket', 'tickets')} in Draft PR`

  return {
    submitted:
      requested === null
        ? null
        : {
            n: requested.n ?? 0,
            at: requested.requestedAt === null ? null : clock(requested.requestedAt),
            href: href(project, requested.n ?? 0),
            daemon: input.daemon,
          },
    strip: {
      branches: `${personal} → ${main}`,
      notInPr,
      mainNote: `${main} is brought in at the next submit`,
    },
    waiting: waitingCount,
    columns: [
      {
        ...COL_DRAFT,
        count: draftCards.length === 0 || draftError !== null ? 0 : draftTickets.length,
        cards: draftCards,
        empty:
          requested !== null
            ? `Nothing has landed since ${prName(requested)} was submitted. Tickets that land now join ${prName(requested)} until it starts, then the next PR.`
            : open !== null && draftError === null
              ? `Nothing has landed since ${prName(open)} started.`
              : 'Lingtai keeps taking tickets; they gather here.',
        note: null,
      },
      {
        ...COL_PROGRESS,
        count: progress.length,
        cards: progress,
        empty: 'No PR is being built.',
        note: 'The order every PR goes through: bring main in · build · conflict agent · push · CI · summary',
      },
      {
        ...COL_WAITING,
        count: waiting.length,
        cards: waiting,
        empty: unread ? unreadEmpty : 'Nothing is waiting on you.',
        unread,
        note: null,
      },
      {
        ...COL_REVIEW,
        count: review.length,
        cards: review,
        empty: unread ? unreadEmpty : 'No PR is in review.',
        unread,
        note: null,
      },
      {
        ...COL_MERGED,
        count: Math.min(mergedAll.length, MERGED_SHOWN),
        cards: mergedAll.slice(0, MERGED_SHOWN),
        empty: unread ? unreadEmpty : 'Nothing has merged yet.',
        unread,
        note: null,
      },
    ],
  }
}

function ciText(pr: PrState): string | null {
  if (pr.checks === null) return null
  const ok = pr.checks.checks.filter((c) => ['success', 'neutral', 'skipped'].includes(c.state)).length
  return `CI ${pr.checks.verdict === 'green' ? '✓' : '✕'} ${ok}/${pr.checks.checks.length}`
}

/** A local project's checkout is `repo.remote`, a path: the by-hand commands then name it. */
function localCheckout(recipe: Recipe): string | null {
  const remote = remoteOf(recipe)
  return remote !== null && (remote.startsWith('/') || remote.startsWith('~')) ? remote : null
}

/** The sentence a solo project's PR page is. */
export const soloSentence = (project: string, recipe: Recipe): string =>
  `${project} is a solo project: each ticket lands on ${recipe.branch.main} itself, so it has no PRs`

export const isTeam = (recipe: Recipe): boolean => modeOf(recipe) === 'team'
