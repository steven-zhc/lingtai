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
  /** The steps recorded since the latest `PrInProgress`: a later pass through In progress starts empty. */
  steps: readonly PrStepRecord[]
  /**
   * What the merge back into `branch.personal` came to for the commit it was tried on (`PrMergedBack`,
   * `PrMergeBackFailed`). Keyed by `prHead`, so a later In review on a new head is owed its own.
   */
  mergeBack: {
    readonly prHead: string
    readonly outcome: 'merged' | 'failed'
    /** Why it failed. `unknown` is a failure that proves nothing was pushed or not pushed: it is tried again. */
    readonly why: string | null
  } | null
  /**
   * The rounds of the conflict agent started on this PR, oldest first (`SyncRoundStarted`, #1313). **`PrInProgress`
   * does not reset it** — 0108 §8: *no counter is reset inside its scope, not by a restart* — so the rounds used for a
   * commit are always the count of what is here for it.
   */
  rounds: readonly PayloadOf<'SyncRoundStarted'>[]
  /** The refusals of those rounds (`SyncRoundRefused`), oldest first; survives a restart the same way. */
  refusals: readonly PayloadOf<'SyncRoundRefused'>[]
  /** The last wait, while the PR is waiting. */
  wait: PayloadOf<'PrWaiting'> | null
  /** When the current wait was recorded (`PrWaiting`'s `at`); null while the PR is not waiting. */
  waitSince: Date | null
  /**
   * A person's retry or back that the conductor has not answered yet (#1314). **One slot**: a second request is refused
   * while it is set. Cleared by what answers it — `PrInProgress`, `PrWaiting`, `PrClosed`, `PrMerged`.
   */
  pending: { readonly kind: 'retry' | 'back'; readonly by: string; readonly seq: bigint } | null
  /** The rounds people gave (`PrRoundsGranted`), oldest first; each belongs to its commit and nothing resets them. */
  grants: readonly PayloadOf<'PrRoundsGranted'>[]
  /**
   * A head a person pushed and a retry adopted (`PrHeadAdopted`), until a build of it is recorded. **A commit Lingtai did not
   * make was not built by Lingtai**, so the build step builds it rather than take the sync's word.
   */
  adopted: string | null
  /**
   * The conflict a grant sent back to the agent, until the PR waits again or moves past it (#1314): a second grant for the
   * same commit, read against the state the first one left, is still a person's decision and adds to it.
   */
  granting: { readonly merging: 'main' | 'back'; readonly commit: string } | null
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
  steps: [],
  mergeBack: null,
  rounds: [],
  refusals: [],
  wait: null,
  waitSince: null,
  pending: null,
  grants: [],
  adopted: null,
  granting: null,
  refusal: null,
  ended: null,
  version: 0,
  lastSeq: null,
}

