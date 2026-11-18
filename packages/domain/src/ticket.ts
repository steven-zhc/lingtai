/**
 * The WorkItem aggregate: `ticket-{project}-{n}`, alive for weeks.
 *
 * The failure this replaces is specific. In the old loop a ticket's state was
 * the set of `agent:*` labels on its GitHub issue, and `--add-label` is set
 * union, not a transition — nothing forbade a contradictory pair and nothing
 * reconciled one. #35 carried `agent:blocked` **and** `agent:review` at the same
 * time, and no code was wrong; the model was.
 *
 * So `lifecycle` here is a discriminated union rather than a bag of flags. There
 * is no value of `TicketState` in which an item is both claimed and blocked,
 * because there is no way to write one down. The facts that outlive a
 * transition — title, labels, links — sit outside the union, where they belong.
 *
 * One thing this reducer deliberately cannot see: gates, approvals and merges.
 * Those are events on the Run and Integration streams, because a run emits
 * hundreds of events while a work item lives for weeks and one stream would make
 * every read expensive (design.md §4). The lifecycle drawn in design.md §4 spans
 * all three aggregates; assembling it is the board projection's job, not this
 * function's.
 */
import type { WaitId } from './action.ts'
import { claimShapeOf } from './claims.ts'
import type { Envelope, ToAppend } from './envelope.ts'
import {
  parsePayload,
  type PayloadOf,
  type ReleaseCause,
  type SplitChild,
  type Tier,
  type TriageStartedBy,
} from './events.ts'
import { actionFor, type CauseAction, type CauseBound, type CauseCounter, type CauseOrigin } from './failure/respond.ts'
import { agentBranchOf, isTicketStream, parseTicketStream } from './streams.ts'
import { waitWords } from './wait-words.ts'
import { allowedResolutions, type Resolution, type TriageResult, type WaitReason } from './wait.ts'

/** How an attempt ended: the later of a release and a question put to a person (D13). */
export type AttemptEnding =
  | { readonly kind: 'released'; readonly reason: string; readonly cause: ReleaseCause | null }
  | { readonly kind: 'asked'; readonly reason: WaitReason }

/** A chat held on a ticket, with how its latest `DiscussionHeld` ended (#843). */
export interface TicketDiscussion {
  readonly chatId: string
  readonly outcome: PayloadOf<'DiscussionHeld'>['outcome']
}

/**
 * One wait, reduced once (#842). `waitsOf`, `triageFactsOf`, `personAsksOf`, the
 * CLI's triage and `editEndedWaits` all read this rather than scanning the stream.
 */
export interface TicketWait {
  readonly waitId: WaitId
  readonly reason: WaitReason
  /** The `WaitStarted`'s own `at`. */
  readonly at: Date
  /** The first `WaitResolved` naming this wait. */
  readonly resolution: {
    readonly resolution: Resolution
    readonly by: string
    /** The `WaitResolved`'s global seq, so a spend can be told apart from one an attempt's counter already holds (#1258). */
    readonly seq?: number
  } | null
  readonly triage: {
    /** The latest `TriageStarted` by attempt. */
    readonly started: { readonly attempt: number; readonly at: Date; readonly by: TriageStartedBy } | null
    /** The first `WaitTriaged` for that attempt. */
    readonly result: TriageResult | null
    /** That `WaitTriaged`'s `headSha`. */
    readonly headSha: string | null
  }
  /** The first `TicketLanded` while this is the latest wait. */
  readonly landed: { readonly mergeCommit: string; readonly base: string } | null
  /** The first `TicketClosed` while this is the latest wait. */
  readonly closed: { readonly by: string } | null
}

/**
 * The waits rule, once. Called for every event before `closed` absorbs anything,
 * so a closed ticket's waits read as a scan of its stream reads them.
 */
export function reduceWaits(waits: readonly TicketWait[], event: Envelope): readonly TicketWait[] {
  switch (event.type) {
    case 'WaitStarted': {
      const d = event.data as PayloadOf<'WaitStarted'>
      return [
        ...waits,
        {
          waitId: d.waitId,
          reason: d.reason,
          at: event.at,
          resolution: null,
          triage: { started: null, result: null, headSha: null },
          landed: null,
          closed: null,
        },
      ]
    }
    case 'WaitResolved': {
      const d = event.data as PayloadOf<'WaitResolved'>
      return waits.map((w) =>
        w.waitId === d.waitId && w.resolution === null
          ? { ...w, resolution: { resolution: d.resolution, by: d.by, seq: Number(event.seq) } }
          : w,
      )
    }
    case 'TriageStarted': {
      const d = event.data as PayloadOf<'TriageStarted'>
      return waits.map((w) =>
        w.waitId === d.waitId && d.attempt > (w.triage.started?.attempt ?? 0)
          ? {
              ...w,
              triage: { started: { attempt: d.attempt, at: event.at, by: d.by }, result: null, headSha: null },
            }
          : w,
      )
    }
    case 'WaitTriaged': {
      const d = event.data as PayloadOf<'WaitTriaged'>
      return waits.map((w) =>
        w.waitId === d.waitId && w.triage.started?.attempt === d.attempt && w.triage.result === null
          ? { ...w, triage: { ...w.triage, result: d.result, headSha: d.headSha } }
          : w,
      )
    }
    case 'TicketLanded': {
      const d = event.data as PayloadOf<'TicketLanded'>
      const i = waits.length - 1
      return i < 0 || waits[i]!.landed !== null
        ? waits
        : waits.map((w, j) => (j === i ? { ...w, landed: { mergeCommit: d.mergeCommit, base: d.base } } : w))
    }
    case 'TicketClosed': {
      const d = event.data as PayloadOf<'TicketClosed'>
      const i = waits.length - 1
      return i < 0 || waits[i]!.closed !== null
        ? waits
        : waits.map((w, j) => (j === i ? { ...w, closed: { by: d.by } } : w))
    }
    default:
      return waits
  }
}

export interface TicketClaim {
  readonly runId: string
  readonly at: Date
  /** Whichever of a `TicketReleased` for this run or a `WaitStarted` naming it came later (D13). Null while held. */
  readonly ended: AttemptEnding | null
}

export type TicketLifecycle =
  | { status: 'backlog' }
  /**
   * Held. There is no expiry in this shape and that is the whole of 0027: a
   * reduce cannot read a clock, so a lifecycle that lapsed on its own would make
   * `lingtai projection rebuild task_view` disagree with the incremental reduce.
   * What returns a claim is a `TicketReleased`, appended by a conductor that
   * holds the lock.
   */
  | { status: 'claimed'; runId: string; worker: string }
  | {
      status: 'blocked'
      /** This wait's own id — `WaitTriaged`/`WaitResolved` are keyed by it (0118 §1). */
      waitId: WaitId
      /** The `WaitReason` this block is, since #502 — what the event actually carries. */
      reason: WaitReason
      /**
       * The run that asked, or null for a question asked before any run
       * (`lingtai ask`, #147) — which spends no claim and no worktree, and is
       * passed over by the queue because this state is not `backlog`.
       */
      runId: string | null
      /**
       * Whether a person's judgement is required, or a failure needs
       * acknowledging. Two opposite kinds of hold that were one event with a
       * string on it (#83). Null on a block written before the field existed.
       */
    }
  | { status: 'landed'; mergeCommit: string; base: string }
  /**
   * Nobody is going to do this (#151). A terminal like `landed`, and like it
   * nothing lifts it — reopening the issue starts no work, and the answer to
   * wanting it again is a new ticket.
   */
  | { status: 'closed'; by: string; reason: string }
  /**
   * `WaitResolved{Approve}` landed, and the run it approved has not yet
   * been reclaimed to continue (#465, 0118 §11). Not `blocked` — the
   * question is answered — and not `backlog` either: the queue must not
   * cut a fresh pass for this item while the run it already spent is owed
   * a continuation. `continueTicket` (`claim.ts`) is the only way out,
   * onto the same `runId`.
   */
  | { status: 'approved'; runId: string; waitId: WaitId; onSha: string; grantRef?: string }

