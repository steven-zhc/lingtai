/**
 * The PR aggregate: `pr-{project}-{n}`, one pull request from a team project's `branch.personal` towards
 * `branch.main` (0130 §5).
 *
 * `requested → in-progress ⇄ waiting → in-review`, with `refused` terminal. Later tickets append what reaches
 * `in-review` and what ends a PR (merged, closed); this one owns the first half. Its one owner is
 * `@lingtai/project`'s `pr.ts` (0129 §1); the pure rules sit here beside the reduce, as the Project's do.
 *
 * **Evidence names the commit it proves**: every step outcome carries `headSha`, and the events refuse to decode
 * without one.
 */
import type { Envelope, ToAppend } from './envelope.ts'
import type { PayloadOf } from './events.ts'
import { parsePrStream } from './streams.ts'

export type PrStatus = 'requested' | 'in-progress' | 'waiting' | 'in-review' | 'refused' | 'merged' | 'closed'

/** One step's outcome as recorded: the step, and the commit it ran on. */
export interface PrStepRecord {
  readonly step: string
  readonly headSha: string
}

export interface PrState {
  /** Null on a stream with no events. */
  status: PrStatus | null
  project: string | null
  n: number | null
  requestedBy: string | null
  /** `branch.personal` and `branch.main` as they were at the freeze. */
  branch: string | null
  main: string | null
  prBranch: string | null
  frozenSha: string | null
  /**
   * The commit In progress means to push: `frozenSha` here. A sync with `main` or a retry moves it (#1312, #1314).
   */
  target: string | null
  tickets: PayloadOf<'PrInProgress'>['tickets']
  /**
   * The commit last put on the PR branch (`PrPushed`). **`PrInProgress` does not reset it**: a pr-fix pass starts its
   * steps again, and its push is a fast-forward from here.
   */
  lastPushed: string | null
  /** The draft pull request on GitHub (`PrDraftOpened`); not reset by `PrInProgress`, so a pass never opens a second. */
  host: { readonly number: number; readonly nodeId: string; readonly url: string } | null
  /** When the PR branch was last pushed (`PrPushed`'s own time): the 30-minute none-started rule counts from here. */
  pushedAt: Date | null
  /**
   * The latest verdict recorded on a head (`PrChecked`). **Not a step**: a red one must not make a retry skip `ci`; it
   * only keeps the same verdict on the same head from being appended twice.
   */
  checked: { readonly headSha: string; readonly verdict: 'green' | 'red' } | null
  /** The latest `PrChecked`, whole: what the PR page and `lingtai pr` draw the CI line and the failing checks from. */
  checks: PayloadOf<'PrChecked'> | null
  /** The head CI is following (`PrCiFollowing`): reset by `PrInProgress`, moved when the pull request's head moves. */
  following: string | null
  /** The latest `PrCiSkipped`: *no CI step*, and why. */
  ciSkipped: PayloadOf<'PrCiSkipped'> | null
  /** The steps recorded since the latest `PrInProgress`: a later pass through In progress starts empty. */
  steps: readonly PrStepRecord[]
  /** The last wait, while the PR is waiting. */
  wait: PayloadOf<'PrWaiting'> | null
  refusal: PayloadOf<'PrSubmitRefused'> | null
  /** How the PR ended, once it has (`PrMerged`, `PrClosed`); `how` is null for a close. `seq` is the ending event's. */
  ended: {
    readonly how: 'host' | 'git' | null
    readonly headSha: string
    readonly mergeSha: string | null
    readonly seq: bigint
    readonly at: Date
  } | null
  version: number
  lastSeq: bigint | null
}

export const emptyPr: PrState = {
  status: null,
  project: null,
  n: null,
  requestedBy: null,
  branch: null,
  main: null,
  prBranch: null,
  frozenSha: null,
  target: null,
  tickets: [],
  lastPushed: null,
  host: null,
  pushedAt: null,
  checked: null,
  checks: null,
  ciSkipped: null,
  following: null,
  steps: [],
  wait: null,
  refusal: null,
  ended: null,
  version: 0,
  lastSeq: null,
}

/** A step recorded once; a step that finished after a wait is the person's answer taking effect. */
function withStep(state: PrState, record: PrStepRecord): PrState {
  const steps = state.steps.some((r) => r.step === record.step) ? state.steps : [...state.steps, record]
  return { ...state, status: state.status === 'waiting' ? 'in-progress' : state.status, steps, wait: null }
}

