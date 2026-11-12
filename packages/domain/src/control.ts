import { decodeControl, encodeControl } from './control-codec.ts'
/**
 * What the conductor has been told to do, reduced.
 *
 * Vocabulary and a reducer, in the package that holds both — for the reason
 * `streams.ts` gives about itself: this was in `daemon`, and it is needed by
 * something that must not depend on `daemon`. `conductor` is what discovers
 * that an account cannot start a run at all
 * ([0031](../../../doc/decisions-archive/0031-a-run-that-never-started.md) §3), and
 * `daemon` already depends on `conductor`. A second copy of the reducer in the
 * package that needed it would be two answers to "is the conductor paused".
 *
 * The I/O stays where it was: `@lingtai/daemon`'s `readControl` reads
 * `CONTROL_STREAM` and hands the envelopes to `reduceControl`, and everything
 * that appends to the stream still goes through the commands there.
 */
import type { Envelope } from './envelope.ts'
import type { EventType } from './events.ts'
import { reduceAll, type Reducer } from './reducer.ts'

/** One stream for the whole installation. Control is not per-project. */
export const CONTROL_STREAM = 'ctl-conductor'

/**
 * The event types `reduceControl` reads — every other type on the control
 * stream falls through it, `Reconciled` among them, which is most of the
 * stream's bytes (#796). A reader that only reduces asks the store for these
 * (`EventStore.readTypes`). A type added to the reducer and not here would be
 * silently dropped, and `unit/control.test.ts` fails on it.
 *
 * **Never a basis for a stream's version**: the list is shorter than the stream.
 */
export const CONTROL_FOLD_TYPES = [
  'ConductorPaused',
  'ConductorResumed',
  'ConductorShutdownRequested',
  'ConductorShutdownWithdrawn',
  'ConductorStarted',
  'ContinueRequested',
  'DayCeilingLifted',
  'DayCeilingReached',
  'DiscussionRequested',
  'RunRequested',
] as const satisfies readonly EventType[]

/** A standing request to drain and exit. Null when nobody has asked. */
export interface ShutdownRequest {
  by: string
  reason: string
  /**
   * How long the drain may take before the daemon gives up on it, or null.
   *
   * Null is the ordinary case and the safe one (0030 §6). A timeout that trips
   * leaves the agent running on purpose — the orphan `reconcile` now kills.
   */
  timeoutMs: number | null
  /**
   * Where the request sits on `ctl-conductor`, which is what names it.
   *
   * A request carries no id of its own and does not need one: the stream is
   * the installation's, and a position on it is unique. A
   * `ConductorShutdownWithdrawn` already in the log names a request by this, so
   * it can never lift a newer one.
   */
  version: number
  /** Stop without draining the pass in flight (`#159`). */
  force: boolean
}