export type TicketStatus = TicketLifecycle['status']

/**
 * An approach this ticket abandoned, as `TicketReleased{cause: Restart}`
 * records it (#502). `after` is the pass whose rounds were spent, not the
 * pass that will try the next approach — the second does not exist yet when
 * this is written down.
 *
 * **What `PassRestarted` also carried — the branch, its head, the findings
 * still live — is not repeated here.** It is on the previous run's own
 * stream, which the next prompt already reads (`attempts.ts`'s `lastRun`),
 * so there is no second copy to keep in step with it.
 */
export interface NewAttemptRecord {
  after: string
  newAttempt: number
}

/**
 * A block a person answered, and what they answered it with.
 *
 * `WaitResolved.note` reached no state before #147: a replay could say what
 * was asked and never what was decided. `question` and `runId` are the block's,
 * copied at the moment it was answered, because the lifecycle that held them is
 * replaced by the answer — and null only for an unblock the log holds without a
 * block before it, which no appender writes.
 */
export interface AnswerRecord {
  question: string | null
  /** Null when the question was asked before any run — `lingtai ask`. */
  runId: string | null
  answer: string
  by: string
}

/** How this item is connected to another — a filed bug to the merge that caused it. */
export interface WorkItemLink {
  relation: 'caused-by' | 'follows-up' | 'duplicates'
  otherRef: string
}

type IssueChange = PayloadOf<'IssueUpdated'>['change']

/** The last word Lingtai had from GitHub about one kind of write. */
export interface GitHubWrite {
  readonly outcome: 'updated' | 'failed'
  /** `detail` of an `IssueUpdated`, `error` of an `IssueUpdateFailed`. */
  readonly text: string
}

/** What Lingtai last wrote to GitHub about this issue (#832, D9). */
export interface GitHubLedger {
  /** The last word per change, `comment-edited` included. */
  readonly last: Partial<Record<IssueChange, GitHubWrite>>
  /** What the last `labels` write GitHub accepted set, or null if none did. */
  readonly labels: readonly string[] | null
  /** Every accepted waiting comment that names a wait and an all-digit comment id, in order. */
  readonly comments: readonly { readonly waitId: WaitId; readonly commentId: number; readonly question: string }[]
  /** Every wait whose comment an edit was attempted for, either outcome. */
  readonly edited: readonly WaitId[]
  /** The last `WaitStarted`'s wait id. */
  readonly lastWait: WaitId | null
  /** `lastWait` as it stood when the last `body` write was reduced: the wait that write came after. */
  readonly bodyAfterWait: WaitId | null
}

export interface TicketState {
  lifecycle: TicketLifecycle

  /** From the stream id (D4); null only on a stream that is not a ticket's. */
  project: string | null
  source: 'github-issue' | 'manual' | 'agent-followup' | null
  externalRef: string | null
  title: string | null
  /** Whatever label the recipe's `source.kinds` matched. Latest non-null of `TicketClaimed` and `TicketDiscovered`. */
  kind: string | null
  labels: readonly string[]

  links: readonly WorkItemLink[]

  /**
   * What the last `TicketSplit` recorded, or null. **The only list of a split's
   * children** a close rule may read: the body and GitHub's sub-issue list can
   * both be edited by a person after the fact (#604). Deliberately not a
   * lifecycle event — `closed` absorbs exactly `LIFECYCLE_EVENTS`.
   */
  split: { waitId: WaitId; children: readonly SplitChild[] } | null

  /**
   * Every dispatch the scheduler refused, kept rather than counted. A tier is
   * never silently downgraded, so the refusals are the record of what could not
   * run and why.
   */
  dispatchRefusals: readonly { requiredTier?: Tier; runtime: string; missing: readonly string[] }[]

  /** Runs that have held this item, oldest first. A re-run appends. */
  runs: readonly string[]
  /**
   * One per fresh claim, oldest first — an attempt (D13). A continuation of a
   * held run is not one, and neither is a claim after `closed`.
   */
  claims: readonly TicketClaim[]
  /** The `at` of the last claim or continuation, an unclaimed run's continuation included (D11). */
  lastAttemptAt: Date | null
  /** The `at` of the last lifecycle event the reducer applied, else of the stream's first event (D11). */
  since: Date | null
  /**
   * The last person's move on a wait, and what followed it (#831). The board's
   * *After the move* block reads this and nothing else.
   */
  lastMove: {
    readonly waitId: WaitId
    readonly resolution: Resolution
    readonly by: string
    readonly note: string
    /**
     * True from the move until anything else moves the ticket: a `WaitStarted`, a claim or a
     * continuation, a landing, or a second close or release. The move's own first close or
     * release does not end it.
     */
    readonly current: boolean
    /** The first close or release after the move, while it is current. */
    readonly then:
      | { readonly kind: 'closed'; readonly reason: string }
      | { readonly kind: 'released'; readonly reason: string; readonly cause: ReleaseCause | null }
      | null
  } | null

  /**
   * Every approach this item has abandoned, oldest first
   * ([0040](../../../doc/decisions-archive/0040-rounds-bound-depth-restarts-bound-breadth.md)).
   *
   * **The ceiling is counted here rather than remembered anywhere**, which is
   * the shape `repairs` had before `#143` deleted it: a length against a number
   * from the recipe is structural rather than aspirational, a rebuild
   * recomputes it, and there is no counter to forget to increment.
   *
   * There is deliberately no `pendingRestart`. A restart is told nothing extra:
   * `attempts.ts` already writes the abandoned branch, its sha and the findings
   * into every second prompt, so the next claim is an ordinary pass and the
   * only thing this list decides is whether there is one left to buy. The one
   * thing that ever needed a pending record was a repair, because the next
   * claim had to *become* one — and nothing buys a repair any more (0039
   * §Consequences).
   */
  newAttempts: readonly NewAttemptRecord[]

  /**
   * A sentence somebody added for the next run, and not yet consumed.
   *
   * The whole of how a `PromptEdited` reaches an agent
   * ([0032](../../../doc/decisions-archive/0032-the-page-is-organised-by-attempt.md)
   * §5). It applies to the **next run only**, whoever starts it — the next
   * `TicketClaimed` clears it.
   *
   * One-shot rather than durable, and that removes a failure mode rather than
   * mitigating one: a lasting override would need the page to guard against a
   * stale instruction being sent unseen, and something meant to last belongs in
   * the GitHub ticket where everybody can see it (§6).
   */
  pendingPrompt: { text: string; by: string } | null