export function reducePrEvent(state: PrState, event: Envelope): PrState {
  const at = { version: event.version, lastSeq: event.seq }
  switch (event.type) {
    case 'PrSubmitRequested': {
      const d = event.data as PayloadOf<'PrSubmitRequested'>
      const named = parsePrStream(event.streamId)
      return {
        ...state,
        ...at,
        status: 'requested',
        project: named?.project ?? state.project,
        n: named?.n ?? state.n,
        requestedBy: d.by,
      }
    }
    case 'PrSubmitRefused': {
      const d = event.data as PayloadOf<'PrSubmitRefused'>
      return { ...state, ...at, status: 'refused', refusal: d }
    }
    case 'PrInProgress': {
      const d = event.data as PayloadOf<'PrInProgress'>
      return {
        ...state,
        ...at,
        status: 'in-progress',
        branch: d.branch,
        main: d.main,
        prBranch: d.prBranch,
        frozenSha: d.frozenSha,
        target: d.frozenSha,
        tickets: d.tickets,
        steps: [],
        wait: null,
        following: null,
      }
    }
    case 'PrCiFollowing': {
      const d = event.data as PayloadOf<'PrCiFollowing'>
      // The head moved: its checks are read afresh, so the verdict and the `ci` step's record are of the old one. The
      // 30-minute rule counts from when the new head was first followed, unless it is the head Lingtai pushed.
      return {
        ...state,
        ...at,
        steps: state.steps.filter((s) => s.step !== 'ci'),
        following: d.headSha,
        checked: null,
        checks: null,
        ciSkipped: null,
        pushedAt: d.headSha === state.lastPushed ? state.pushedAt : event.at,
        status: state.status === 'waiting' ? 'in-progress' : state.status,
        wait: null,
      }
    }
    case 'PrStepDone': {
      const d = event.data as PayloadOf<'PrStepDone'>
      const steps = state.steps.some((s) => s.step === d.step) ? state.steps : [...state.steps, d]
      // A step that finished after a wait is the person's answer taking effect: the PR is walking again.
      return { ...state, ...at, status: state.status === 'waiting' ? 'in-progress' : state.status, steps, wait: null }
    }
    case 'PrPushed': {
      const d = event.data as PayloadOf<'PrPushed'>
      return {
        ...withStep(state, { step: 'push', headSha: d.headSha }),
        ...at,
        lastPushed: d.headSha,
        pushedAt: event.at,
      }
    }
    case 'PrDraftOpened': {
      const d = event.data as PayloadOf<'PrDraftOpened'>
      return {
        ...withStep(state, { step: 'open', headSha: state.target ?? state.frozenSha ?? '' }),
        ...at,
        host: { number: d.number, nodeId: d.nodeId, url: d.url },
      }
    }
    case 'PrCiSkipped': {
      const d = event.data as PayloadOf<'PrCiSkipped'>
      return { ...withStep(state, { step: 'ci', headSha: d.headSha }), ...at, ciSkipped: d }
    }
    case 'PrChecked': {
      const d = event.data as PayloadOf<'PrChecked'>
      const checked = { headSha: d.headSha, verdict: d.verdict }
      // Green is the `ci` step's record; red is a fact about the head and records no step.
      if (d.verdict === 'red') return { ...state, ...at, checked, checks: d }
      return { ...withStep(state, { step: 'ci', headSha: d.headSha }), ...at, checked, checks: d }
    }
    case 'PrOpened': {
      const d = event.data as PayloadOf<'PrOpened'>
      const stepped = d.host === 'none' ? withStep(state, { step: 'open', headSha: state.target ?? '' }) : state
      return { ...stepped, ...at, status: 'in-review', wait: null }
    }
    case 'PrMerged': {
      const d = event.data as PayloadOf<'PrMerged'>
      const ended = { how: d.how, headSha: d.headSha, mergeSha: d.mergeSha, seq: event.seq, at: event.at }
      return { ...state, ...at, status: 'merged', wait: null, ended }
    }
    case 'PrClosed': {
      const d = event.data as PayloadOf<'PrClosed'>
      const ended = { how: null, headSha: d.headSha, mergeSha: null, seq: event.seq, at: event.at }
      return { ...state, ...at, status: 'closed', wait: null, ended }
    }
    case 'PrWaiting': {
      const d = event.data as PayloadOf<'PrWaiting'>
      return { ...state, ...at, status: 'waiting', wait: d }
    }
    default:
      return { ...state, ...at }
  }
}

export function reducePr(events: readonly Envelope[]): PrState {
  return events.reduce(reducePrEvent, emptyPr)
}

