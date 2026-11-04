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
import { PauseCause } from './events.ts'
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
  'ContinueRequested',
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
   * the installation's, and a position on it is unique. `ConductorShutdownWithdrawn`
   * names a request by this, so withdrawing one can never lift a newer one.
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
   * When this pause lifts by itself, or null.
   *
   * Non-null only while such a pause is actually holding: once the instant has
   * passed the reducer reports the conductor as unpaused, which is what makes the
   * resume automatic rather than something a person has to remember (0031 §5).
   */
  until: Date | null
  /**
   * Whether this pause holds across a daemon restart, whatever its watermark
   * (`#405`). Sticky: a person pausing on top of a setup pause does not make
   * the setup pause forgettable, because the setup is still wrong. Cleared
   * only by `ConductorResumed`, same as `paused` itself.
   */
  holdsAcrossStarts: boolean
  /** Whose pause is standing. Null when none is, or when the pause predates `cause`. */
  cause: PauseCause | null
  /**
   * The `until` of the last day-ceiling pause that a person resumed while it
   * stood, or null. Cleared by the next day-ceiling pause, and by
   * `evaluateControl` once `now` reaches it. Null too when that pause's
   * `until` did not parse.
   */
  ceilingWaivedUntil: Date | null
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
  until: null,
  holdsAcrossStarts: false,
  cause: null,
  ceilingWaivedUntil: null,
  shutdown: null,
  requested: [],
  continuing: [],
  discussions: [],
}

/**
 * One event reduced into the state. Pure, reads no clock, and never mutates its
 * argument (0124 §2).
 */
export function reduceControlEvent(state: ControlState, e: Envelope): ControlState {
  const d = (e.data ?? {}) as Record<string, unknown>
  const str = (k: string): string | null => (typeof d[k] === 'string' ? (d[k] as string) : null)
  switch (e.type) {
    case 'ConductorPaused': {
      // Absent on every pause written before 0031, and null on every pause a
      // person makes. An unparseable one is the same answer as none: a pause
      // nothing can prove ends holds until somebody lifts it.
      const until = str('until')
      const at = until === null ? Number.NaN : Date.parse(until)
      // Absent, or a value outside the enum, is nobody's in particular (0100 §4).
      const parsed = PauseCause.safeParse(d['cause'])
      const cause = parsed.success ? parsed.data : null
      return {
        ...state,
        paused: true,
        by: str('by'),
        reason: str('reason'),
        until: Number.isNaN(at) ? null : new Date(at),
        // Sticky: a person's pause landing on top of a setup pause must not
        // make the setup pause forgettable.
        holdsAcrossStarts: state.holdsAcrossStarts || d['holdsAcrossStarts'] === true,
        cause,
        ceilingWaivedUntil: cause === 'day-ceiling' ? null : state.ceilingWaivedUntil,
      }
    }
    case 'ConductorShutdownRequested': {
      const timeout = d['timeoutMs']
      return {
        ...state,
        shutdown: {
          by: str('by') ?? '',
          reason: str('reason') ?? '',
          timeoutMs: typeof timeout === 'number' ? timeout : null,
          // Absent on every request written before `#159`, and those were all
          // drains — so the absence reads as `false` rather than as unknown.
          force: d['force'] === true,
          version: e.version,
        },
      }
    }
    case 'ConductorShutdownWithdrawn': {
      // The request named, or nothing. A withdrawal that lost a race to a
      // newer request must leave that request standing — it is somebody
      // else's, and lifting it is the one thing a restart may not do (0042).
      // A pause is untouched either way, which is the whole difference
      // between this and `ConductorResumed`.
      if (state.shutdown === null || state.shutdown.version !== d['version']) return state
      // A `handoff` on a withdrawal written before #167 is read as nothing.
      // It named the commit a supervised restart checked, for the daemon the
      // supervisor started to claim — and since #159 that daemon reduces only
      // what was appended after it started, so it never saw one (0048).
      return { ...state, shutdown: null }
    }
    case 'ConductorResumed': {
      // A person's resume of the ceiling's pause waives it until that pause's
      // midnight. A resume by `lingtai` is the ceiling lifting its own pause.
      const waived =
        state.paused && state.cause === 'day-ceiling' && str('by') !== 'lingtai'
          ? state.until
          : state.ceilingWaivedUntil
      return {
        ...state,
        paused: false,
        by: null,
        reason: null,
        until: null,
        holdsAcrossStarts: false,
        cause: null,
        ceilingWaivedUntil: waived,
        // Resume withdraws any shutdown, and it must: `ConductorShutdownWithdrawn`
        // lifts only the one request it names, and a person typing `lingtai
        // resume` means all of it. The request is in the stream for ever, so a
        // daemon started after it would find it waiting and stop again, and again.
        shutdown: null,
      }
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
 * What depends on the clock: the pause that ends by itself, ending, and a
 * ceiling waiver that has run out. Nothing is appended when it does: an expiry
 * that had to be written down would be a second thing that can be missed, and
 * the event that set it already says everything a reader needs. Returns the
 * state it was given when nothing lapses.
 */
export function evaluateControl(state: ControlState, now: Date): ControlState {
  const t = now.getTime()
  let next = state
  if (next.paused && next.until !== null && next.until.getTime() <= t) {
    next = {
      ...next,
      paused: false,
      by: null,
      reason: null,
      until: null,
      holdsAcrossStarts: false,
      cause: null,
    }
  }
  if (next.ceilingWaivedUntil !== null && next.ceilingWaivedUntil.getTime() <= t) {
    next = { ...next, ceilingWaivedUntil: null }
  }
  return next
}

/**
 * The control stream, as the state it describes.
 *
 * Reads only `CONTROL_FOLD_TYPES`; a caller that has a choice reads just those.
 *
 * `now` is a parameter because one of the answers depends on the clock — a
 * pause that carries an expiry is over when the expiry is past, and the reducer is
 * where that is decided (`evaluateControl`). It is decided here rather than by
 * whoever pauses because nothing else runs at the moment the limit lifts: the
 * alternative to reading it at reduce time is a timer somebody has to still be
 * holding.
 */
export function reduceControl(events: readonly Envelope[], now: Date = new Date()): ControlState {
  return evaluateControl(reduceAll(controlReducer, events), now)
}

/**
 * The control reduce as a snapshottable reducer (0124 §1). Raise `version` when
 * `reduceControlEvent`'s result over the fixture changes: `unit/reducers.test.ts`.
 */
export const controlReducer: Reducer<ControlState> = {
  name: 'control',
  version: 1,
  initial: emptyControl,
  reduceEvent: reduceControlEvent,
  encode: encodeControl,
  decode: decodeControl,
}