  /**
   * Every block a person answered, oldest first (#147).
   *
   * **Durable, unlike `pendingPrompt`**, and that is the difference between an
   * edit and a decision. An edit is a sentence for one attempt; an answer to a
   * question asked before any run is a decision about the ticket, and every
   * attempt at it is owed it — `nextPrompt` carries those, so the answer
   * reaches the agent without anybody editing the GitHub issue body.
   */
  answers: readonly AnswerRecord[]

  /**
   * What Lingtai wrote to GitHub (`IssueUpdated`/`IssueUpdateFailed`). These
   * are not lifecycle events, so they reduce on a closed ticket too.
   */
  github: GitHubLedger

  /** Every wait, oldest first, with its triage, resolution and ending (#842). */
  waits: readonly TicketWait[]

  /**
   * Every chat held on this ticket, in the order each was first held, with its
   * latest outcome (#843). Not a lifecycle fact, so a closed ticket keeps
   * reducing it too.
   */
  discussions: readonly TicketDiscussion[]

  /** Version of the last event applied — the `expectedVersion` for the next append. */
  version: number
  /** Global position of the last event applied. */
  lastSeq: bigint | null
}

export const emptyTicket: TicketState = {
  lifecycle: { status: 'backlog' },
  project: null,
  source: null,
  externalRef: null,
  title: null,
  kind: null,
  labels: [],
  links: [],
  split: null,
  dispatchRefusals: [],
  runs: [],
  claims: [],
  lastAttemptAt: null,
  since: null,
  lastMove: null,
  newAttempts: [],
  pendingPrompt: null,
  answers: [],
  github: { last: {}, labels: null, comments: [], edited: [], lastWait: null, bodyAfterWait: null },
  waits: [],
  discussions: [],
  version: 0,
  lastSeq: null,
}

/**
 * The events that move the lifecycle, as a set rather than as knowledge spread
 * across the switch below — because `closed` has to absorb exactly these and
 * nothing else, and a list you can read is the only way that stays true when a
 * seventh transition is added.
 */
export const LIFECYCLE_EVENTS: ReadonlySet<string> = new Set([
  'TicketClaimed',
  'TicketContinued',
  'TicketReleased',
  'WaitStarted',
  'WaitResolved',
  'TicketLanded',
  'TicketClosed',
])

function endClaim(claims: readonly TicketClaim[], runId: string, ended: AttemptEnding): readonly TicketClaim[] {
  return claims.map((c) => (c.runId === runId ? { ...c, ended } : c))
}