/** A PR that has not ended: requested, in progress, waiting on a person, or in review. */
export function isOpen(state: PrState | null): boolean {
  return (
    state !== null &&
    (state.status === 'requested' ||
      state.status === 'in-progress' ||
      state.status === 'waiting' ||
      state.status === 'in-review')
  )
}

/** What a PR is called in a sentence. */
export function prName(project: string, n: number): string {
  return `PR ${n} of ${project}`
}

export type SubmitRefusal = { kind: 'refused'; reason: 'solo' | 'open-pr'; detail: string }

/**
 * Whether a Submit may start a PR: refused `solo` where the project lands on `branch.main` itself, and `open-pr`
 * — naming it — while the project's latest PR is open. The new PR's number is the caller's, one past the highest.
 */
export function requestSubmit(
  previous: PrState | null,
  mode: 'solo' | 'team',
  project: string,
  by: string,
): { kind: 'request'; event: ToAppend<PayloadOf<'PrSubmitRequested'>> } | SubmitRefusal {
  if (mode === 'solo') {
    return { kind: 'refused', reason: 'solo', detail: `${project} lands on its main branch itself; there is no PR` }
  }
  if (previous !== null && isOpen(previous) && previous.n !== null) {
    return {
      kind: 'refused',
      reason: 'open-pr',
      detail: `${prName(project, previous.n)} is open (${previous.status}); submit again once it is merged or closed`,
    }
  }
  return { kind: 'request', event: { type: 'PrSubmitRequested', actor: by, data: { by } } }
}

const inProgress = (data: PayloadOf<'PrInProgress'>): ToAppend<PayloadOf<'PrInProgress'>> => ({
  type: 'PrInProgress',
  actor: 'conductor',
  data,
})

/** The freeze: only a `requested` PR is frozen; anything else decides nothing. */
export function freezeTransition(
  state: PrState,
  frozen: { branch: string; main: string; frozenSha: string; tickets: PayloadOf<'PrInProgress'>['tickets'] },
): ToAppend<PayloadOf<'PrInProgress'>> | null {
  if (state.status !== 'requested' || state.n === null) return null
  return inProgress({
    because: 'submit',
    branch: frozen.branch,
    main: frozen.main,
    frozenSha: frozen.frozenSha,
    prBranch: `${frozen.branch}-pr-${state.n}`,
    tickets: frozen.tickets,
  })
}

/**
 * Starts In progress again from its first step, on the same freeze: what a step found out is that an earlier one has to
 * be done again (a re-cloned mirror lost the target). Only a PR that is walking restarts.
 */
export function restartTransition(state: PrState): ToAppend<PayloadOf<'PrInProgress'>> | null {
  if (state.status !== 'in-progress') return null
  if (state.branch === null || state.main === null || state.frozenSha === null || state.prBranch === null) return null
  return inProgress({
    because: 'restart',
    branch: state.branch,
    main: state.main,
    frozenSha: state.frozenSha,
    prBranch: state.prBranch,
    tickets: state.tickets,
  })
}

/** A refused submit: only a `requested` PR can be refused. */
export function refuseTransition(
  state: PrState,
  refusal: PayloadOf<'PrSubmitRefused'>,
): ToAppend<PayloadOf<'PrSubmitRefused'>> | null {
  if (state.status !== 'requested') return null
  return { type: 'PrSubmitRefused', actor: 'conductor', data: refusal }
}

/** A step that answered `done`; one already recorded since the latest `PrInProgress` is answered from the state. */
export function stepDoneTransition(
  state: PrState,
  done: PayloadOf<'PrStepDone'>,
): ToAppend<PayloadOf<'PrStepDone'>> | null {
  if (state.status !== 'in-progress' && state.status !== 'waiting') return null
  if (state.steps.some((s) => s.step === done.step)) return null
  return { type: 'PrStepDone', actor: 'conductor', data: done }
}

const walking = (state: PrState): boolean => state.status === 'in-progress' || state.status === 'waiting'

/** The PR branch is on the remote at `headSha`; a step already recorded since the latest `PrInProgress` appends nothing. */
export function pushedTransition(
  state: PrState,
  pushed: PayloadOf<'PrPushed'>,
): ToAppend<PayloadOf<'PrPushed'>> | null {
  if (!walking(state) || state.steps.some((s) => s.step === 'push')) return null
  // A push of an earlier pass's target, recorded after a newer pass began, proves nothing about this one.
  if (pushed.headSha !== (state.target ?? state.frozenSha)) return null
  return { type: 'PrPushed', actor: 'conductor', data: pushed }
}

