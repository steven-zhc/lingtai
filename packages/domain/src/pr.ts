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
  /**
   * A pr-fix landed on the PR branch and In progress has not yet started again for it (`PrFixLanded` sets it,
   * `PrInProgress` clears it): the serve answers it before anything else (#1341).
   */
  fixOwed: boolean
  /**
   * How many of `tickets` each commit holds (#1341): set when a head becomes the PR's — frozen, restarted, a pr-fix's
   * landing, a sync. What an ending or a merge back covers is read from here, never from the branch as a whole.
   */
  covers: Readonly<Record<string, number>>
  /** The tickets the commit a `PrMerged` named holds; the rest landed on the PR branch after it and are not merged. */
  mergedTickets: readonly string[]
  /** False when the merged head was never recorded: `mergedTickets` is then only what every known head held, and the rest are proven one by one (#1341). */
  mergedExact: boolean
  /** The tickets a successful merge back into the personal branch carried, over every merge back. */
  mergedBackTickets: readonly string[]
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
   * What the catch-up of `branch.personal` with `main` after the merge came to (`PrCaughtUp`, `PrCatchUpFailed`, #1371).
   */
  catchUp: {
    readonly mainSha: string
    readonly outcome: 'caught-up' | 'failed'
    readonly why: string | null
    readonly mergeCommit: string | null
    readonly conflict?: PayloadOf<'PrCatchUpFailed'>['conflict']
    /** A failure that waited on a person, and has since been granted rounds or asked to retry: owed again. */
    readonly released: boolean
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
  granting: { readonly merging: 'main' | 'back' | 'outside'; readonly commit: string } | null
  refusal: PayloadOf<'PrSubmitRefused'> | null
  /**
   * The PR's title and summary as they stand (#1318): the agent's (`PrSummaryWritten`), the summary the person's where they
   * edited it (`PrSummaryEdited`, which leaves the title as the agent wrote it). **`PrInProgress` does not reset any of
   * the summary's facts** — a rework or a pr-fix pass never rewrites it.
   */
  summary: { readonly title: string | null; readonly text: string | null } | null
  /** The latest person's edit of the summary, and the stream version it landed at: an agent run that began before it loses. */
  edited: { readonly by: string; readonly version: number } | null
  /** The stream version of the latest `PrSummaryWritten` or `PrSummaryNotWritten`: the summary was tried by then, whatever came of it. Null before the first. */
  summaryTried: number | null
  /** Why the latest summary attempt wrote nothing (`PrSummaryNotWritten`); null once a summary was written or edited, and before any attempt. */
  summaryNotWritten: string | null
  /** The PR was marked ready for review on the code host (`PrOpened` with a host): it is no longer a draft there, whatever a later pass does. */
  markedReady: boolean
  /** The pr-fix tickets that joined the PR, each with the version of the `PrFixLanded` that said so. */
  fixesLanded: readonly {
    readonly ticket: string
    readonly mergeCommit: string
    readonly title: string
    readonly version: number
  }[]
  /** The conflicts the conflict agent resolved on this PR (`BranchSynced { how: 'resolved' }`, #1313), for the summary's prompt. */
  resolutions: readonly { readonly mainCommit: string; readonly head: string }[]
  /** The merges of commits others pushed to the PR branch (`PrOutsideMerged`, #1353), each with the stream version it landed at. */
  outsideMerged: readonly (PayloadOf<'PrOutsideMerged'> & { readonly version: number })[]
  /** The hash of the description last put on the code host (`PrDescriptionPushed`). */
  descriptionPushed: string | null
  /** The stream version of the latest summary event (written, not written, edited): a push rendered before it leaves the description owed. */
  summaryChangedAt: number
  /** A summary event came after what the last `PrDescriptionPushed` rendered: the code host's description is behind the log's. */
  descriptionOwed: boolean
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
  fixOwed: false,
  covers: {},
  mergedTickets: [],
  mergedExact: true,
  mergedBackTickets: [],
  host: null,
  pushedAt: null,
  checked: null,
  checks: null,
  ciSkipped: null,
  following: null,
  steps: [],
  mergeBack: null,
  catchUp: null,
  rounds: [],
  refusals: [],
  wait: null,
  waitSince: null,
  pending: null,
  grants: [],
  adopted: null,
  granting: null,
  refusal: null,
  summary: null,
  summaryNotWritten: null,
  markedReady: false,
  edited: null,
  summaryTried: null,
  fixesLanded: [],
  resolutions: [],
  outsideMerged: [],
  descriptionPushed: null,
  summaryChangedAt: 0,
  descriptionOwed: false,
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

/** How many tickets a commit holds: what was recorded for it, else all if it is the PR's head, else those it was frozen with. */
function heldAt(state: PrState, sha: string): number {
  // A head never recorded has no ancestry evidence here, so it is held to the fewest tickets any recorded head held: a
  // ticket left open for want of proof is found again, one closed without it is not (#1341).
  const known = state.covers[sha]
  if (known !== undefined) return known
  const all = Object.values(state.covers)
  return all.length === 0 ? state.tickets.length : Math.min(...all)
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
        // A restart names a head already recorded: what that head held stays what it was, not what the PR holds now.
        covers: { ...state.covers, [d.frozenSha]: state.covers[d.frozenSha] ?? d.tickets.length },
        fixOwed: false,
        steps: [],
        wait: null,
        following: null,
        waitSince: null,
        pending: null,
        granting: null,
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
        waitSince: null,
      }
    }
    case 'PrFixLanded': {
      const d = event.data as PayloadOf<'PrFixLanded'>
      // The landing is the PR branch's new head: it is what In progress means to push, and what the push step finds there.
      const tickets = state.tickets.some((t) => t.ticket === d.ticket)
        ? state.tickets
        : [...state.tickets, { ticket: d.ticket, mergeCommit: d.mergeCommit, title: d.title ?? '' }]
      return {
        ...state,
        ...at,
        lastPushed: d.mergeCommit,
        target: d.mergeCommit,
        fixOwed: true,
        tickets,
        covers: { ...state.covers, [d.mergeCommit]: tickets.length },
        fixesLanded: state.fixesLanded.some((f) => f.ticket === d.ticket)
          ? state.fixesLanded
          : [
              ...state.fixesLanded,
              { ticket: d.ticket, mergeCommit: d.mergeCommit, title: d.title ?? '', version: event.version },
            ],
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
      const stepped =
        d.host === 'none'
          ? withStep(state, { step: 'open', headSha: state.target ?? '' })
          : withStep(state, { step: 'ready', headSha: state.following ?? state.target ?? '' })
      return { ...stepped, ...at, status: 'in-review', wait: null, markedReady: state.markedReady || d.host !== 'none' }
    }
    case 'BranchSynced': {
      const d = event.data as PayloadOf<'BranchSynced'>
      // `already` and `resolved` are the sync step's own record (a resolution was built and reviewed inside it) — except
      // a resolution made once `sync` is recorded, an agent's amend of a red merge, which is the build step's (`syncedStep`); a
      // clean merge is recorded by the build that passed it. The target is the commit the push step means to push.
      const step = syncedStep(state, d.how)
      // The sync started from `target` or from the newer `lastPushed`; the merge holds what the later of the two held. A
      // count is recorded only when every commit it could have started from has an exact one — `heldAt`'s floor is for
      // reading, and a guess written here would read as exact (#1354).
      const starts = [state.target, state.lastPushed].filter((c): c is string => c !== null)
      const counts = starts.map((c) => state.covers[c])
      const exact = counts.length > 0 && counts.every((n) => n !== undefined)
      const covers =
        exact && state.covers[d.head] === undefined
          ? { ...state.covers, [d.head]: Math.max(...(counts as number[])) }
          : state.covers
      return {
        ...withStep(state, { step, headSha: d.head }),
        ...at,
        target: d.head,
        covers,
        adopted: d.how === 'clean' ? null : state.adopted,
        resolutions:
          d.how === 'resolved' ? [...state.resolutions, { mainCommit: d.mainCommit, head: d.head }] : state.resolutions,
      }
    }
    case 'PrOutsideMerged': {
      const d = event.data as PayloadOf<'PrOutsideMerged'>
      // The merge adds others' commits and no ticket: it holds what the commit it was made on held.
      const held = state.target === null ? undefined : state.covers[state.target]
      return {
        ...withStep(state, { step: 'outside', headSha: d.head }),
        ...at,
        target: d.head,
        covers:
          held !== undefined && state.covers[d.head] === undefined ? { ...state.covers, [d.head]: held } : state.covers,
        outsideMerged: [...state.outsideMerged, { ...d, version: event.version }],
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
      const carried = merged ? state.tickets.slice(0, heldAt(state, d.prHead)).map((t) => t.ticket) : []
      return {
        ...state,
        ...at,
        mergeBack: { prHead: d.prHead, outcome: merged ? 'merged' : 'failed', why: merged ? null : (d.why ?? null) },
        mergedBackTickets: [...new Set([...state.mergedBackTickets, ...carried])],
      }
    }
    case 'PrCaughtUp':
    case 'PrCatchUpFailed': {
      const d = event.data as PayloadOf<'PrCaughtUp'> & Partial<PayloadOf<'PrCatchUpFailed'>>
      const ok = event.type === 'PrCaughtUp'
      return {
        ...state,
        ...at,
        // A retry asked of a merged PR is consumed by the catch-up: nothing else serves it.
        pending: state.status === 'merged' ? null : state.pending,
        catchUp: {
          mainSha: d.mainSha,
          outcome: ok ? 'caught-up' : 'failed',
          why: ok ? null : (d.why ?? null),
          mergeCommit: ok ? (d.mergeCommit ?? null) : null,
          ...(d.conflict === undefined || d.conflict === null ? {} : { conflict: d.conflict }),
          released: false,
        },
      }
    }
    case 'PrMerged': {
      const d = event.data as PayloadOf<'PrMerged'>
      const ended = { how: d.how, headSha: d.headSha, mergeSha: d.mergeSha, seq: event.seq, at: event.at }
      const mergedTickets = state.tickets.slice(0, heldAt(state, d.headSha)).map((t) => t.ticket)
      // A head nobody recorded (a person pushed atop the PR branch) holds an unknown number of tickets: a floor, not a count.
      const mergedExact = state.covers[d.headSha] !== undefined || Object.keys(state.covers).length === 0
      return {
        ...state,
        ...at,
        status: 'merged',
        wait: null,
        waitSince: null,
        pending: null,
        granting: null,
        ended,
        mergedTickets,
        mergedExact,
      }
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
        catchUp: releaseCatchUp(state, d.merging === 'back' && d.commit === state.catchUp?.mainSha),
        grants: [...state.grants, d],
        status: walks ? 'in-progress' : state.status,
        wait: walks ? null : state.wait,
        waitSince: walks ? null : state.waitSince,
        granting: walks && state.wait?.conflict ? { merging: d.merging, commit: d.commit } : state.granting,
      }
    }
    case 'PrRetryRequested': {
      const d = event.data as PayloadOf<'PrRetryRequested'>
      return {
        ...state,
        ...at,
        catchUp: releaseCatchUp(state, true),
        pending: { kind: 'retry', by: d.by, seq: event.seq },
      }
    }
    case 'PrBackRequested': {
      const d = event.data as PayloadOf<'PrBackRequested'>
      return { ...state, ...at, pending: { kind: 'back', by: d.by, seq: event.seq } }
    }
    case 'PrHeadAdopted': {
      const d = event.data as PayloadOf<'PrHeadAdopted'>
      return { ...state, ...at, lastPushed: d.head, target: d.head, adopted: d.head }
    }
    case 'PrSummaryWritten': {
      const d = event.data as PayloadOf<'PrSummaryWritten'>
      return {
        ...state,
        ...at,
        summary: { title: d.title, text: d.summary },
        summaryNotWritten: null,
        // What the run saw, not where its answer landed: a pr-fix that joined while it ran is not covered.
        summaryTried: d.basedOn,
        summaryChangedAt: event.version,
        descriptionOwed: true,
      }
    }
    case 'PrSummaryNotWritten': {
      const d = event.data as PayloadOf<'PrSummaryNotWritten'>
      return {
        ...state,
        ...at,
        summaryNotWritten: d.why,
        summaryTried: d.basedOn,
        summaryChangedAt: event.version,
        descriptionOwed: true,
      }
    }
    case 'PrSummaryEdited': {
      const d = event.data as PayloadOf<'PrSummaryEdited'>
      return {
        ...state,
        ...at,
        summary: { title: state.summary?.title ?? null, text: d.summary },
        summaryNotWritten: null,
        edited: { by: d.by, version: event.version },
        summaryChangedAt: event.version,
        descriptionOwed: true,
      }
    }
    case 'PrDescriptionPushed': {
      const d = event.data as PayloadOf<'PrDescriptionPushed'>
      return {
        ...state,
        ...at,
        descriptionPushed: d.bodyHash,
        descriptionOwed: d.basedOn < state.summaryChangedAt,
      }
    }
    default:
      return { ...state, ...at }
  }
}