/** A step recorded once; a step that finished after a wait is the person's answer taking effect. */
function withStep(state: PrState, record: PrStepRecord): PrState {
  const steps = state.steps.some((r) => r.step === record.step) ? state.steps : [...state.steps, record]
  return {
    ...state,
    status: state.status === 'waiting' ? 'in-progress' : state.status,
    steps,
    wait: null,
    waitSince: null,
  }
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
        waitSince: null,
        pending: null,
        granting: null,
      }
    }
    case 'PrStepDone': {
      const d = event.data as PayloadOf<'PrStepDone'>
      const steps = state.steps.some((s) => s.step === d.step) ? state.steps : [...state.steps, d]
      const adopted = d.step === 'build' && d.headSha === state.adopted ? null : state.adopted
      // A step that finished after a wait is the person's answer taking effect: the PR is walking again.
      return {
        ...state,
        ...at,
        status: state.status === 'waiting' ? 'in-progress' : state.status,
        steps,
        wait: null,
        waitSince: null,
        pending: state.status === 'waiting' ? null : state.pending,
        granting: null,
        adopted,
      }
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
      // `already` and `resolved` are the sync step's own record (a resolution was built and reviewed inside it); a
      // clean merge is recorded by the build that passed it. The target is the commit the push step means to push.
      const step = syncedStep(state, d.how)
      return {
        ...withStep(state, { step, headSha: d.head }),
        ...at,
        target: d.head,
        adopted: d.how === 'clean' ? null : state.adopted,
      }
    }
    case 'SyncRoundRefused':
      return { ...state, ...at, refusals: [...state.refusals, event.data as PayloadOf<'SyncRoundRefused'>] }
    case 'SyncRoundStarted': {
      const d = event.data as PayloadOf<'SyncRoundStarted'>
      // The PR is resolving another commit than the one a grant was for: that grant's page is stale now.
      const same = state.granting !== null && state.granting.merging === d.merging && state.granting.commit === d.commit
      return { ...state, ...at, rounds: [...state.rounds, d], granting: same ? state.granting : null }
    }
    case 'PrMergedBack':
    case 'PrMergeBackFailed': {
      const d = event.data as { prHead: string; why?: string }
      const merged = event.type === 'PrMergedBack'
      return {
        ...state,
        ...at,
        mergeBack: { prHead: d.prHead, outcome: merged ? 'merged' : 'failed', why: merged ? null : (d.why ?? null) },
      }
    }
    case 'PrMerged': {
      const d = event.data as PayloadOf<'PrMerged'>
      const ended = { how: d.how, headSha: d.headSha, mergeSha: d.mergeSha, seq: event.seq, at: event.at }
      return { ...state, ...at, status: 'merged', wait: null, waitSince: null, pending: null, granting: null, ended }
    }
    case 'PrClosed': {
      const d = event.data as PayloadOf<'PrClosed'>
      const ended = { how: null, headSha: d.headSha, mergeSha: null, seq: event.seq, at: event.at }
      return { ...state, ...at, status: 'closed', wait: null, waitSince: null, pending: null, granting: null, ended }
    }
    case 'PrWaiting': {
      const d = event.data as PayloadOf<'PrWaiting'>
      const since = state.status === 'waiting' && state.wait?.reason === d.reason ? state.waitSince : event.at
      return { ...state, ...at, status: 'waiting', wait: d, waitSince: since, pending: null, granting: null }
    }
    case 'PrRoundsGranted': {
      // The grant is the person's answer taking effect: the PR walks again from the step it waited at, which counts the rounds.
      const d = event.data as PayloadOf<'PrRoundsGranted'>
      const walks = state.status === 'waiting'
      return {
        ...state,
        ...at,
        grants: [...state.grants, d],
        status: walks ? 'in-progress' : state.status,
        wait: walks ? null : state.wait,
        waitSince: walks ? null : state.waitSince,
        granting: walks && state.wait?.conflict ? { merging: d.merging, commit: d.commit } : state.granting,
      }
    }
    case 'PrRetryRequested': {
      const d = event.data as PayloadOf<'PrRetryRequested'>
      return { ...state, ...at, pending: { kind: 'retry', by: d.by, seq: event.seq } }
    }
    case 'PrBackRequested': {
      const d = event.data as PayloadOf<'PrBackRequested'>
      return { ...state, ...at, pending: { kind: 'back', by: d.by, seq: event.seq } }
    }
    case 'PrHeadAdopted': {
      const d = event.data as PayloadOf<'PrHeadAdopted'>
      return { ...state, ...at, lastPushed: d.head, target: d.head, adopted: d.head }
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
  const step = syncedStep(state, synced.how)
  if (state.steps.some((s) => s.step === step)) return null
  return { type: 'BranchSynced', actor: 'conductor', data: synced }
}

/**
 * Which step a `BranchSynced` is the record of. A clean merge is the build's; `already` and a resolution of a conflict are the
 * sync step's own. **A record made once `sync` is on the steps is the build's** (#1352): a merge that built red and an agent
 * amended is recorded by the build step, or the next serve would build the old merge again and buy another round.
 */