export function reduceTicketEvent(prior: TicketState, event: Envelope): TicketState {
  // D4: a ticket's project and issue are its stream's, whatever the event.
  const own = prior.project === null && isTicketStream(event.streamId) ? parseTicketStream(event.streamId) : null
  const waits = reduceWaits(prior.waits, event)
  const base = {
    ...(own === null ? prior : { ...prior, project: own.project, externalRef: own.issue }),
    waits,
  }
  // D11: a stream's first event is where `since` starts; a lifecycle event moves it.
  // `WaitResolved` has several returns, so it moves `since` here; the guard below
  // puts it back, because `closed` absorbs it.
  const stated = base.since === null || event.type === 'WaitResolved' ? { ...base, since: event.at } : base
  const at = { version: event.version, lastSeq: event.seq }

  /**
   * **`closed` is absorbing** (#151). Nothing lifts it: not an unblock, which
   * the board's Requeue and `lingtai answer` both append, and not a claim.
   *
   * Written here rather than as a guard in each case, because the property is
   * about the *state* and not about any one event — and a case that forgot it
   * would resurrect a ticket silently, handing the next attempt the findings and
   * the spend of work done under an intent that is no longer the intent.
   *
   * The facts that outlive a transition — title, labels, links — still apply, so
   * a closed item's card does not go stale; only its lifecycle is settled.
   */
  if (stated.lifecycle.status === 'closed' && LIFECYCLE_EVENTS.has(event.type)) {
    return { ...stated, ...at, since: prior.since ?? event.at }
  }

  // #831: any lifecycle event other than the move itself ends the move, except the first
  // close or release it caused, which is what followed it. `closed` returned above, so a
  // claim after a close never gets here (D6).
  const m = stated.lastMove
  const ended: Pick<TicketState, 'lastMove'> =
    m === null || !LIFECYCLE_EVENTS.has(event.type) || event.type === 'WaitResolved'
      ? { lastMove: m }
      : m.current && m.then === null && event.type === 'TicketClosed'
        ? { lastMove: { ...m, then: { kind: 'closed', reason: (event.data as PayloadOf<'TicketClosed'>).reason } } }
        : m.current && m.then === null && event.type === 'TicketReleased'
          ? {
              lastMove: {
                ...m,
                then: {
                  kind: 'released',
                  reason: (event.data as PayloadOf<'TicketReleased'>).reason,
                  cause: (event.data as PayloadOf<'TicketReleased'>).cause ?? null,
                },
              },
            }
          : { lastMove: { ...m, current: false } }
  const state = { ...stated, ...ended }

  switch (event.type) {
    case 'TicketDiscovered': {
      const d = event.data as PayloadOf<'TicketDiscovered'>
      return {
        ...state,
        ...at,
        source: d.source,
        title: d.title ?? state.title,
        kind: d.kind ?? state.kind,
        labels: d.labels,
      }
    }

    case 'TicketContinued':
    case 'TicketClaimed': {
      const d = event.data as PayloadOf<'TicketClaimed'>
      // One rule for both forms (`claims.ts`). A continuation of a run nobody
      // claimed continues nothing and records nothing.
      const shape = claimShapeOf(event, state.runs)
      if (shape === 'continuation' && !state.runs.includes(d.runId)) {
        return { ...state, ...at, lastAttemptAt: event.at, since: event.at }
      }
      return {
        ...state,
        ...at,
        claims: shape === 'claim' ? [...state.claims, { runId: d.runId, at: event.at, ended: null }] : state.claims,
        lastAttemptAt: event.at,
        since: event.at,
        // Replaces whatever lifecycle was there. A claim while blocked is not an
        // error to represent — it is the unblock-and-retry path — and it cannot
        // leave the block behind, because the union has room for only one.
        lifecycle: {
          status: 'claimed',
          runId: d.runId,
          worker: d.worker,
        },
        runs: state.runs.includes(d.runId) ? state.runs : [...state.runs, d.runId],
        // The claim consumes whatever sentence a person added for the next run:
        // `PromptEdited` applies to one run, and this is the run (0032 §5).
        //
        // It used to consume a *pending repair* here too, and that clause is the
        // one `#143` deleted. `RepairRequested` is retired, so nothing puts a
        // repair on an item and no claim can become one — a log that still holds
        // the event reduces through the default below and changes nothing but the
        // version.
        pendingPrompt: null,
        // A `TicketContinued` has no title or kind, and a claim that carries
        // nulls must not blank what an earlier one named.
        title: event.type === 'TicketClaimed' ? (d.title ?? state.title) : state.title,
        kind: event.type === 'TicketClaimed' ? (d.kind ?? state.kind) : state.kind,
      }
    }

    case 'PromptEdited': {
      const d = event.data as PayloadOf<'PromptEdited'>
      // The lifecycle is untouched. An edit is about *what to do*, not about
      // which state the item is in — the next claim is what consumes it, and a
      // second edit before that claim replaces the first rather than stacking:
      // two sentences nobody re-read is a prompt nobody approved.
      //
      // **Blank is the removal**, which is why the page's *Remove the edit* is
      // an append and not a deletion. It also closes a gap the version had: an
      // edit of nothing but whitespace produced no block in the prompt —
      // `humanBrief` trims — and still a `human@…` in `promptVersion`, so the
      // log claimed a difference the agent was never told about.
      return {
        ...state,
        ...at,
        pendingPrompt: d.text.trim() === '' ? null : { text: d.text, by: d.by },
      }
    }

    case 'TicketReleased': {
      const d = event.data as PayloadOf<'TicketReleased'>
      // The only way back to the queue. A claim does not lapse (0027), so every
      // return is an append somebody made — including the one a conductor makes
      // at startup for a claim its predecessor died holding.
      //
      // A `Restart` cause also records the abandoned arm (#502 — `PassRestarted`
      // used to do this, on the run that spent its rounds, immediately before
      // this same release).
      return {
        ...state,
        ...at,
        lifecycle: { status: 'backlog' },
        since: event.at,
        // A red base is not a failure of this ticket, whether it was found before an agent ran or after the
        // build refused its work, so the backoff does not count it: the base decides when it is taken again
        // (#1208), and `lastAttemptAt` is what every reader of the backoff reads.
        ...(d.cause?._tag === 'BaseRed' ? { lastAttemptAt: null } : {}),
        claims: endClaim(state.claims, d.runId, { kind: 'released', reason: d.reason, cause: d.cause ?? null }),
        newAttempts:
          d.cause?._tag === 'NewAttempt'
            ? [...state.newAttempts, { after: d.runId, newAttempt: d.cause.newAttempt }]
            : state.newAttempts,
      }
    }

    case 'WaitStarted': {
      const d = event.data as PayloadOf<'WaitStarted'>
      // `state.externalRef` rather than re-parsing the stream id (`#502`'s
      // `read-model.ts` has no aggregate to read it off and does that
      // instead): null only on a stream that is not a ticket's.
      return {
        ...state,
        ...at,
        since: event.at,
        claims:
          'run' in d.reason
            ? endClaim(state.claims, d.reason.run.runId, { kind: 'asked', reason: d.reason })
            : state.claims,
        lifecycle: {
          status: 'blocked',
          waitId: d.waitId,
          reason: d.reason,
          runId: 'run' in d.reason ? d.reason.run.runId : null,
        },
        github: { ...state.github, lastWait: d.waitId },
      }
    }

    case 'IssueUpdated': {
      const d = event.data as PayloadOf<'IssueUpdated'>
      const g = state.github
      const waitId = d.waitId as WaitId | undefined
      return {
        ...state,
        ...at,
        github: {
          ...g,
          last: { ...g.last, [d.change]: { outcome: 'updated', text: d.detail } },
          labels: d.change === 'labels' ? (d.detail ? d.detail.split(',').filter(Boolean) : []) : g.labels,
          comments:
            d.change === 'comment' && waitId !== undefined && /^\d+$/.test(d.detail)
              ? [...g.comments, { waitId, commentId: Number(d.detail), question: d.question ?? '' }]
              : g.comments,
          edited: d.change === 'comment-edited' && waitId !== undefined ? [...g.edited, waitId] : g.edited,
          bodyAfterWait: d.change === 'body' ? g.lastWait : g.bodyAfterWait,
        },
      }
    }

    case 'IssueUpdateFailed': {
      const d = event.data as PayloadOf<'IssueUpdateFailed'>
      const g = state.github
      const waitId = d.waitId as WaitId | undefined
      return {
        ...state,
        ...at,
        github: {
          ...g,
          last: { ...g.last, [d.change]: { outcome: 'failed', text: d.error } },
          edited: d.change === 'comment-edited' && waitId !== undefined ? [...g.edited, waitId] : g.edited,
          bodyAfterWait: d.change === 'body' ? g.lastWait : g.bodyAfterWait,
        },
      }
    }

    case 'WaitResolved': {
      const d = event.data as PayloadOf<'WaitResolved'>
      // The answer is kept, and that is the whole of #147's reducer change: this
      // case used to return to the backlog and drop `note` on the floor, so the
      // log held the decision and no state, projection or prompt could say it.
      const block = state.lifecycle.status === 'blocked' ? state.lifecycle : null
      // #831: `current` is read off the lifecycle before this event changes it.
      const lastMove = {
        waitId: d.waitId,
        resolution: d.resolution,
        by: d.by,
        note: d.note,
        current: block !== null && block.waitId === d.waitId,
        then: null,
      }
      // A question withdrawn was never answered (an `OwnQuestion` resolved by
      // `StartNewAttempt` rather than `AnswerQuestion`), so there is nothing to keep:
      // the item is back in the backlog and no attempt is told anything.
      if (d.resolution._tag === 'StartNewAttempt' && block?.reason._tag === 'OwnQuestion') {
        return { ...state, ...at, lastMove, lifecycle: { status: 'backlog' } }
      }
      // **`Approve` moves to `approved`** (#465) — a continuation is owed,
      // not a fresh claim, and `block.runId` is never null here:
      // `allowedResolutions` offers `Approve` for no `WaitReason` that lacks
      // a run.
      if (
        (d.resolution._tag === 'Approve' || d.resolution._tag === 'FixRefusal' || d.resolution._tag === 'RedoStep') &&
        block !== null
      ) {
        return {
          ...state,
          ...at,
          lastMove,
          lifecycle: {
            status: 'approved',
            runId: block.runId!,
            waitId: block.waitId,
            onSha: d.resolution.onSha,
            ...(d.resolution._tag === 'FixRefusal' ? { grantRef: d.resolution.ref } : {}),
          },
        }
      }
      // `Close` does not return the item to the backlog on its own —
      // `TicketClosed` (`close.ts`) says what actually happened — so only
      // the resolutions that are themselves a requeue move the lifecycle
      // here.
      if (
        d.resolution._tag !== 'StartNewAttempt' &&
        d.resolution._tag !== 'EditBodyAndStartNewAttempt' &&
        d.resolution._tag !== 'AnswerQuestion' &&
        d.resolution._tag !== 'Split'
      ) {
        return { ...state, ...at, lastMove }
      }
      return {
        ...state,
        ...at,
        lastMove,
        lifecycle: { status: 'backlog' },
        answers: [
          ...state.answers,
          {
            question:
              block === null
                ? null
                : waitWords(block.reason, {
                    branch: state.externalRef === null ? '' : agentBranchOf(state.externalRef),
                    base: '',
                    findings: [],
                  }).line,
            runId: block?.runId ?? null,
            answer: d.note,
            by: d.by,
          },
        ],
      }
    }

    case 'TicketSplit': {
      const d = event.data as PayloadOf<'TicketSplit'>
      return { ...state, ...at, split: { waitId: d.waitId, children: d.children } }
    }

    case 'TicketLinked': {
      const d = event.data as PayloadOf<'TicketLinked'>
      const already = state.links.some((l) => l.relation === d.relation && l.otherRef === d.otherRef)
      return { ...state, ...at, links: already ? state.links : [...state.links, d] }
    }

    case 'DiscussionHeld': {
      const d = event.data as PayloadOf<'DiscussionHeld'>
      const known = state.discussions.some((x) => x.chatId === d.chatId)
      const discussions = known
        ? state.discussions.map((x) => (x.chatId === d.chatId ? { chatId: x.chatId, outcome: d.outcome } : x))
        : [...state.discussions, { chatId: d.chatId, outcome: d.outcome }]
      return { ...state, ...at, discussions }
    }

    case 'TicketClosed': {
      const d = event.data as PayloadOf<'TicketClosed'>
      return { ...state, ...at, since: event.at, lifecycle: { status: 'closed', by: d.by, reason: d.reason } }
    }

    case 'TicketLanded': {
      const d = event.data as PayloadOf<'TicketLanded'>
      return {
        ...state,
        ...at,
        since: event.at,
        lifecycle: { status: 'landed', mergeCommit: d.mergeCommit, base: d.base },
      }
    }

    case 'DispatchRefused': {
      const d = event.data as PayloadOf<'DispatchRefused'>
      return { ...state, ...at, dispatchRefusals: [...state.dispatchRefusals, d] }
    }

    default:
      // Unknown to this build, or belonging to another aggregate. Ignored rather
      // than rejected: a projection compiled against an older catalogue has to
      // survive a newer conductor's events instead of wedging on the first one.
      //
      // Note where the real forward-compatibility boundary sits. `@lingtai/event-store`
      // currently *throws* on an event type it does not recognise, so in practice
      // it refuses one before a reducer ever sees it. This tolerance is what
      // makes the reducer itself safe to reuse — over a replay, a fixture, or a
      // relaxed reader — not a claim that the whole pipeline is tolerant today.
      return { ...state, ...at }
  }
}

