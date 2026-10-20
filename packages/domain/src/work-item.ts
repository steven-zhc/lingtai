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
 * is no value of `WorkItemState` in which an item is both claimed and blocked,
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
import type { Envelope } from './envelope.ts'
import type { BlockDiagnosis, PayloadOf, Tier } from './events.ts'
import { legacyColumns } from './legacy-columns.ts'
import type { WaitReason } from './wait.ts'

export type WorkItemLifecycle =
  | { status: 'backlog' }
  /**
   * Held. There is no expiry in this shape and that is the whole of 0027: a
   * fold cannot read a clock, so a lifecycle that lapsed on its own would make
   * `lingtai projection rebuild task_view` disagree with the incremental fold.
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
      /** The question, not just the fact. `agent:blocked` carried no question. */
      question: string
      /** `schema` was here and never written; see `legacyColumns`. */
      needsFrom: 'human' | 'external'
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
      needs: 'judgement' | 'acknowledgement' | null
      /** What happened, what was done, what is recommended. Null when undiagnosed. */
      diagnosis: BlockDiagnosis | null
    }
  | { status: 'landed'; mergeCommit: string; base: string }
  /**
   * Nobody is going to do this (#151). A terminal like `landed`, and like it
   * nothing lifts it — reopening the issue starts no work, and the answer to
   * wanting it again is a new ticket.
   */
  | { status: 'closed'; by: string; reason: string }

export type WorkItemStatus = WorkItemLifecycle['status']

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
 * `WorkItemUnblocked.note` reached no state before #147: a replay could say what
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

export interface WorkItemState {
  lifecycle: WorkItemLifecycle

  /** Null until `TicketDiscovered`; a stream can be read before it exists. */
  project: string | null
  source: 'github-issue' | 'manual' | 'agent-followup' | null
  externalRef: string | null
  title: string | null
  /** Whatever label the recipe's `source.kinds` matched. Null until discovered. */
  kind: string | null
  labels: readonly string[]

  links: readonly WorkItemLink[]

  /**
   * Every dispatch the scheduler refused, kept rather than counted. A tier is
   * never silently downgraded, so the refusals are the record of what could not
   * run and why.
   */
  dispatchRefusals: readonly { requiredTier: Tier; runtime: string; missing: readonly string[] }[]

  /** Runs that have held this item, oldest first. A re-run appends. */
  runs: readonly string[]

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

  /** Version of the last event applied — the `expectedVersion` for the next append. */
  version: number
  /** Global position of the last event applied. */
  lastSeq: bigint | null
}

export const emptyWorkItem: WorkItemState = {
  lifecycle: { status: 'backlog' },
  project: null,
  source: null,
  externalRef: null,
  title: null,
  kind: null,
  labels: [],
  links: [],
  dispatchRefusals: [],
  runs: [],
  restarts: [],
  pendingPrompt: null,
  answers: [],
  version: 0,
  lastSeq: null,
}

/**
 * The events that move the lifecycle, as a set rather than as knowledge spread
 * across the switch below — because `closed` has to absorb exactly these and
 * nothing else, and a list you can read is the only way that stays true when a
 * seventh transition is added.
 */
const LIFECYCLE_EVENTS = new Set([
  'TicketClaimed',
  'TicketReleased',
  'WaitStarted',
  'WaitResolved',
  'TicketLanded',
  'TicketClosed',
])

export function applyWorkItem(state: WorkItemState, event: Envelope): WorkItemState {
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
  if (state.lifecycle.status === 'closed' && LIFECYCLE_EVENTS.has(event.type)) {
    return { ...state, ...at }
  }

  switch (event.type) {
    case 'TicketDiscovered': {
      const d = event.data as PayloadOf<'TicketDiscovered'>
      return {
        ...state,
        ...at,
        project: d.project,
        source: d.source,
        externalRef: d.externalRef,
        title: d.title,
        kind: d.kind,
        labels: d.labels,
      }
    }

    case 'TicketClaimed': {
      const d = event.data as PayloadOf<'TicketClaimed'>
      return {
        ...state,
        ...at,
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
        // the event folds through the default below and changes nothing but the
        // version.
        pendingPrompt: null,
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
        restarts:
          d.cause?._tag === 'Restart'
            ? [...state.restarts, { after: d.runId, restart: d.cause.restart }]
            : state.restarts,
      }
    }

    case 'WaitStarted': {
      const d = event.data as PayloadOf<'WaitStarted'>
      const legacy = legacyColumns(d.reason)
      return {
        ...state,
        ...at,
        lifecycle: {
          status: 'blocked',
          waitId: d.waitId,
          reason: d.reason,
          question: legacy.question,
          needsFrom: legacy.needsFrom,
          runId: legacy.runId,
          needs: legacy.needs,
          diagnosis: legacy.diagnosis,
        },
      }
    }

    case 'WaitResolved': {
      const d = event.data as PayloadOf<'WaitResolved'>
      // The answer is kept, and that is the whole of #147's fold change: this
      // case used to return to the backlog and drop `note` on the floor, so the
      // log held the decision and no state, projection or prompt could say it.
      const block = state.lifecycle.status === 'blocked' ? state.lifecycle : null
      // A question withdrawn was never answered (an `OwnQuestion` resolved by
      // `Requeue` rather than `AnswerQuestion`), so there is nothing to keep:
      // the item is back in the backlog and no attempt is told anything.
      if (d.resolution._tag === 'Requeue' && block?.reason._tag === 'OwnQuestion') {
        return { ...state, ...at, lifecycle: { status: 'backlog' } }
      }
      // `Close`/`Approve` do not return the item to the backlog on their own —
      // `TicketClosed`/`TicketLanded` (or a continued run, #465) say what
      // actually happened — so only the resolutions that are themselves a
      // requeue move the lifecycle here.
      if (
        d.resolution._tag !== 'Requeue' &&
        d.resolution._tag !== 'EditBodyAndRequeue' &&
        d.resolution._tag !== 'AnswerQuestion'
      ) {
        return { ...state, ...at }
      }
      return {
        ...state,
        ...at,
        lifecycle: { status: 'backlog' },
        answers: [
          ...state.answers,
          {
            question: block?.question ?? null,
            runId: block?.runId ?? null,
            answer: d.note,
            by: d.by,
          },
        ],
      }
    }

    case 'TicketLinked': {
      const d = event.data as PayloadOf<'TicketLinked'>
      const already = state.links.some((l) => l.relation === d.relation && l.otherRef === d.otherRef)
      return { ...state, ...at, links: already ? state.links : [...state.links, d] }
    }

    case 'TicketClosed': {
      const d = event.data as PayloadOf<'TicketClosed'>
      return { ...state, ...at, lifecycle: { status: 'closed', by: d.by, reason: d.reason } }
    }

    case 'TicketLanded': {
      const d = event.data as PayloadOf<'TicketLanded'>
      return {
        ...state,
        ...at,
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

export function reduceWorkItem(events: readonly Envelope[]): WorkItemState {
  return events.reduce(applyWorkItem, emptyWorkItem)
}