/** A merged PR whose catch-up failed on a person is owed it again once they have granted rounds or asked to retry. */
const releaseCatchUp = (state: PrState, asked: boolean): PrState['catchUp'] =>
  asked && state.status === 'merged' && state.catchUp?.outcome === 'failed'
    ? { ...state.catchUp, released: true }
    : state.catchUp

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

/**
 * A pr-fix landed on the PR's branch (#1341): only an open PR that has begun its walk is owed In progress again, and a
 * ticket the PR already holds appends nothing, so the in-lane append and the sweep's repair write it once.
 */
export function fixLandedTransition(
  state: PrState,
  landed: PayloadOf<'PrFixLanded'>,
): ToAppend<PayloadOf<'PrFixLanded'>> | null {
  if (!isOpen(state) || state.status === 'requested') return null
  if (state.tickets.some((t) => t.ticket === landed.ticket)) return null
  return { type: 'PrFixLanded', actor: 'conductor', data: landed }
}

/**
 * Starts In progress again from its first step because a pr-fix landed: the target is the head the fix made, which is
 * what the push step finds on the remote, and the tickets include the fix.
 */
export function fixRestartTransition(state: PrState): ToAppend<PayloadOf<'PrInProgress'>> | null {
  if (!state.fixOwed || !isOpen(state) || state.status === 'requested') return null
  if (state.branch === null || state.main === null || state.prBranch === null) return null
  const head = state.lastPushed ?? state.target
  if (head === null) return null
  return inProgress({
    because: 'pr-fix',
    branch: state.branch,
    main: state.main,
    frozenSha: head,
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
 * Commits others pushed to the PR branch are in the PR's commit (0131 §4, #1353). A step already recorded since the latest
 * `PrInProgress` appends nothing; a record made after a newer pass began proves nothing about it.
 */
export function outsideTransition(
  state: PrState,
  merged: PayloadOf<'PrOutsideMerged'>,
  onto: string,
): ToAppend<PayloadOf<'PrOutsideMerged'>> | null {
  if (!walking(state) || state.steps.some((s) => s.step === 'outside')) return null
  // A merge made on a commit that is no longer the target (a pr-fix landed meanwhile) holds none of what the target holds.
  if (onto !== (state.target ?? state.frozenSha)) return null
  return { type: 'PrOutsideMerged', actor: 'conductor', data: merged }
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
  merging: 'main' | 'back' | 'outside',
  commit: string,
  bound: number,
  granted = 0,
): { readonly used: number; readonly left: number; readonly next: number } {
  const used = state.rounds.filter((r) => r.merging === merging && r.commit === commit).length
  return { used, left: Math.max(0, bound + granted - used), next: used + 1 }
}

/**
 * The PR branch was merged back into `branch.personal` and pushed; once per head, for the head last pushed. The PR may have
 * been closed or merged since the push, and the push still landed (#1354). A PR that never reached review has no such head.
 * (A push that landed, a process that died before this, and a PR closed after is not found again: `mergeBackOwed` is in review only.)
 */
export function mergedBackTransition(
  state: PrState,
  merged: PayloadOf<'PrMergedBack'>,
): ToAppend<PayloadOf<'PrMergedBack'>> | null {
  if (state.status !== 'in-review' && state.status !== 'merged' && state.status !== 'closed') return null
  if (state.lastPushed !== merged.prHead) return null
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

/**
 * After the merge, the personal branch was caught up with `main` once (#1371). Only a merged PR has one; a second answer
 * appends nothing, whatever its sha.
 */
export function caughtUpTransition(
  state: PrState,
  caught: PayloadOf<'PrCaughtUp'>,
): ToAppend<PayloadOf<'PrCaughtUp'>> | null {
  if (state.status !== 'merged' || state.catchUp?.outcome === 'caught-up') return null
  return { type: 'PrCaughtUp', actor: 'conductor', data: caught }
}

/** The catch-up did not complete; once per answer, as `mergeBackFailedTransition`. */
export function catchUpFailedTransition(
  state: PrState,
  failed: PayloadOf<'PrCatchUpFailed'>,
): ToAppend<PayloadOf<'PrCatchUpFailed'>> | null {
  if (state.status !== 'merged') return null
  const was = state.catchUp
  if (was !== null && (was.outcome === 'caught-up' || (was.mainSha === failed.mainSha && was.why === failed.why)))
    return null
  return { type: 'PrCatchUpFailed', actor: 'conductor', data: failed }
}

/**
 * Whether a merged PR's personal branch is still owed the catch-up: none recorded, or the last one `unknown` or `locked`
 * (tried again), or one that waited on a person and has since been granted rounds or asked to retry.
 */
export const catchUpOwed = (state: PrState): boolean => {
  if (state.status !== 'merged') return false
  const was = state.catchUp
  if (was === null) return true
  if (was.outcome === 'caught-up') return false
  if (was.why === 'unknown' || was.why === 'locked') return true
  return was.released
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

/**
 * The summary agent's answer (#1318). **The person's words win a race**: a `PrSummaryEdited` that landed after the version
 * the run began at (`basedOn`) is the summary, and the agent's text is set aside — recorded as `PrSummaryNotWritten`, which
 * still counts as the attempt, so the pr-fix it was about is not summarised again. The append is at the head this was read
 * at, so an edit landing between the check and the append moves the version, and the retry reads it.
 */
export function summaryWrittenTransition(
  state: PrState,
  written: PayloadOf<'PrSummaryWritten'>,
): ToAppend<PayloadOf<'PrSummaryWritten'> | PayloadOf<'PrSummaryNotWritten'>> | null {
  if (!walking(state)) return null
  if (state.edited !== null && state.edited.version > written.basedOn) {
    return summaryNotWrittenTransition(state, {
      at: written.at,
      basedOn: written.basedOn,
      why: `set aside: ${state.edited.by} edited the summary while the agent was writing`,
    })
  }
  return { type: 'PrSummaryWritten', actor: 'conductor', data: written }
}

/** No summary was written this time (a lock, a failed run): the attempt is recorded, the PR goes on. */
export function summaryNotWrittenTransition(
  state: PrState,
  notWritten: PayloadOf<'PrSummaryNotWritten'>,
): ToAppend<PayloadOf<'PrSummaryNotWritten'>> | null {
  if (!walking(state)) return null
  return { type: 'PrSummaryNotWritten', actor: 'conductor', data: notWritten }
}

/**
 * The description on the code host now matches the log's (#1318). Appended even when the hash did not change, so what was
 * owed is not owed again; an ended PR has nothing to push to.
 */
export function descriptionPushedTransition(
  state: PrState,
  pushed: PayloadOf<'PrDescriptionPushed'>,
): ToAppend<PayloadOf<'PrDescriptionPushed'>> | null {
  if (!isOpen(state)) return null
  return { type: 'PrDescriptionPushed', actor: 'conductor', data: pushed }
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

/** One ticket's landing on a lane, as `landingsStarted` reads it; `base` is the success event's own, `null` otherwise. */
export interface LandingStarted {
  ticketId: string
  mergeCommit: string | null
  base: string | null
  /** The global order of the success event, `null` otherwise: which of a ticket's landings on two lanes is later. */
  seq: bigint | null
  unexpected: boolean
  headSha: string | null
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
export function landingsStarted(laneEvents: readonly Envelope[]): LandingStarted[] {
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
  const started: LandingStarted[] = []
  for (const [ticketId, e] of last) {
    const headSha = heads.get(ticketId) ?? null
    if (e.type === 'IntegrationAttempted')
      started.push({ ticketId, mergeCommit: null, base: null, seq: null, unexpected: false, headSha })
    if (e.type === 'IntegrationSucceeded') {
      started.push({
        ticketId,
        mergeCommit: (e.data as PayloadOf<'IntegrationSucceeded'>).mergeCommit,
        base: (e.data as PayloadOf<'IntegrationSucceeded'>).base,
        seq: e.seq,
        unexpected: false,
        headSha,
      })
    }
    if (e.type === 'IntegrationRefused' && (e.data as { reason?: string }).reason === 'unexpected') {
      started.push({ ticketId, mergeCommit: null, base: null, seq: null, unexpected: true, headSha })
    }
    // An earlier attempt left uncertain stays owed beside whatever the last event says: a retry's refusal
    // (`no-commits`, because the first push is already on the base) is no proof the first pushed nothing.
    for (const earlier of uncertain.get(ticketId) ?? []) {
      if (!started.some((x) => x.ticketId === ticketId && x.headSha === earlier)) {
        started.push({ ticketId, mergeCommit: null, base: null, seq: null, unexpected: true, headSha: earlier })
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
  if (!conflictOpen(state, round.merging, round.commit)) return null
  const used = state.rounds.filter((r) => r.merging === round.merging && r.commit === round.commit).length
  if (round.round !== used + 1) return null
  return { type: 'SyncRoundStarted', actor: 'conductor', data: round }
}

/**
 * Whether a conflict round may still be counted on this PR: walking, or In review for the merge back. A PR that was merged or
 * closed meanwhile is not, and **that is a refusal that will never lift** — a caller must stop, not read and try again.
 */
export const conflictOpen = (state: PrState, merging?: 'main' | 'back' | 'outside', commit?: string): boolean =>
  walking(state) ||
  state.status === 'in-review' ||
  // The catch-up's rounds (#1371): counted under `back` for `main`'s tip, never for a head this PR pushed.
  (state.status === 'merged' &&
    merging === 'back' &&
    commit !== undefined &&
    state.covers[commit] === undefined &&
    catchUpOwed(state))

/** A started round was refused (#1313): once per round, and only on a PR a round may still be counted on. */
export function syncRefusalTransition(
  state: PrState,
  refusal: PayloadOf<'SyncRoundRefused'>,
): ToAppend<PayloadOf<'SyncRoundRefused'>> | null {
  if (!conflictOpen(state, refusal.merging, refusal.commit)) return null
  const same = (r: { merging: string; commit: string; round: number }) =>
    r.merging === refusal.merging && r.commit === refusal.commit && r.round === refusal.round
  if (!state.rounds.some(same) || state.refusals.some(same)) return null
  return { type: 'SyncRoundRefused', actor: 'conductor', data: refusal }
}

/** The refusal of the latest refused round for a commit, from the log: what buys the next round, and what a spent end says. */
export const lastRefusalOf = (
  state: PrState,
  merging: 'main' | 'back' | 'outside',
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

/** A merged PR whose catch-up failed on something a person can answer: rounds or a retry are accepted. */
export const catchUpWaits = (state: PrState): boolean =>
  state.status === 'merged' &&
  state.catchUp?.outcome === 'failed' &&
  (state.catchUp.why === 'conflict' || state.catchUp.why === 'red' || state.catchUp.why === 'lost-push') &&
  !state.catchUp.released

/** The rounds a person gave for one commit: the sum of the grants that name it. */
export const grantedFor = (state: PrState, merging: 'main' | 'back' | 'outside', commit: string): number =>
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
  grant: { by: string; merging: 'main' | 'back' | 'outside'; commit: string },
): PrRequest<PayloadOf<'PrRoundsGranted'>> {
  const waitingOnCatchUp = mode === 'team' && state !== null && state.n !== null && catchUpWaits(state)
  const no = waitingOnCatchUp && state?.pending === null ? null : notAskable(state, mode, project)
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
  if (waitingOnCatchUp && state.catchUp !== null && (state.catchUp.why === 'conflict' || state.catchUp.why === 'red')) {
    if (grant.merging !== 'back' || grant.commit !== state.catchUp.mainSha) {
      return refused(
        `${name} now waits on the catch-up with main at ${state.catchUp.mainSha.slice(0, 7)}, not ${grant.commit.slice(0, 7)}: read it again`,
      )
    }
    return granted
  }
  if (state.status !== 'waiting' || state.wait === null)
    return refused(`${name} is ${state.status}, not waiting on you`)
  if (
    state.wait.reason !== 'sync-conflict' &&
    state.wait.reason !== 'outside-conflict' &&
    state.wait.reason !== 'outside-red'
  ) {
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
      `${name} now waits on ${conflict.merging === 'main' ? 'main' : conflict.merging === 'outside' ? 'the commits others pushed' : 'the merge back'} at ${conflict.commit.slice(0, 7)}, not ${grant.commit.slice(0, 7)}: read it again`,
    )
  }
  return granted
}

/**
 * *Replace the summary* (#1318): refused by name on a solo project, with no PR, and on a PR that ended — there is nothing open
 * to push to. A stale page still replaces it: the person's latest words are the summary.
 */
export function summaryEditTransition(
  state: PrState | null,
  mode: 'solo' | 'team',
  project: string,
  edit: { by: string; summary: string },
): PrRequest<PayloadOf<'PrSummaryEdited'>> {
  if (mode === 'solo') return refused(`${project} lands on its main branch itself; there is no PR`)
  if (state === null || state.n === null) return refused(`${project} has no PR`)
  if (!isOpen(state)) {
    return refused(`${prName(project, state.n)} is ${state.status}; there is nothing open to push a summary to`)
  }
  const summary = edit.summary.trim()
  if (summary === '') return refused('the summary is empty')
  return { kind: 'request', event: { type: 'PrSummaryEdited', actor: edit.by, data: { by: edit.by, summary } } }
}

/** *Check again* (#1314): refused by name on a solo project, with no PR open, and on a PR that is not waiting. */
export function retryRequestTransition(
  state: PrState | null,
  mode: 'solo' | 'team',
  project: string,
  by: string,
): PrRequest<PayloadOf<'PrRetryRequested'>> {
  const waitingOnCatchUp = mode === 'team' && state !== null && state.n !== null && catchUpWaits(state)
  const no = waitingOnCatchUp && state?.pending === null ? null : notAskable(state, mode, project)
  if (no !== null) return no
  if (state === null || state.n === null) return refused(`${project} has no PR open`)
  if (!waitingOnCatchUp && state.status !== 'waiting') {
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