export function reduceTicket(events: readonly Envelope[]): TicketState {
  return events.reduce(reduceTicketEvent, emptyTicket)
}

/** How one recorded child of a split stands on GitHub. `stateReason` null is *not reported*, never *completed*. */
export interface SplitChildState {
  number: number
  stateReason: 'completed' | 'not_planned' | null
}

/** What a claim learned about a split's children: not asked, unreadable, or read. */
export type SplitChildren =
  | null
  | { readonly unreadable: string }
  | { readonly read: readonly { number: number; state: string; stateReason?: 'completed' | 'not_planned' | null }[] }

/** Why a claim is refused by the ticket's own state. A lost race is a fact about the append, not here. */
export type ClaimDecline =
  | { reason: 'held'; by: string; runId: string }
  | { reason: 'not-claimable'; status: string }
  | { reason: 'split-done'; version: number; waitId: string; children: SplitChildState[] }
  | { reason: 'split-open'; open: number[] }
  | { reason: 'split-unreadable'; detail: string }

/** The claim: `TicketClaimed`, or why the ticket cannot be claimed. */
export function claimTransition(
  state: TicketState,
  input: {
    runId: string
    worker: string
    title?: string | null
    kind?: string | null
    body?: string
    children: SplitChildren
  },
): { ok: true; events: ToAppend<PayloadOf<'TicketClaimed'>>[] } | { ok: false; refusal: ClaimDecline } {
  const life = state.lifecycle
  // Held is held. There is no expiry to fall through to (0027).
  if (life.status === 'claimed') {
    return { ok: false, refusal: { reason: 'held', by: life.worker, runId: life.runId } }
  }
  if (life.status !== 'backlog') return { ok: false, refusal: { reason: 'not-claimable', status: life.status } }

  if (state.split !== null && input.children !== null) {
    if ('unreadable' in input.children) {
      return { ok: false, refusal: { reason: 'split-unreadable', detail: input.children.unreadable } }
    }
    const read = input.children.read
    const open = read.filter((i) => i.state !== 'closed').map((i) => i.number)
    if (open.length > 0) return { ok: false, refusal: { reason: 'split-open', open } }
    return {
      ok: false,
      refusal: {
        reason: 'split-done',
        version: state.version,
        waitId: state.split.waitId,
        children: read.map((i) => ({ number: i.number, stateReason: i.stateReason ?? null })),
      },
    }
  }

  return {
    ok: true,
    events: [
      {
        type: 'TicketClaimed',
        actor: 'conductor',
        data: parsePayload('TicketClaimed', {
          runId: input.runId,
          worker: input.worker,
          title: input.title ?? null,
          kind: input.kind ?? null,
          ...(input.body !== undefined ? { body: input.body } : {}),
        }),
      },
    ],
  }
}

/** The causes of a release whose attempt the next claim continues rather than restarts (#1205, #1211). */
export const CONTINUABLE_CAUSES: readonly ReleaseCause['_tag'][] = ['AccountLimit', 'BaseRed']

/**
 * The release the ticket's newest claim ended in, when its cause is one the next claim continues — else null.
 * Pure, so the claim's own read and the owner's continue transition ask the same question.
 */
export function continuableRelease(state: Pick<TicketState, 'claims'>): { runId: string; cause: ReleaseCause } | null {
  const last = state.claims.at(-1)
  const ended = last?.ended
  if (last === undefined || ended == null || ended.kind !== 'released' || ended.cause === null) return null
  return CONTINUABLE_CAUSES.includes(ended.cause._tag) ? { runId: last.runId, cause: ended.cause } : null
}

/**
 * How many times the ticket was released with `cause` on `runId`: this continuation's number among the attempt's,
 * which is what keeps each one's dispatch id its own (#1205, #1211). Counted off the stream the owner holds
 * rather than a new event.
 */
export function releasesOf(
  ticketEvents: readonly Envelope[],
  runId: string,
  cause: 'AccountLimit' | 'BaseRed',
): number {
  return ticketEvents.filter((event) => {
    if (event.type !== 'TicketReleased') return false
    const d = event.data as PayloadOf<'TicketReleased'>
    return d.runId === runId && d.cause?._tag === cause
  }).length
}

/** `releasesOf` for an account limit: this rerun's number among the attempt's reruns (#1205). */
export function accountLimitReleases(ticketEvents: readonly Envelope[], runId: string): number {
  return releasesOf(ticketEvents, runId, 'AccountLimit')
}

export type ContinueDecline =
  /** Neither `approved` nor queued on a release the next claim continues (#1205) — a requeue, a second approval, a close, all land between the approval and this claim. */
  | { reason: 'not-approved'; status: string }
  /** Approved, or released, onto a different run than the one this call means to continue. */
  | { reason: 'wrong-run'; runId: string }

/** The continuation: `TicketContinued` for the run approved, or why not. */
export function continueTransition(
  state: TicketState,
  input: { runId: string; worker: string; body?: string },
): { ok: true; events: ToAppend<PayloadOf<'TicketContinued'>>[] } | { ok: false; refusal: ContinueDecline } {
  const life = state.lifecycle
  if (life.status === 'backlog') {
    // A queued ticket whose last release names this run (#1205): the same attempt, taken again.
    const released = continuableRelease(state)
    if (released === null) return { ok: false, refusal: { reason: 'not-approved', status: life.status } }
    if (released.runId !== input.runId) return { ok: false, refusal: { reason: 'wrong-run', runId: released.runId } }
  } else {
    if (life.status !== 'approved') return { ok: false, refusal: { reason: 'not-approved', status: life.status } }
    if (life.runId !== input.runId) return { ok: false, refusal: { reason: 'wrong-run', runId: life.runId } }
  }
  return {
    ok: true,
    events: [
      {
        type: 'TicketContinued',
        actor: 'conductor',
        data: parsePayload('TicketContinued', {
          runId: input.runId,
          worker: input.worker,
          ...(input.body !== undefined ? { body: input.body } : {}),
        }),
      },
    ],
  }
}