export interface ControlState {
  paused: boolean
  /** Who paused it and why, when it is paused. */
  by: string | null
  reason: string | null
  /**
   * Who asked it to stop and why, when somebody has.
   *
   * Separate from `paused` because they are separate facts: a paused conductor
   * is still there to be resumed, and a draining one is on its way out. The
   * board keeps them as separate chips for the same reason (#77).
   *
   * It is also why a drain and a pause that ends by itself **compose** rather
   * than race (0031 §3): one stops taking work and exits, the other stops
   * taking work and resumes, and an expiring pause clears neither this field
   * nor the exit it is asking for.
   */
  shutdown: ShutdownRequest | null
  /** Tasks somebody asked for by hand, oldest first, not yet taken. */
  requested: { project: string; issue: string; by: string }[]
  /**
   * Approvals owed a continuation, oldest first, not yet taken (#465, 0120
   * §6). `ContinueRequested`'s own header: it is what tells the next pass
   * which issue to look at, not what wakes it — `WaitResolved` is already in
   * `WAIT_EVENTS`, which `@lingtai/daemon`'s `COMPLETION_EVENTS` wakes the
   * work loop on. Satisfied the same way `requested` is: once the item
   * stops being `approved`, which `continueTicket` does, a stale row here
   * simply matches nothing and is dropped rather than tracked.
   */
  continuing: { project: string; issue: string; runId: string; by: string }[]
  /**
   * Questions asked of the discussion assistant, oldest first — every one of
   * them, answered or not.
   *
   * Not filtered here, and that is deliberate. A request is satisfied when
   * `chat-<id>` carries an answer for it, which is a fact on a different stream
   * than this reduce reads; asking the chat stream is the daemon's job, and it is
   * the same shape as `requested`, which is satisfied by the item ceasing to be
   * queued. Keeping the decision out of this reduce is what stops the control
   * stream growing a second state machine
   * ([0033](../../../doc/decisions-archive/0033-the-third-kind-of-agent.md) §6).
   */
  discussions: DiscussionRequest[]
  /**
   * The day's ceiling as a lock of its own (0126 §2). `reached` stands from a
   * `DayCeilingReached` until a `DayCeilingLifted`; `raised` is the figure a
   * person raised a day to. Whether either is from today is the caller's
   * question: the reducer reads no clock.
   */
  dayCeiling: {
    reached: {
      day: string
      reportedUsd: number
      estimatedUsd: number
      ceilingUsd: number
      at: Date
      seq: number
    } | null
    raised: { day: string; toUsd: number; fromUsd?: number; by: string; at: Date } | null
  }
}

/** One question, as `DiscussionRequested` recorded it. */
export interface DiscussionRequest {
  chatId: string
  ticketId: string
  attempt: number | null
  question: string
  by: string
}

export const emptyControl: ControlState = {
  paused: false,
  by: null,
  reason: null,
  shutdown: null,
  requested: [],
  continuing: [],
  discussions: [],
  dayCeiling: { reached: null, raised: null },
}

/**
 * A `ConductorShutdownRequested` as the request it asked for. The one decode:
 * the reducer folds it into `shutdown`, and a read of the events between two
 * versions (`requestsBetween`) lists them, so neither can disagree about what a
 * missing field means.
 */
export function decodeShutdownRequest(e: Envelope): ShutdownRequest {
  const d = (e.data ?? {}) as Record<string, unknown>
  const timeout = d['timeoutMs']
  return {
    by: typeof d['by'] === 'string' ? d['by'] : '',
    reason: typeof d['reason'] === 'string' ? d['reason'] : '',
    timeoutMs: typeof timeout === 'number' ? timeout : null,
    // Absent on every request written before `#159`, and those were all
    // drains — so the absence reads as `false` rather than as unknown.
    force: d['force'] === true,
    version: e.version,
  }
}

/**
 * Whether a `ConductorPaused` payload is the setup's: `cause: 'setup'`, or a
 * pause written before `cause` existed that holds across starts (only the setup
 * ever did). Any other `cause`, or none without `holdsAcrossStarts`, is not.
 */
export function isSetupPause(d: Record<string, unknown>): boolean {
  if (d['cause'] === 'setup') return true
  return d['cause'] === undefined && d['holdsAcrossStarts'] === true
}

/**
 * One event reduced into the state. Pure, reads no clock, and never mutates its
 * argument (0124 §2).
 */
