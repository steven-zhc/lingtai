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
import type { Envelope } from './envelope.ts'
import type { PayloadOf, ReleaseCause, SplitChild, Tier, TriageStartedBy } from './events.ts'
import { agentBranchOf, isTicketStream, parseTicketStream } from './streams.ts'
import { waitWords } from './wait-words.ts'
import type { Resolution, TriageResult, WaitReason } from './wait.ts'

/** How an attempt ended: the later of a release and a question put to a person (D13). */
export type AttemptEnding =
  | { readonly kind: 'released'; readonly reason: string }
  | { readonly kind: 'asked'; readonly reason: WaitReason }

/** A chat held on a ticket, with how its latest `DiscussionHeld` ended (#843). */
export interface TicketDiscussion {
  readonly chatId: string
  readonly outcome: PayloadOf<'DiscussionHeld'>['outcome']
}

/**
 * One wait, reduced once (#842). `waitsOf`, `triageFactsOf`, `designAsksOf`, the
 * CLI's triage and `editEndedWaits` all read this rather than scanning the stream.
 */
export interface TicketWait {
  readonly waitId: WaitId
  readonly reason: WaitReason
  /** The `WaitStarted`'s own `at`. */
  readonly at: Date
  /** The first `WaitResolved` naming this wait. */
  readonly resolution: { readonly resolution: Resolution; readonly by: string } | null
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
          ? { ...w, resolution: { resolution: d.resolution, by: d.by } }
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
export interface RestartRecord {
  after: string
  restart: number
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
  dispatchRefusals: readonly { requiredTier: Tier; runtime: string; missing: readonly string[] }[]

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
  restarts: readonly RestartRecord[]

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
  restarts: [],
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
        claims: endClaim(state.claims, d.runId, { kind: 'released', reason: d.reason }),
        restarts:
          d.cause?._tag === 'Restart'
            ? [...state.restarts, { after: d.runId, restart: d.cause.restart }]
            : state.restarts,
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
      // `Requeue` rather than `AnswerQuestion`), so there is nothing to keep:
      // the item is back in the backlog and no attempt is told anything.
      if (d.resolution._tag === 'Requeue' && block?.reason._tag === 'OwnQuestion') {
        return { ...state, ...at, lastMove, lifecycle: { status: 'backlog' } }
      }
      // **`Approve` moves to `approved`** (#465) — a continuation is owed,
      // not a fresh claim, and `block.runId` is never null here:
      // `allowedResolutions` offers `Approve` for no `WaitReason` that lacks
      // a run.
      if ((d.resolution._tag === 'Approve' || d.resolution._tag === 'GrantFixRound') && block !== null) {
        return {
          ...state,
          ...at,
          lastMove,
          lifecycle: {
            status: 'approved',
            runId: block.runId!,
            waitId: block.waitId,
            onSha: d.resolution.onSha,
            ...(d.resolution._tag === 'GrantFixRound' ? { grantRef: d.resolution.ref } : {}),
          },
        }
      }
      // `Close` does not return the item to the backlog on its own —
      // `TicketClosed` (`close.ts`) says what actually happened — so only
      // the resolutions that are themselves a requeue move the lifecycle
      // here.
      if (
        d.resolution._tag !== 'Requeue' &&
        d.resolution._tag !== 'EditBodyAndRequeue' &&
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