/** A release by a run's own conductor, or the one a conductor makes for a claim by a worker that is gone. */
export type ReleaseInput =
  | { by: 'run'; runId: string; reason: string; cause: ReleaseCause | null }
  | { by: 'dead-worker'; mine: string; lock: string }
  /** A person's requeue, edit or split gives the held run's claim up (0118 §7): the actor is the person. */
  | {
      by: 'person'
      person: string
      runId: string
      waitId: WaitId
      how: 'StartNewAttempt' | 'EditBodyAndStartNewAttempt' | 'Split'
    }

/** A release the ticket will not make: the claim moved on between the scan and the write. */
export type ReleaseDecline = { reason: 'moved-on'; status: string; worker?: string }

export function releaseTransition(
  state: TicketState,
  input: ReleaseInput,
): { ok: true; events: ToAppend<PayloadOf<'TicketReleased'>>[] } | { ok: false; refusal: ReleaseDecline } {
  let data: PayloadOf<'TicketReleased'>
  if (input.by === 'run') {
    data = parsePayload('TicketReleased', { runId: input.runId, reason: input.reason, cause: input.cause })
  } else if (input.by === 'person') {
    const how =
      input.how === 'EditBodyAndStartNewAttempt'
        ? ' with an edited body'
        : input.how === 'Split'
          ? ' after a split'
          : ''
    data = parsePayload('TicketReleased', {
      runId: input.runId,
      reason: `Requeued by ${input.person}${how}.`,
      cause: { _tag: 'ByPerson', waitId: input.waitId },
    })
  } else {
    const life = state.lifecycle
    // Releasing a live claim is a far worse outcome than leaving a dead one.
    if (life.status !== 'claimed' || life.worker === input.mine) {
      return {
        ok: false,
        refusal: {
          reason: 'moved-on',
          status: life.status,
          ...(life.status === 'claimed' ? { worker: life.worker } : {}),
        },
      }
    }
    data = parsePayload('TicketReleased', {
      runId: life.runId,
      // The lock, not a timestamp: whoever reads this back can check the claim.
      reason: `${input.mine} holds ${input.lock}, so ${life.worker} was not coming back`,
      cause: null,
    })
  }
  return {
    ok: true,
    events: [{ type: 'TicketReleased', actor: input.by === 'person' ? input.person : 'conductor', data }],
  }
}

/**
 * `--if-head` names the saved head in full or by a prefix of at least 7 hex characters (#668). The comparison is
 * against the one saved head, never a lookup, so a prefix cannot be ambiguous.
 */
export function matchHead(given: string, head: string): 'match' | 'bad-sha' | 'mismatch' {
  const sha = given.toLowerCase()
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return 'bad-sha'
  return head.startsWith(sha) ? 'match' : 'mismatch'
}

export type BlockedLifecycle = Extract<TicketLifecycle, { status: 'blocked' }>

/** What a person's resolution of a wait is refused for, read off the ticket's own state. */
export type ResolveRefusal =
  /** The ticket is not waiting on that wait — it moved, or the page is stale. */
  | { reason: 'not-blocked'; waitId: WaitId }
  /** The wait's reason does not offer that resolution. */
  | { reason: 'not-offered'; resolution: Resolution['_tag']; waitReason: WaitReason }
  /** A split resolves only with the children it wrote. */
  | { reason: 'split-not-written' }

/**
 * Whether a resolution can go ahead: `repeat` when it is an approval that already landed (it appends nothing to the
 * ticket — the continuation it was owed is asked for again), `proceed` with the block it resolves, or a refusal.
 */
export function resolveWaitTransition(
  state: TicketState,
  input: { waitId: WaitId; resolution: Resolution },
):
  | { ok: true; kind: 'repeat'; runId: string }
  | { ok: true; kind: 'proceed'; block: BlockedLifecycle }
  | { ok: false; refusal: ResolveRefusal } {
  const life = state.lifecycle
  const { resolution } = input
  if (
    (resolution._tag === 'Approve' || resolution._tag === 'FixRefusal') &&
    life.status === 'approved' &&
    life.waitId === input.waitId &&
    (resolution._tag === 'FixRefusal'
      ? life.grantRef !== undefined && (!resolution.onSha || matchHead(resolution.onSha, life.onSha ?? '') === 'match')
      : life.onSha === resolution.onSha)
  ) {
    return { ok: true, kind: 'repeat', runId: life.runId }
  }
  // A rerun whose continuation was never scheduled is asked for again the same way (#1218).
  if (
    resolution._tag === 'RedoStep' &&
    life.status === 'approved' &&
    life.waitId === input.waitId &&
    state.waits.find((w) => w.waitId === life.waitId)?.resolution?.resolution._tag === 'RedoStep' &&
    (!resolution.onSha || matchHead(resolution.onSha, life.onSha ?? '') === 'match')
  ) {
    return { ok: true, kind: 'repeat', runId: life.runId }
  }
  if (life.status !== 'blocked' || life.waitId !== input.waitId)
    return { ok: false, refusal: { reason: 'not-blocked', waitId: input.waitId } }
  if (!allowedResolutions(life.reason).includes(resolution._tag)) {
    return {
      ok: false,
      refusal: { reason: 'not-offered', resolution: resolution._tag, waitReason: life.reason },
    }
  }
  return { ok: true, kind: 'proceed', block: life }
}

/**
 * The events a resolution appends, in order: a split's `TicketSplit` (only when the payload the caller wrote names
 * this wait), `WaitResolved`, and — for a requeue, an edit or a split of a wait a run holds — the person's release.
 */
export function resolvedEvents(
  state: TicketState,
  block: BlockedLifecycle,
  input: {
    waitId: WaitId
    by: string
    resolution: Resolution
    note: string
    answers?: PayloadOf<'WaitResolved'>['answers']
    split?: unknown
    /** Who appends: an `Actor` (`human:…`, `conductor`). Absent, `by` is it; a system resolution is `by: 'triage'` and `conductor`. */
    actor?: string
  },
): { ok: true; events: ToAppend[] } | { ok: false; refusal: ResolveRefusal } {
  const events: ToAppend[] = []
  const { resolution } = input
  if (resolution._tag === 'Split') {
    let written: PayloadOf<'TicketSplit'> | null = null
    try {
      written = parsePayload('TicketSplit', input.split)
    } catch {
      // Not a split payload at all — refused below, the same as none.
    }
    if (written === null || written.waitId !== input.waitId)
      return { ok: false, refusal: { reason: 'split-not-written' } }
    events.push({ type: 'TicketSplit', actor: input.actor ?? input.by, data: written })
  }
  events.push({
    type: 'WaitResolved',
    actor: input.actor ?? input.by,
    data: parsePayload('WaitResolved', {
      waitId: input.waitId,
      by: input.by,
      resolution,
      note: input.note,
      ...(input.answers ? { answers: input.answers } : {}),
    }),
  })
  if (
    block.runId !== null &&
    (resolution._tag === 'StartNewAttempt' ||
      resolution._tag === 'EditBodyAndStartNewAttempt' ||
      resolution._tag === 'Split')
  ) {
    const released = releaseTransition(state, {
      by: 'person',
      person: input.actor ?? input.by,
      runId: block.runId,
      waitId: input.waitId,
      how: resolution._tag,
    })
    if (released.ok) events.push(...released.events)
  }
  return { ok: true, events }
}