/** The draft pull request is open; a step already recorded since the latest `PrInProgress` appends nothing. */
export function draftOpenedTransition(
  state: PrState,
  opened: PayloadOf<'PrDraftOpened'>,
): ToAppend<PayloadOf<'PrDraftOpened'>> | null {
  if (!walking(state) || state.steps.some((s) => s.step === 'open')) return null
  return { type: 'PrDraftOpened', actor: 'conductor', data: opened }
}

/** CI follows this head. Nothing is appended for the head it already follows. */
export function ciFollowingTransition(
  state: PrState,
  following: PayloadOf<'PrCiFollowing'>,
): ToAppend<PayloadOf<'PrCiFollowing'>> | null {
  if (state.status !== 'in-progress') return null
  if (state.following === following.headSha) return null
  return { type: 'PrCiFollowing', actor: 'conductor', data: following }
}

/** The step `ci` is passed over: the project has none. Recorded once per pass through In progress. */
export function ciSkippedTransition(
  state: PrState,
  skipped: PayloadOf<'PrCiSkipped'>,
): ToAppend<PayloadOf<'PrCiSkipped'>> | null {
  if (!walking(state) || state.steps.some((s) => s.step === 'ci')) return null
  if (skipped.headSha !== state.following) return null
  return { type: 'PrCiSkipped', actor: 'conductor', data: skipped }
}

/**
 * A verdict on a head. **The same verdict on the same head appends nothing**, so a sweep that reads the same red twice
 * says it once; a pr-fix landing's new head is a new read. A verdict about an earlier pass's head proves nothing.
 */
export function checkedTransition(
  state: PrState,
  checked: PayloadOf<'PrChecked'>,
): ToAppend<PayloadOf<'PrChecked'>> | null {
  if (!walking(state)) return null
  if (checked.headSha !== state.following) return null
  // Green is the step's record, so it is appended while the step is not recorded (a retry's new pass starts empty).
  if (checked.verdict === 'green') {
    if (state.steps.some((s) => s.step === 'ci')) return null
  } else if (state.checked?.headSha === checked.headSha && state.checked.verdict === 'red') {
    return null
  }
  return { type: 'PrChecked', actor: 'conductor', data: checked }
}

/** The PR is In review. Only a PR that is walking goes there. */
export function openedTransition(
  state: PrState,
  opened: PayloadOf<'PrOpened'>,
): ToAppend<PayloadOf<'PrOpened'>> | null {
  if (!walking(state)) return null
  return { type: 'PrOpened', actor: 'conductor', data: opened }
}

/**
 * The PR was found merged. Only an open PR that has begun its walk can be: a `requested` one has nothing on the remote.
 * One already merged or closed appends nothing, so two readers finding it in one sweep append once.
 */
export function mergedTransition(
  state: PrState,
  merged: PayloadOf<'PrMerged'>,
): ToAppend<PayloadOf<'PrMerged'>> | null {
  if (!isOpen(state) || state.status === 'requested') return null
  return { type: 'PrMerged', actor: 'conductor', data: merged }
}

/** The PR was found closed without a merge. Only the code host can say so, so a PR with no host number cannot be. */
export function closedTransition(
  state: PrState,
  closed: PayloadOf<'PrClosed'>,
): ToAppend<PayloadOf<'PrClosed'>> | null {
  if (!isOpen(state) || state.status === 'requested' || state.host === null) return null
  return { type: 'PrClosed', actor: 'conductor', data: closed }
}

/** A step that needs a person; the same wait twice in a row appends nothing. */
export function waitTransition(state: PrState, wait: PayloadOf<'PrWaiting'>): ToAppend<PayloadOf<'PrWaiting'>> | null {
  if (state.status !== 'in-progress' && state.status !== 'waiting') return null
  if (state.status === 'waiting' && state.wait?.step === wait.step && state.wait.reason === wait.reason) return null
  return { type: 'PrWaiting', actor: 'conductor', data: wait }
}

export interface PrStepRow {
  readonly step: string
  readonly status: 'done' | 'waiting' | 'pending'
  readonly headSha: string | null
}

/**
 * The rows of *What Lingtai did*, drawn from the list of steps and the PR's records and from nothing hand-written:
 * a step added to the list is one more row (#1319 draws this).
 */
export function prStepRows(names: readonly string[], state: PrState): PrStepRow[] {
  return names.map((step): PrStepRow => {
    const done = state.steps.find((s) => s.step === step)
    if (done) return { step, status: 'done', headSha: done.headSha }
    if (state.status === 'waiting' && state.wait?.step === step) {
      return { step, status: 'waiting', headSha: state.wait.headSha }
    }
    return { step, status: 'pending', headSha: null }
  })
}

