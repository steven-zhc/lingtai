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

export type PrStatus = 'requested' | 'in-progress' | 'waiting' | 'in-review' | 'refused'

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
  /** The steps recorded since the latest `PrInProgress`: a later pass through In progress starts empty. */
  steps: readonly PrStepRecord[]
  /**
   * What the merge back into `branch.personal` came to for the commit it was tried on (`PrMergedBack`,
   * `PrMergeBackFailed`). Keyed by `prHead`, so a later In review on a new head is owed its own.
   */
  mergeBack: { readonly prHead: string; readonly outcome: 'merged' | 'failed' } | null
  /** The last wait, while the PR is waiting. */
  wait: PayloadOf<'PrWaiting'> | null
  refusal: PayloadOf<'PrSubmitRefused'> | null
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
  steps: [],
  mergeBack: null,
  wait: null,
  refusal: null,
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
      return { ...withStep(state, { step: 'push', headSha: d.headSha }), ...at, lastPushed: d.headSha }
    }
    case 'PrDraftOpened': {
      const d = event.data as PayloadOf<'PrDraftOpened'>
      return {
        ...withStep(state, { step: 'open', headSha: state.target ?? state.frozenSha ?? '' }),
        ...at,
        host: { number: d.number, nodeId: d.nodeId, url: d.url },
      }
    }
    case 'PrOpened': {
      const d = event.data as PayloadOf<'PrOpened'>
      const stepped = d.host === 'none' ? withStep(state, { step: 'open', headSha: state.target ?? '' }) : state
      return { ...stepped, ...at, status: 'in-review', wait: null }
    }
    case 'BranchSynced': {
      const d = event.data as PayloadOf<'BranchSynced'>
      // `already` is the sync step's own record; a merge is recorded by the build that passed it. The target is the
      // commit the push step means to push, whichever it was.
      const step = d.how === 'already' ? 'sync' : 'build'
      return { ...withStep(state, { step, headSha: d.head }), ...at, target: d.head }
    }
    case 'PrMergedBack':
    case 'PrMergeBackFailed': {
      const d = event.data as { prHead: string }
      return {
        ...state,
        ...at,
        mergeBack: { prHead: d.prHead, outcome: event.type === 'PrMergedBack' ? 'merged' : 'failed' },
      }
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

/**
 * Main is in the PR's commit. A step already recorded since the latest `PrInProgress` appends nothing: `already` is the
 * `sync` step's record and a merge that built is the `build` step's. A sync recorded after a newer pass began proves
 * nothing about it, so it is held to the commit it was begun from.
 */
export function syncedTransition(
  state: PrState,
  synced: PayloadOf<'BranchSynced'>,
): ToAppend<PayloadOf<'BranchSynced'>> | null {
  if (!walking(state)) return null
  const step = synced.how === 'already' ? 'sync' : 'build'
  if (state.steps.some((s) => s.step === step)) return null
  return { type: 'BranchSynced', actor: 'conductor', data: synced }
}

/** The merge back was done or failed for `prHead`; only a PR in review, once per head. */
export function mergeBackTransition(
  state: PrState,
  outcome:
    | { type: 'PrMergedBack'; data: PayloadOf<'PrMergedBack'> }
    | { type: 'PrMergeBackFailed'; data: PayloadOf<'PrMergeBackFailed'> },
): ToAppend<PayloadOf<'PrMergedBack'>> | ToAppend<PayloadOf<'PrMergeBackFailed'>> | null {
  if (state.status !== 'in-review') return null
  if (state.mergeBack?.prHead === outcome.data.prHead) return null
  return { type: outcome.type, actor: 'conductor', data: outcome.data } as never
}

/** The draft pull request is open; a step already recorded since the latest `PrInProgress` appends nothing. */
export function draftOpenedTransition(
  state: PrState,
  opened: PayloadOf<'PrDraftOpened'>,
): ToAppend<PayloadOf<'PrDraftOpened'>> | null {
  if (!walking(state) || state.steps.some((s) => s.step === 'open')) return null
  return { type: 'PrDraftOpened', actor: 'conductor', data: opened }
}

/** The PR is In review. Only a PR that is walking goes there. */
export function openedTransition(
  state: PrState,
  opened: PayloadOf<'PrOpened'>,
): ToAppend<PayloadOf<'PrOpened'>> | null {
  if (!walking(state)) return null
  return { type: 'PrOpened', actor: 'conductor', data: opened }
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