export function reduceControlEvent(state: ControlState, e: Envelope): ControlState {
  const d = (e.data ?? {}) as Record<string, unknown>
  const str = (k: string): string | null => (typeof d[k] === 'string' ? (d[k] as string) : null)
  switch (e.type) {
    case 'ConductorPaused':
      // The setup's pause is the only one that stops the conductor (0126): the
      // person's, the ceiling's and an account limit's are locks on their own
      // streams, so an old event of theirs reduces to nothing.
      if (!isSetupPause(d)) return state
      return { ...state, paused: true, by: str('by'), reason: str('reason') }
    case 'ConductorShutdownRequested':
      return { ...state, shutdown: decodeShutdownRequest(e) }
    case 'ConductorStarted':
      // A drain lasts from its request to the next start (0126): the start is
      // the unlock. Nothing else changes — the pause is still the watermark's.
      return state.shutdown === null ? state : { ...state, shutdown: null }
    case 'ConductorShutdownWithdrawn': {
      // The request named, or nothing. A withdrawal that lost a race to a
      // newer request must leave that request standing — it is somebody
      // else's, and lifting it is the one thing a restart may not do (0042).
      // A pause is untouched either way. Nothing writes this any more: a drain
      // ends at the next start (0126). It is read so a log that has one still
      // reduces the same.
      if (state.shutdown === null || state.shutdown.version !== d['version']) return state
      // A `handoff` on a withdrawal written before #167 is read as nothing.
      // It named the commit a supervised restart checked, for the daemon the
      // supervisor started to claim — and since #159 that daemon reduces only
      // what was appended after it started, so it never saw one (0048).
      return { ...state, shutdown: null }
    }
    case 'ConductorResumed':
      return { ...state, paused: false, by: null, reason: null }
    case 'DayCeilingReached': {
      const { day, reportedUsd, estimatedUsd, ceilingUsd } = d
      // An unparseable one is the same answer as none.
      if (
        typeof day !== 'string' ||
        typeof reportedUsd !== 'number' ||
        typeof estimatedUsd !== 'number' ||
        typeof ceilingUsd !== 'number'
      ) {
        return state
      }
      return {
        ...state,
        dayCeiling: {
          ...state.dayCeiling,
          reached: { day, reportedUsd, estimatedUsd, ceilingUsd, at: e.at, seq: Number(e.seq) },
        },
      }
    }
    case 'DayCeilingLifted': {
      const raised =
        d['why'] === 'person' &&
        typeof d['day'] === 'string' &&
        typeof d['toUsd'] === 'number' &&
        typeof d['by'] === 'string'
          ? {
              day: d['day'],
              toUsd: d['toUsd'],
              ...(typeof d['fromUsd'] === 'number' ? { fromUsd: d['fromUsd'] } : {}),
              by: d['by'],
              at: e.at,
            }
          : state.dayCeiling.raised
      return { ...state, dayCeiling: { reached: null, raised } }
    }
    case 'RunRequested':
      return {
        ...state,
        requested: [
          ...state.requested,
          { project: str('project') ?? '', issue: str('issue') ?? '', by: str('by') ?? '' },
        ],
      }
    case 'ContinueRequested':
      return {
        ...state,
        continuing: [
          ...state.continuing,
          {
            project: str('project') ?? '',
            issue: str('issue') ?? '',
            runId: str('runId') ?? '',
            by: str('by') ?? '',
          },
        ],
      }
    case 'DiscussionRequested': {
      const attempt = d['attempt']
      return {
        ...state,
        discussions: [
          ...state.discussions,
          {
            chatId: str('chatId') ?? '',
            ticketId: str('ticketId') ?? '',
            attempt: typeof attempt === 'number' ? attempt : null,
            question: str('question') ?? '',
            by: str('by') ?? '',
          },
        ],
      }
    }
    default:
      return state
  }
}

/**
 * The control stream, as the state it describes.
 *
 * Reads only `CONTROL_FOLD_TYPES`; a caller that has a choice reads just those.
 * The reducer reads no clock: the one pause left is the setup's, and only a
 * person's resume ends it.
 */
export function reduceControl(events: readonly Envelope[]): ControlState {
  return reduceAll(controlReducer, events)
}

/**
 * The control reduce as a snapshottable reducer (0124 §1). Raise `version` when
 * `reduceControlEvent`'s result over the fixture changes: `unit/reducers.test.ts`.
 */
export const controlReducer: Reducer<ControlState> = {
  name: 'control',
  version: 7,
  initial: emptyControl,
  reduceEvent: reduceControlEvent,
  encode: encodeControl,
  decode: decodeControl,
}