export type AskDecline = { reason: 'not-backlog'; status: TicketStatus }

/** A question asked of a person before any run: only of an item nothing holds. */
export function askTransition(
  state: TicketState,
  input: { waitId: WaitId; question: string; by: string },
): { ok: true; events: ToAppend[] } | { ok: false; refusal: AskDecline } {
  if (state.lifecycle.status !== 'backlog') {
    return { ok: false, refusal: { reason: 'not-backlog', status: state.lifecycle.status } }
  }
  return {
    ok: true,
    events: [
      {
        type: 'WaitStarted',
        actor: input.by,
        data: parsePayload('WaitStarted', {
          waitId: input.waitId,
          reason: { _tag: 'OwnQuestion', question: input.question, by: input.by },
        }),
      },
    ],
  }
}

/**
 * A wait is current when it is the one the ticket is blocked on — or when the reduce has never seen it, which a stream
 * triage was handed without its `WaitStarted` is (the leniency `triage.ts` has always had).
 */
export function waitIsCurrentOrUnknown(state: TicketState, waitId: WaitId): boolean {
  if (!state.waits.some((w) => w.waitId === waitId)) return true
  return state.lifecycle.status === 'blocked' && state.lifecycle.waitId === waitId
}

export type StartTriageDecline = { reason: 'wait-not-current' } | { reason: 'already-started'; attempt: number }

/**
 * A triage starts at the attempt the caller fixed, and is refused when the wait's reduce already holds that attempt or a
 * later one: the race lost is read off `triage.started`, never worked out as "started + 1", which would make the loser
 * the starter of the next attempt and buy a second agent.
 */
export function startTriageTransition(
  state: TicketState,
  input: {
    waitId: WaitId
    attempt: number
    by: PayloadOf<'TriageStarted'>['by']
    /** The highest attempt already started for a wait the reduce has never seen (it keeps none), read off the stream. */
    startedUnseen?: number
  },
): { ok: true; events: ToAppend[] } | { ok: false; refusal: StartTriageDecline } {
  if (!waitIsCurrentOrUnknown(state, input.waitId)) return { ok: false, refusal: { reason: 'wait-not-current' } }
  const seen = state.waits.findLast((w) => w.waitId === input.waitId)?.triage.started?.attempt
  const started = seen ?? input.startedUnseen ?? null
  if (started !== null && started >= input.attempt) {
    return { ok: false, refusal: { reason: 'already-started', attempt: started } }
  }
  return {
    ok: true,
    events: [
      {
        type: 'TriageStarted',
        actor: 'conductor',
        data: parsePayload('TriageStarted', { waitId: input.waitId, attempt: input.attempt, by: input.by }),
      },
    ],
  }
}

export type FinishTriageDecline = { reason: 'wait-not-current' } | { reason: 'changed' }

/** The part of an event the "unchanged since" rule reads. */
export type SinceEvent = { readonly type: string; readonly data: unknown }

/**
 * Whether every event after the version a triage started at is that triage's own run fact (`RunPrompted` or `RunSpent`
 * for `Triage{waitId}`, which `recordTriageRun` appends to the ticket stream between `TriageStarted` and the answer).
 * Anything else — a person's resolution, an edit, a close, a requeue — is a change. A body edited on GitHub directly is
 * not on the log, so it is not caught here (0118, *Consequences*).
 */
export function unchangedSince(since: readonly SinceEvent[], waitId: WaitId): boolean {
  return since.every((e) => {
    if (e.type !== 'RunPrompted' && e.type !== 'RunSpent') return false
    const f = (e.data as { for?: { _tag?: string; waitId?: string } } | null)?.for
    return f?._tag === 'Triage' && f.waitId === waitId
  })
}

/**
 * The version rule, one place. `ifVersion` is the version the caller bound to; `since` is the stream's events after it
 * (none for a caller that decided on the very read it appends at). The stream is unchanged when it holds exactly those
 * events past `ifVersion` and they are all this triage's own run facts.
 */
function triageStreamChanged(
  state: TicketState,
  input: { waitId: WaitId; ifVersion: number; since?: readonly SinceEvent[] },
): boolean {
  const since = input.since ?? []
  return state.version !== input.ifVersion + since.length || !unchangedSince(since, input.waitId)
}

/** A triage's answer is recorded while its wait is current and the ticket is unchanged since the version it read. */
export function finishTriageTransition(
  state: TicketState,
  input: {
    waitId: WaitId
    attempt: number
    headSha: string
    result: PayloadOf<'WaitTriaged'>['result']
    by: PayloadOf<'WaitTriaged'>['by']
    ifVersion: number
    since?: readonly SinceEvent[]
  },
): { ok: true; events: ToAppend[] } | { ok: false; refusal: FinishTriageDecline } {
  if (!waitIsCurrentOrUnknown(state, input.waitId)) return { ok: false, refusal: { reason: 'wait-not-current' } }
  if (triageStreamChanged(state, input)) return { ok: false, refusal: { reason: 'changed' } }
  return { ok: true, events: [triagedEvent(input)] }
}

function triagedEvent(input: {
  waitId: WaitId
  attempt: number
  headSha: string
  result: PayloadOf<'WaitTriaged'>['result']
  by: PayloadOf<'WaitTriaged'>['by']
}): ToAppend {
  return {
    type: 'WaitTriaged',
    actor: 'conductor',
    data: parsePayload('WaitTriaged', {
      waitId: input.waitId,
      attempt: input.attempt,
      headSha: input.headSha,
      result: input.result,
      by: input.by,
    }),
  }
}

export type ActOnTriageRefusal = 'wait-not-current' | 'changed' | 'head-moved' | 'not-offered'

/** What `actOnTriageTransition` decided: the events, and the action the system took (null: a person is asked). */
export type ActOnTriageDecision = {
  ok: true
  events: ToAppend[]
  action: CauseAction | null
  resolution: Resolution | null
}

/**
 * **A triage answer the system can act on resolves its own wait** (0108 §6, 0118 §3), pure. The answer is bound to the
 * wait, the head and the version triage read (`ifVersion` with `since`, the events after it). When `actionFor` gives
 * anything but `askPerson`, `WaitTriaged` and `WaitResolved{by: 'triage'}` come back for one append; that
 * `WaitResolved` is what spends the action's bound (see `triageSpentOn`). `writeSpentOnThenRedoStep` (#1260) and
 * `splitTicket` (#1262) are not built: they return only `WaitTriaged`, the wait stays.
 */