export const syncedStep = (state: PrState, how: PayloadOf<'BranchSynced'>['how']): 'sync' | 'build' =>
  how === 'clean' || state.steps.some((r) => r.step === 'sync') ? 'build' : 'sync'

/**
 * How many rounds of the conflict agent started for one commit being merged (`merging`), and how many are allowed:
 * `bound` (`attempt.conflictResolutions`) plus `granted` — the rounds a person gave for this commit (#1314).
 * Counted from the log's events and never from memory.
 */
export function conflictRoundsLeft(
  state: PrState,
  merging: 'main' | 'back',
  commit: string,
  bound: number,
  granted = 0,
): { readonly used: number; readonly left: number; readonly next: number } {
  const used = state.rounds.filter((r) => r.merging === merging && r.commit === commit).length
  return { used, left: Math.max(0, bound + granted - used), next: used + 1 }
}

/** The PR branch was merged back into `branch.personal` and pushed; only a PR in review, once per head. */
export function mergedBackTransition(
  state: PrState,
  merged: PayloadOf<'PrMergedBack'>,
): ToAppend<PayloadOf<'PrMergedBack'>> | null {
  if (state.status !== 'in-review') return null
  // A failure — `unknown` above all, which a landed push whose answer was lost looks like — never stands in the way of the merge being found.
  if (state.mergeBack?.prHead === merged.prHead && state.mergeBack.outcome === 'merged') return null
  return { type: 'PrMergedBack', actor: 'conductor', data: merged }
}

