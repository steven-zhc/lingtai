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
  /** The steps recorded since the latest `PrInProgress`: a later pass through In progress starts empty. */
  steps: readonly PrStepRecord[]
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
  steps: [],
  wait: null,
  refusal: null,
  version: 0,
  lastSeq: null,
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

/** The freeze: only a `requested` PR is frozen; anything else decides nothing. */
export function freezeTransition(
  state: PrState,
  frozen: { branch: string; main: string; frozenSha: string; tickets: PayloadOf<'PrInProgress'>['tickets'] },
): ToAppend<PayloadOf<'PrInProgress'>> | null {
  if (state.status !== 'requested' || state.n === null) return null
  return {
    type: 'PrInProgress',
    actor: 'conductor',
    data: {
      because: 'submit',
      branch: frozen.branch,
      main: frozen.main,
      frozenSha: frozen.frozenSha,
      prBranch: `${frozen.branch}-pr-${state.n}`,
      tickets: frozen.tickets,
    },
  }
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
 * A refusal pushed nothing. The caller checks each success against its ticket's own `TicketLanded`.
 */
export function landingsStarted(laneEvents: readonly Envelope[]): { ticketId: string; mergeCommit: string | null }[] {
  const last = new Map<string, Envelope>()
  for (const e of laneEvents) {
    if (e.type === 'IntegrationAttempted' || e.type === 'IntegrationRefused' || e.type === 'IntegrationSucceeded') {
      last.set((e.data as { ticketId: string }).ticketId, e)
    }
  }
  const started: { ticketId: string; mergeCommit: string | null }[] = []
  for (const [ticketId, e] of last) {
    if (e.type === 'IntegrationAttempted') started.push({ ticketId, mergeCommit: null })
    if (e.type === 'IntegrationSucceeded') {
      started.push({ ticketId, mergeCommit: (e.data as PayloadOf<'IntegrationSucceeded'>).mergeCommit })
    }
  }
  return started
}