/**
 * The seq of the `ProjectRecipeChanged` after which the project has been team ever since, or 0 when no recorded recipe
 * says otherwise. A landing before it was a solo project's, even on a branch of the same name (0130 §3). `isTeam`
 * reads one recorded recipe text: the domain imports nothing, so it cannot parse one.
 */
export function teamSince(events: readonly Envelope[], isTeam: (source: string) => boolean): bigint {
  let since = 0n
  let team = false
  for (const e of events) {
    if (e.type !== 'ProjectRecipeChanged') continue
    const now = isTeam((e.data as PayloadOf<'ProjectRecipeChanged'>).source)
    if (now && !team) since = e.seq
    team = now
  }
  return since
}

/** The seq of a ticket's last `TicketLanded` on `base`, or null if it never landed there. */
export function landedSeq(events: readonly Envelope[], base: string): bigint | null {
  let seq: bigint | null = null
  for (const e of events) {
    if (e.type === 'TicketLanded' && (e.data as PayloadOf<'TicketLanded'>).base === base) seq = e.seq
  }
  return seq
}

/**
 * A lane's landings that have begun and are not over: per ticket, its last integration event. An attempt with no
 * terminal is `mergeCommit: null` (the push may or may not have happened); a success carries the commit it pushed.
 * **A refusal is proof of nothing pushed only when it names a reason git gave**: `unexpected` is what the integrator
 * records when appending its own `IntegrationSucceeded` failed after the push, so it is `mergeCommit: null` too — the
 * push may have happened. `headSha` is the branch head of the ticket's latest attempt: a `--no-ff` merge holds it, so
 * whether the push happened is a question git answers, never the ticket's lifecycle (releasing or closing a ticket
 * does not take back pushed code).
 */
export function landingsStarted(
  laneEvents: readonly Envelope[],
): { ticketId: string; mergeCommit: string | null; unexpected: boolean; headSha: string | null }[] {
  const last = new Map<string, Envelope>()
  const heads = new Map<string, string>()
  /** An earlier attempt whose push may have happened and that no terminal answered; a later attempt does not erase it. */
  const uncertain = new Map<string, Set<string>>()
  const owe = (ticketId: string, head: string) => {
    const set = uncertain.get(ticketId) ?? new Set<string>()
    set.add(head)
    uncertain.set(ticketId, set)
  }
  const open = new Map<string, string>()
  for (const e of laneEvents) {
    if (e.type !== 'IntegrationAttempted' && e.type !== 'IntegrationRefused' && e.type !== 'IntegrationSucceeded') {
      continue
    }
    const ticketId = (e.data as { ticketId: string }).ticketId
    last.set(ticketId, e)
    if (e.type === 'IntegrationAttempted') {
      const head = (e.data as PayloadOf<'IntegrationAttempted'>).headSha
      const before = open.get(ticketId)
      if (before !== undefined) owe(ticketId, before)
      open.set(ticketId, head)
      heads.set(ticketId, head)
    } else if (e.type === 'IntegrationSucceeded') {
      open.delete(ticketId)
      uncertain.delete(ticketId)
    } else {
      if ((e.data as { reason?: string }).reason === 'unexpected') {
        const head = open.get(ticketId)
        if (head !== undefined) owe(ticketId, head)
      }
      open.delete(ticketId)
    }
  }
  const started: { ticketId: string; mergeCommit: string | null; unexpected: boolean; headSha: string | null }[] = []
  for (const [ticketId, e] of last) {
    const headSha = heads.get(ticketId) ?? null
    if (e.type === 'IntegrationAttempted') started.push({ ticketId, mergeCommit: null, unexpected: false, headSha })
    if (e.type === 'IntegrationSucceeded') {
      started.push({
        ticketId,
        mergeCommit: (e.data as PayloadOf<'IntegrationSucceeded'>).mergeCommit,
        unexpected: false,
        headSha,
      })
    }
    if (e.type === 'IntegrationRefused' && (e.data as { reason?: string }).reason === 'unexpected') {
      started.push({ ticketId, mergeCommit: null, unexpected: true, headSha })
    }
    // An earlier attempt left uncertain stays owed beside whatever the last event says: a retry's refusal
    // (`no-commits`, because the first push is already on the base) is no proof the first pushed nothing.
    for (const earlier of uncertain.get(ticketId) ?? []) {
      if (!started.some((x) => x.ticketId === ticketId && x.headSha === earlier)) {
        started.push({ ticketId, mergeCommit: null, unexpected: true, headSha: earlier })
      }
    }
  }
  return started
}