/** The merge back did not complete (with `unknown`, not known whether the push landed; the head stays owed); the PR's own state does not change. Once per head, like the success. */
export function mergeBackFailedTransition(
  state: PrState,
  failed: PayloadOf<'PrMergeBackFailed'>,
): ToAppend<PayloadOf<'PrMergeBackFailed'>> | null {
  if (state.status !== 'in-review') return null
  const was = state.mergeBack
  if (was?.prHead === failed.prHead && (was.outcome === 'merged' || was.why === failed.why)) return null
  return { type: 'PrMergeBackFailed', actor: 'conductor', data: failed }
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

const closeEvent = (closed: PayloadOf<'PrClosed'>): ToAppend<PayloadOf<'PrClosed'>> => ({
  type: 'PrClosed',
  actor: 'conductor',
  data: closed,
})

/** The PR was found closed without a merge. Only the code host can say so, so a PR with no host number cannot be. */
export function closedTransition(
  state: PrState,
  closed: PayloadOf<'PrClosed'>,
): ToAppend<PayloadOf<'PrClosed'>> | null {
  if (!isOpen(state) || state.status === 'requested' || state.host === null) return null
  return closeEvent(closed)
}

/**
 * A person took the PR back (#1314): it is closed **by Lingtai, on the code host or where there is none**, which is the one
 * close a PR with no host number can have. Only a pending back records it.
 */
export function backClosedTransition(
  state: PrState,
  closed: PayloadOf<'PrClosed'>,
): ToAppend<PayloadOf<'PrClosed'>> | null {
  if (state.pending?.kind !== 'back' || !isOpen(state) || state.status === 'requested') return null
  return closeEvent(closed)
}

/** A step that needs a person; the same wait twice in a row appends nothing. */
export function waitTransition(state: PrState, wait: PayloadOf<'PrWaiting'>): ToAppend<PayloadOf<'PrWaiting'>> | null {
  if (state.status !== 'in-progress' && state.status !== 'waiting') return null
  // A request a person made is answered by this wait, even when it is the wait they were already in: it clears `pending`.
  if (
    state.pending === null &&
    state.status === 'waiting' &&
    state.wait?.step === wait.step &&
    state.wait.reason === wait.reason
  ) {
    return null
  }
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

/**
 * A round of the conflict agent is about to start (#1313). Only a PR that is walking, or In review for the merge back,
 * has one; the number is the next for that commit, so two appenders of one round cannot both be counted.
 */
export function syncRoundTransition(
  state: PrState,
  round: PayloadOf<'SyncRoundStarted'>,
): ToAppend<PayloadOf<'SyncRoundStarted'>> | null {
  if (!conflictOpen(state)) return null
  const used = state.rounds.filter((r) => r.merging === round.merging && r.commit === round.commit).length
  if (round.round !== used + 1) return null
  return { type: 'SyncRoundStarted', actor: 'conductor', data: round }
}

/**
 * Whether a conflict round may still be counted on this PR: walking, or In review for the merge back. A PR that was merged or
 * closed meanwhile is not, and **that is a refusal that will never lift** — a caller must stop, not read and try again.
 */
export const conflictOpen = (state: PrState): boolean => walking(state) || state.status === 'in-review'

/** A started round was refused (#1313): once per round, and only on a PR a round may still be counted on. */
export function syncRefusalTransition(
  state: PrState,
  refusal: PayloadOf<'SyncRoundRefused'>,
): ToAppend<PayloadOf<'SyncRoundRefused'>> | null {
  if (!conflictOpen(state)) return null
  const same = (r: { merging: string; commit: string; round: number }) =>
    r.merging === refusal.merging && r.commit === refusal.commit && r.round === refusal.round
  if (!state.rounds.some(same) || state.refusals.some(same)) return null
  return { type: 'SyncRoundRefused', actor: 'conductor', data: refusal }
}

/** The refusal of the latest refused round for a commit, from the log: what buys the next round, and what a spent end says. */
export const lastRefusalOf = (
  state: PrState,
  merging: 'main' | 'back',
  commit: string,
): { readonly step: 'build' | 'review' | 'answer'; readonly said: string } | null => {
  const mine = state.refusals.filter((r) => r.merging === merging && r.commit === commit)
  const latest = mine.at(-1)
  return latest === undefined ? null : { step: latest.step, said: latest.said }
}

/** What a person's request came to when asked: the event to append, or the sentence that says why not. */
export type PrRequest<E> = { kind: 'request'; event: ToAppend<E> } | { kind: 'refused'; detail: string }

const refused = (detail: string): { kind: 'refused'; detail: string } => ({ kind: 'refused', detail })

/** The refusals every request shares: a solo project, no PR, a PR that ended, a request already waiting to be served. */
function notAskable(
  state: PrState | null,
  mode: 'solo' | 'team',
  project: string,
): { kind: 'refused'; detail: string } | null {
  if (mode === 'solo') return refused(`${project} lands on its main branch itself; there is no PR`)
  if (state === null || !isOpen(state) || state.n === null) return refused(`${project} has no PR open`)
  if (state.pending !== null) {
    return refused(
      `${prName(project, state.n)} already has a ${state.pending.kind} asked for by ${state.pending.by}; lingtai pr says when it is served`,
    )
  }
  return null
}

/** The rounds a person gave for one commit: the sum of the grants that name it. */
export const grantedFor = (state: PrState, merging: 'main' | 'back', commit: string): number =>
  state.grants.filter((g) => g.merging === merging && g.commit === commit).reduce((sum, g) => sum + g.rounds, 0)

/**
 * *Give the agent 3 more rounds* (#1314). Refused by name, appending nothing, on a solo project, with no PR open, on a PR
 * that is not waiting, on a wait that is not a conflict the agent was asked about, and for a commit other than the one the wait
 * is about (a stale page: the wait is about another one now).
 */
export function grantTransition(
  state: PrState | null,
  mode: 'solo' | 'team',
  project: string,
  grant: { by: string; merging: 'main' | 'back'; commit: string },
): PrRequest<PayloadOf<'PrRoundsGranted'>> {
  const no = notAskable(state, mode, project)
  if (no !== null) return no
  if (state === null || state.n === null) return refused(`${project} has no PR open`)
  const name = prName(project, state.n)
  const granted: PrRequest<PayloadOf<'PrRoundsGranted'>> = {
    kind: 'request',
    event: {
      type: 'PrRoundsGranted',
      actor: grant.by,
      data: { by: grant.by, merging: grant.merging, commit: grant.commit, rounds: 3 },
    },
  }
  // Two people granting against one wait: the first moved the PR on, and the second still adds to the same commit.
  if (
    state.status === 'in-progress' &&
    state.granting !== null &&
    state.granting.merging === grant.merging &&
    state.granting.commit === grant.commit
  ) {
    return granted
  }
  if (state.status !== 'waiting' || state.wait === null)
    return refused(`${name} is ${state.status}, not waiting on you`)
  if (state.wait.reason !== 'sync-conflict') {
    return refused(
      `rounds buy an agent only for a conflict — ${name} waits on ${state.wait.reason}: fix it by hand, then lingtai pr retry`,
    )
  }
  const conflict = state.wait.conflict ?? null
  if (conflict === null) {
    return refused('no agent resolves conflicts for this project — fix it by hand, then lingtai pr retry')
  }
  if (conflict.merging !== grant.merging || conflict.commit !== grant.commit) {
    return refused(
      `${name} now waits on ${conflict.merging === 'main' ? 'main' : 'the merge back'} at ${conflict.commit.slice(0, 7)}, not ${grant.commit.slice(0, 7)}: read it again`,
    )
  }
  return granted
}

/** *Check again* (#1314): refused by name on a solo project, with no PR open, and on a PR that is not waiting. */
export function retryRequestTransition(
  state: PrState | null,
  mode: 'solo' | 'team',
  project: string,
  by: string,
): PrRequest<PayloadOf<'PrRetryRequested'>> {
  const no = notAskable(state, mode, project)
  if (no !== null) return no
  if (state === null || state.n === null) return refused(`${project} has no PR open`)
  if (state.status !== 'waiting') {
    return refused(
      `${prName(project, state.n)} is ${state.status}, not waiting on you; there is nothing to check again`,
    )
  }
  return { kind: 'request', event: { type: 'PrRetryRequested', actor: by, data: { by } } }
}

/** *Back* (#1314): refused while a step is running, and on a PR that has not begun or has ended. */
export function backRequestTransition(
  state: PrState | null,
  mode: 'solo' | 'team',
  project: string,
  by: string,
): PrRequest<PayloadOf<'PrBackRequested'>> {
  const no = notAskable(state, mode, project)
  if (no !== null) return no
  if (state === null || state.n === null) return refused(`${project} has no PR open`)
  if (state.status === 'requested' || state.status === 'in-progress') {
    return refused(`${prName(project, state.n)} is ${state.status}: wait for it, or for it to wait on you`)
  }
  return { kind: 'request', event: { type: 'PrBackRequested', actor: by, data: { by } } }
}

/**
 * The conductor serves a retry that changed nothing on the branch, or whose head it has adopted: the PR walks again from its
 * first step on the same freeze. Only a waiting PR with a retry pending does.
 */
export function retryTransition(state: PrState): ToAppend<PayloadOf<'PrInProgress'>> | null {
  if (state.status !== 'waiting' || state.pending?.kind !== 'retry') return null
  if (state.branch === null || state.main === null || state.frozenSha === null || state.prBranch === null) return null
  return inProgress({
    because: 'retry',
    branch: state.branch,
    main: state.main,
    frozenSha: state.frozenSha,
    prBranch: state.prBranch,
    tickets: state.tickets,
  })
}

/** A head a person pushed, adopted: only for a pending retry, and only a head that is not already the last pushed. */
export function adoptTransition(
  state: PrState,
  adopted: PayloadOf<'PrHeadAdopted'>,
): ToAppend<PayloadOf<'PrHeadAdopted'>> | null {
  if (state.status !== 'waiting' || state.pending?.kind !== 'retry') return null
  if (state.lastPushed === adopted.head) return null
  return { type: 'PrHeadAdopted', actor: 'conductor', data: adopted }
}