export function actOnTriageTransition(
  state: TicketState,
  input: {
    waitId: WaitId
    attempt: number
    /** The head recorded on `WaitTriaged` (what triage read through the mirror). */
    headSha: string
    /** The head the answer is bound to — the log's own claim for the attempt when triage started; `''` when it had none. */
    boundSha: string
    by: PayloadOf<'WaitTriaged'>['by']
    answer: Extract<TriageResult, { _tag: 'TriageAnswered' }>
    origin: CauseOrigin
    counters: Readonly<Record<CauseBound, CauseCounter>>
    ifVersion: number
    since?: readonly SinceEvent[]
    /** The head the log says the attempt is at now; `null` when the wait holds no run. */
    headNow: string | null
  },
): ActOnTriageDecision | { ok: false; refusal: ActOnTriageRefusal } {
  const life = state.lifecycle
  if (!waitIsCurrentOrUnknown(state, input.waitId)) return { ok: false, refusal: 'wait-not-current' }
  if (triageStreamChanged(state, input)) return { ok: false, refusal: 'changed' }
  const triaged = triagedEvent({
    waitId: input.waitId,
    attempt: input.attempt,
    headSha: input.headSha,
    result: input.answer,
    by: input.by,
  })
  const none: ActOnTriageDecision = { ok: true, events: [triaged], action: null, resolution: null }
  const action = actionFor(input.answer.cause, input.origin, input.counters)
  if (action._tag === 'askPerson') return { ...none, action }
  // Not yet built: the person is asked as before.
  if (action._tag === 'writeSpentOnThenRedoStep' || action._tag === 'splitTicket') return { ...none, action }
  // A wait the reduce has never seen cannot be resolved (nothing to find its reason in): advice only.
  if (life.status !== 'blocked' || life.waitId !== input.waitId) return { ...none, action }
  const needsHead = action._tag !== 'startNewAttempt'
  if (needsHead && (input.boundSha === '' || input.headNow === null || input.headNow !== input.boundSha)) {
    return { ok: false, refusal: 'head-moved' }
  }
  const ref = agentBranchOf(state.externalRef ?? '')
  const resolution: Resolution =
    action._tag === 'startNewAttempt'
      ? { _tag: 'StartNewAttempt' }
      : action._tag === 'redoStep'
        ? { _tag: 'RedoStep', onSha: input.boundSha, ref }
        : { _tag: 'FixRefusal', onSha: input.boundSha, ref }
  const decided = resolveWaitTransition(state, { waitId: input.waitId, resolution })
  if (!decided.ok || decided.kind !== 'proceed') return { ok: false, refusal: 'not-offered' }
  const resolved = resolvedEvents(state, decided.block, {
    waitId: input.waitId,
    by: 'triage',
    // `by` is the provenance the counters read; the event's actor must be one the store accepts.
    actor: 'conductor',
    resolution,
    note: input.answer.summary,
  })
  if (!resolved.ok) return { ok: false, refusal: 'not-offered' }
  return { ok: true, events: [triaged, ...resolved.events], action, resolution }
}

/**
 * **What triage's own resolutions have spent that no counter holds yet**, per bound, read off the ticket's waits: a
 * `WaitResolved{by: 'triage'}` is the count, in the one append before any effect (0108 §6 (3)), so a restart between it
 * and the effect spends once. A person's resolution adds nothing here.
 *
 * The attempt's own counters are cumulative and a continuation is seeded with `counter + this`, so the next event it
 * writes holds the triage spend too. Adding the whole of it again would count it twice, so a resolution is counted only
 * while it is *after* the last event that raised that counter (`attempt`'s `…Seq`). The total for a bound is the
 * attempt's counter plus this, whichever side the spend is on. `attempt` absent counts every resolution of the ticket
 * (`newAttempts`, which no attempt counter holds).
 */
export function triageSpentOn(
  state: TicketState,
  /** The attempt a per-attempt bound is counted for; absent counts every wait's. `newAttempts` is the ticket's. */
  runId?: string | null,
  attempt?: {
    stepRedosSeq?: number
    conflictRoundsSeq?: number
    implementRoundSeq?: number
  } | null,
): {
  refusalFixes: number
  conflictResolutions: number
  newAttempts: number
  stepRedos: number
} {
  const out = { refusalFixes: 0, conflictResolutions: 0, newAttempts: 0, stepRedos: 0 }
  // Seq absent on either side: nothing says the counter holds it, so it is counted.
  const after = (seq: number | undefined, counterSeq: number | undefined): boolean =>
    seq === undefined || counterSeq === undefined || seq > counterSeq
  for (const w of state.waits) {
    if (w.resolution?.by !== 'triage') continue
    const tag = w.resolution.resolution._tag
    const seq = w.resolution.seq
    if (tag === 'StartNewAttempt') {
      out.newAttempts += 1
      continue
    }
    if (!(runId === undefined || ('run' in w.reason && w.reason.run.runId === runId))) continue
    if (tag === 'RedoStep') {
      if (after(seq, attempt?.stepRedosSeq)) out.stepRedos += 1
    } else if (tag === 'FixRefusal') {
      // Which bound a fix spent is the cause it answered: a conflict's resolution is `conflictResolutions`.
      const answered = w.triage.result
      if (answered?._tag === 'TriageAnswered' && answered.cause._tag === 'ConflictingHunks') {
        if (after(seq, attempt?.conflictRoundsSeq)) out.conflictResolutions += 1
      } else if (after(seq, attempt?.implementRoundSeq)) out.refusalFixes += 1
    }
  }
  return out
}

export type CloseDecline = { reason: 'already-closed' } | { reason: 'landed' } | { reason: 'changed' }

/** A close is refused from either terminal, and when the stream moved since the caller's decision (#604). */
export function closeChecks(state: TicketState, input: { ifVersion?: number }): CloseDecline | null {
  if (state.lifecycle.status === 'closed') return { reason: 'already-closed' }
  if (state.lifecycle.status === 'landed') return { reason: 'landed' }
  if (input.ifVersion !== undefined && state.version !== input.ifVersion) return { reason: 'changed' }
  return null
}

export type CloseRefusal = ResolveRefusal | { reason: 'wait-moved'; waitId: WaitId }

/**
 * The close: `TicketClosed` and the end plan, and — **in the same append** — the wait's resolution first when the item
 * is blocked (#465, 0118 §11). `waitId` is the wait the caller was shown: `undefined` takes whatever is open, `null` is
 * a card that showed none, which refuses a close that turns out to be blocked.
 */
export function closeTransition(
  state: TicketState,
  input: { by: string; reason: string; waitId: WaitId | null | undefined; ended: readonly ToAppend[] },
): { ok: true; events: ToAppend[]; blocked: boolean } | { ok: false; refusal: CloseRefusal } {
  const closed: ToAppend = {
    type: 'TicketClosed',
    actor: input.by,
    data: parsePayload('TicketClosed', { by: input.by, reason: input.reason }),
  }
  const life = state.lifecycle
  if (life.status !== 'blocked') return { ok: true, events: [closed, ...input.ended], blocked: false }
  if (input.waitId === null) return { ok: false, refusal: { reason: 'wait-moved', waitId: life.waitId } }
  const waitId = input.waitId ?? life.waitId
  const resolution: Resolution = { _tag: 'Close' }
  const decided = resolveWaitTransition(state, { waitId, resolution })
  if (!decided.ok) return decided
  if (decided.kind === 'repeat') return { ok: false, refusal: { reason: 'not-blocked', waitId } }
  const resolved = resolvedEvents(state, decided.block, { waitId, by: input.by, resolution, note: input.reason.trim() })
  if (!resolved.ok) return resolved
  return { ok: true, events: [...resolved.events, closed, ...input.ended], blocked: true }
}
