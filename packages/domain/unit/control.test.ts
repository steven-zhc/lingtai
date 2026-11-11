/**
 * The control reduce, and the one thing in it that ends by itself.
 *
 * `ConductorPaused` carrying an `until` is
 * [0031](../../../doc/decisions-archive/0031-a-run-that-never-started.md) §5 — the
 * first control state that lifts without anybody acting. The number it exists
 * to remove is twelve minutes: the limit lifted at 23:00 and the queue was
 * still idle at 23:12, waiting out a flat hour while the reset time sat in the
 * message it had been handed six times.
 *
 * The tests that matter here are the ones about what must **not** expire. A
 * pause a person made holds until they lift it, and a drain is a separate fact
 * that an expiring pause has no business touching.
 */
import { describe, expect, it } from 'vitest'

import {
  CONTROL_FOLD_TYPES,
  reduceControlEvent,
  emptyControl,
  evaluateControl,
  reduceControl,
  scopeControl,
} from '../src/control.ts'
import type { Envelope } from '../src/envelope.ts'
import { Actor } from '../src/envelope.ts'
import { type EventType, SCHEMA_VER } from '../src/events.ts'
import { NOW as NOW_FIXTURE, histories, lateHistories } from '../test/histories.ts'

function log(events: { type: string; data: unknown }[]): Envelope[] {
  return events.map(
    (e, i) =>
      ({
        seq: BigInt(i + 1),
        streamId: 'ctl-conductor',
        version: i + 1,
        type: e.type,
        schemaVer: 1,
        data: e.data,
        actor: 'conductor',
        causation: null,
        at: new Date(),
      }) as Envelope,
  )
}

const NOW = new Date('2026-09-09T08:44:14Z')
const RESET = '2026-09-10T04:00:00.000Z'

const quotaPause = {
  type: 'ConductorPaused',
  data: { by: 'lingtai', reason: 'a run ended without ever starting', until: RESET },
}

describe('a pause that ends by itself', () => {
  it('holds until the instant it named', () => {
    const state = reduceControl(log([quotaPause]), NOW)

    expect(state.paused).toBe(true)
    expect(state.by).toBe('lingtai')
    expect(state.until?.toISOString()).toBe(RESET)
  })

  /**
   * Nothing is appended when it ends, and nothing has to be. The event that set
   * the expiry already says everything a reader needs, and an expiry that had
   * to be written down would be a second thing that can be missed — by exactly
   * the process that is not running, which is the case this exists for.
   */
  it('is over at that instant, with nobody having done anything', () => {
    const state = reduceControl(log([quotaPause]), new Date(RESET))

    expect(state.paused).toBe(false)
    expect(state.until).toBeNull()
    expect(state.reason).toBeNull()
  })

  /**
   * The half that must not start working. `lingtai pause` is somebody deciding
   * to stop the conductor, and a pause that quietly resumed itself would be a
   * hold they thought they had.
   */
  it("is not what a person's pause is", () => {
    const events = log([{ type: 'ConductorPaused', data: { by: 'human:steven', reason: 'thinking' } }])
    const state = reduceControl(events, new Date('2027-01-01T00:00:00Z'))

    expect(state.paused).toBe(true)
    expect(state.until).toBeNull()
    expect(state.by).toBe('human:steven')
  })

  /** A pause written before `until` existed is the pause it always was. */
  it('reads an unparseable or absent expiry as no expiry at all', () => {
    for (const until of [undefined, null, '', "eleven o'clock"]) {
      const events = log([{ type: 'ConductorPaused', data: { by: 'x', reason: 'y', until } }])
      const state = reduceControl(events, new Date('2099-01-01T00:00:00Z'))
      expect(state.paused, String(until)).toBe(true)
    }
  })

  it('is lifted early by a person, like any other', () => {
    const state = reduceControl(log([quotaPause, { type: 'ConductorResumed', data: { by: 'human:steven' } }]), NOW)

    expect(state.paused).toBe(false)
    expect(state.until).toBeNull()
  })

  /**
   * 0031's last consequence: a drain and a quota pause **compose**. One stops
   * taking work and exits, the other stops taking work and resumes, and they
   * are separate fields because they are separate facts (#77). An expiring
   * pause that cleared the drain would restart a daemon somebody had asked to
   * stop.
   */
  it('leaves a drain exactly where it found it, expired or not', () => {
    const events = log([
      { type: 'ConductorShutdownRequested', data: { by: 'human:steven', reason: 'deploying', timeoutMs: null } },
      quotaPause,
    ])

    const holding = reduceControl(events, NOW)
    expect(holding.paused).toBe(true)
    expect(holding.shutdown?.reason).toBe('deploying')

    const lifted = reduceControl(events, new Date(RESET))
    expect(lifted.paused).toBe(false)
    expect(lifted.shutdown?.reason).toBe('deploying')
  })
})

/**
 * **The one pause a daemon obeys whatever its watermark says** (`#405`).
 *
 * `readControl(store, since)` (`packages/daemon/src/control.ts`) is the reader
 * that cares about this field; `reduceControl` only has to reduce it correctly
 * and clear it with everything else a resume clears.
 */
describe('holdsAcrossStarts', () => {
  it('defaults to false on a pause written without the field', () => {
    const state = reduceControl(log([{ type: 'ConductorPaused', data: { by: 'lingtai', reason: 'y' } }]), NOW)
    expect(state.holdsAcrossStarts).toBe(false)
  })

  it('is false on an ordinary pause and true on one marked for it', () => {
    const ordinary = reduceControl(
      log([{ type: 'ConductorPaused', data: { by: 'human:steven', reason: 'thinking', holdsAcrossStarts: false } }]),
      NOW,
    )
    expect(ordinary.holdsAcrossStarts).toBe(false)

    const marked = reduceControl(
      log([
        {
          type: 'ConductorPaused',
          data: { by: 'lingtai', reason: 'purecheck cannot provide sandboxed', holdsAcrossStarts: true },
        },
      ]),
      NOW,
    )
    expect(marked.holdsAcrossStarts).toBe(true)
  })

  /**
   * **Sticky.** A person pausing on top of the conductor's own setup pause
   * must not make the setup pause forgettable — the setup is still wrong, so
   * a restart still has to meet it.
   */
  it('stays true once set, even under a later pause that is not marked', () => {
    const state = reduceControl(
      log([
        { type: 'ConductorPaused', data: { by: 'lingtai', reason: 'setup', holdsAcrossStarts: true } },
        { type: 'ConductorPaused', data: { by: 'human:steven', reason: 'also looking at this' } },
      ]),
      NOW,
    )
    expect(state.paused).toBe(true)
    expect(state.holdsAcrossStarts).toBe(true)
  })

  it('is cleared by ConductorResumed, like every other fact about the pause', () => {
    const state = reduceControl(
      log([
        { type: 'ConductorPaused', data: { by: 'lingtai', reason: 'setup', holdsAcrossStarts: true } },
        { type: 'ConductorResumed', data: { by: 'human:steven' } },
      ]),
      NOW,
    )
    expect(state.paused).toBe(false)
    expect(state.holdsAcrossStarts).toBe(false)
  })
})

/**
 * A question is a control instruction, so it lands where `pause` and `now` do
 * ([0033](../../../doc/decisions-archive/0033-the-third-kind-of-agent.md) §3).
 */
describe('the discussions somebody asked for', () => {
  it('keeps every request, in order, answered or not', () => {
    const state = reduceControl(
      log([
        {
          type: 'DiscussionRequested',
          data: {
            chatId: 'chat-1',
            ticketId: 'ticket-lingtai-89',
            attempt: 2,
            question: 'why did attempt 2 produce nothing?',
            by: 'human:steven',
          },
        },
        {
          type: 'DiscussionRequested',
          data: {
            chatId: 'chat-1',
            ticketId: 'ticket-lingtai-89',
            attempt: null,
            question: 'and the first?',
            by: 'human:steven',
          },
        },
      ]),
      NOW,
    )

    expect(state.discussions).toHaveLength(2)
    expect(state.discussions[0]?.attempt).toBe(2)
    // A follow-up carries the same chat id: a conversation is a stream, not a
    // session, and nothing has to still be running between two questions.
    expect(state.discussions[1]?.chatId).toBe('chat-1')
  })

  /**
   * Whether a question has been *answered* is a fact on `chat-<id>`, so this
   * reduce deliberately does not know it. Filtering here would put the second
   * half of a state machine on the control stream, which is the thing
   * `RunRequested` refuses to do.
   */
  it('does not decide whether a request is outstanding', () => {
    const state = reduceControl(
      log([
        {
          type: 'DiscussionRequested',
          data: { chatId: 'chat-1', ticketId: 'ticket-lingtai-89', attempt: null, question: '?', by: 'human:steven' },
        },
        { type: 'ConductorResumed', data: { by: 'human:steven' } },
      ]),
      NOW,
    )

    // A resume lifts a pause and a drain. It does not withdraw a question.
    expect(state.discussions).toHaveLength(1)
  })
})

/**
 * `lingtai restart` lifts the drain it asked for and nothing else (0042). The
 * first attempt at that resumed — which lifts a pause and *any* request — and
 * then re-appended the pause, so a person's pause and a second person's drain
 * were both one race away from being overruled by a command about neither.
 */
describe('withdrawing one shutdown request', () => {
  const asked = (by: string, reason: string) => ({
    type: 'ConductorShutdownRequested',
    data: { by, reason, timeoutMs: null },
  })

  it('lifts the request it names, and leaves a pause exactly as it was', () => {
    const state = reduceControl(
      log([
        { type: 'ConductorPaused', data: { by: 'human:ops', reason: 'the importer is flaky', until: null } },
        asked('human:steven', 'restarting: picking up #88'),
        { type: 'ConductorShutdownWithdrawn', data: { by: 'human:steven', version: 2, reason: 'restarted' } },
      ]),
      NOW,
    )

    expect(state.shutdown).toBeNull()
    expect(state.paused).toBe(true)
    expect(state.by).toBe('human:ops')
    expect(state.reason).toBe('the importer is flaky')
  })

  it('does not lift a newer request somebody else made', () => {
    const state = reduceControl(
      log([
        asked('human:steven', 'restarting: picking up #88'),
        asked('human:ops', 'the database is being moved'),
        { type: 'ConductorShutdownWithdrawn', data: { by: 'human:steven', version: 1, reason: 'restarted' } },
      ]),
      NOW,
    )

    expect(state.shutdown).toEqual({
      by: 'human:ops',
      reason: 'the database is being moved',
      timeoutMs: null,
      force: false,
      version: 2,
    })
  })
})

/**
 * The handoff is gone (#167, 0048). It was reduced for a daemon the supervisor
 * started to claim, and since #159 that daemon reduces nothing older than itself,
 * so it never did. What is on the log from before still has to reduce.
 */
describe('a withdrawal written with a handoff, before #167', () => {
  const asked = {
    type: 'ConductorShutdownRequested',
    data: { by: 'human:steven', reason: 'restarting', timeoutMs: null },
  }
  const handed = {
    type: 'ConductorShutdownWithdrawn',
    data: {
      by: 'human:steven',
      version: 1,
      reason: 'restarted: picking up #88',
      handoff: { sha: '2926f2d', dirty: false },
    },
  }
  const started = {
    type: 'ConductorStarted',
    data: { by: 'daemon', reason: null, sha: '2926f2d', dirty: false, worker: 'h:1', handoff: 2 },
  }

  it('lifts the request it names, and leaves nothing else in the state', () => {
    const state = reduceControl(log([asked, handed, started]), NOW)
    expect(state.shutdown).toBeNull()
    expect(Object.keys(state).sort()).toEqual([
      'by',
      'cause',
      'ceilingWaivedUntil',
      'continuing',
      'discussions',
      'holdsAcrossStarts',
      'paused',
      'pausedAt',
      'reason',
      'requested',
      'shutdown',
      'until',
    ])
  })
})

/**
 * Who may append, and the one that could not (`#159`).
 *
 * `ConductorStarted.by` has always documented `daemon` as what a supervisor's
 * start is recorded as — launchd's `KeepAlive`, a systemd unit, a `nohup` —
 * "because the log saying a person started what launchd started by itself is
 * the unattributable 23:06 again". `Actor` did not admit it, so every one of
 * those appends failed and printed its ZodError into a log nobody reads. The
 * documented design, refused by the validator.
 *
 * What it cost is what 0042 exists to prevent: *who restarted it at 23:06* was
 * unanswerable for exactly the starts nobody witnessed. This is the assertion
 * that stops it going quiet again.
 */
describe('ContinueRequested (#465)', () => {
  it('reduces into continuing, oldest first', () => {
    const state = reduceControl(
      log([
        {
          type: 'ContinueRequested',
          data: { project: 'lingtai', issue: '465', runId: 'pass-465', by: 'human:steven' },
        },
        {
          type: 'ContinueRequested',
          data: { project: 'lingtai', issue: '470', runId: 'pass-470', by: 'human:steven' },
        },
      ]),
      NOW,
    )
    expect(state.continuing).toEqual([
      { project: 'lingtai', issue: '465', runId: 'pass-465', by: 'human:steven' },
      { project: 'lingtai', issue: '470', runId: 'pass-470', by: 'human:steven' },
    ])
  })
})

describe('who may append', () => {
  it("accepts a supervisor's start", () => {
    expect(Actor.safeParse('daemon').success).toBe(true)
  })

  it('accepts the other four', () => {
    for (const who of ['conductor', 'github', 'agent:pass-1a2b', 'human:steven']) {
      expect(Actor.safeParse(who).success, who).toBe(true)
    }
  })

  it('still refuses a name that is none of them', () => {
    // The point of the pattern: an actor is a closed set, so a typo is a
    // refusal rather than a new kind of appender nobody decided on.
    for (const who of ['', 'launchd', 'human:', 'agent:', 'Daemon']) {
      expect(Actor.safeParse(who).success, who).toBe(false)
    }
  })
})

describe('CONTROL_FOLD_TYPES (#796)', () => {
  // One payload that satisfies every case in the reducer, so that each handled
  // type changes the state — a type missing from the set would otherwise reduce
  // to the same state either way and the test would pass anyway.
  const universal = {
    by: 'someone',
    reason: 'why',
    project: 'p',
    issue: 1,
    runId: 'pass-1',
    chatId: 'chat-1',
    ticketId: 'p#1',
    question: 'q',
    attempt: 1,
    version: 1,
  }
  const base = { type: 'ConductorShutdownRequested', data: { by: 'a', reason: 'drain' } }
  const catalogue = Object.keys(SCHEMA_VER) as EventType[]

  it.each(catalogue)('%s: reducing only the set gives the state reducing everything does', (type) => {
    const all = log([base, { type, data: universal }])
    const only = all.filter((e) => (CONTROL_FOLD_TYPES as readonly string[]).includes(e.type))
    expect(reduceControl(only, NOW)).toEqual(reduceControl(all, NOW))
  })
})

describe('the control reduce in two halves (#836)', () => {
  const cells = lateHistories.control

  it('D8: a person’s resume of the ceiling’s pause waives it until that pause’s midnight', () => {
    const c = reduceControl(cells.ceilingResumedByPerson, NOW_FIXTURE)
    expect(c.paused).toBe(false)
    expect(c.cause).toBeNull()
    expect(c.ceilingWaivedUntil?.toISOString()).toBe('2026-09-02T00:00:00.000Z')
  })

  it('D8: the ceiling lifting its own pause waives nothing', () => {
    expect(reduceControl(cells.ceilingResumedByLingtai, NOW_FIXTURE).ceilingWaivedUntil).toBeNull()
  })

  it('D8: a person’s pause on top of the ceiling’s is theirs, and their resume waives nothing', () => {
    const standing = reduceControl(cells.ceilingThenPersonPause.slice(0, 2), NOW_FIXTURE)
    expect(standing.cause).toBe('person')
    expect(reduceControl(cells.ceilingThenPersonPause, NOW_FIXTURE).ceilingWaivedUntil).toBeNull()
  })

  it('D8: a new ceiling pause clears the waiver', () => {
    const c = reduceControl(cells.ceilingWaivedThenRepaused, NOW_FIXTURE)
    expect(c.paused).toBe(true)
    expect(c.cause).toBe('day-ceiling')
    expect(c.ceilingWaivedUntil).toBeNull()
  })

  it('D8: a waiver whose midnight has already passed is no waiver', () => {
    expect(reduceControl(cells.ceilingLapsedThenResumed, NOW_FIXTURE).ceilingWaivedUntil).toBeNull()
  })

  it('0124 §2: reduceControlEvent reads no clock, and evaluateControl lapses a timed pause', () => {
    const applied = histories.control.pausedUntilLifted.reduce(reduceControlEvent, emptyControl)
    expect(applied.paused).toBe(true)
    const evaluated = evaluateControl(applied, NOW_FIXTURE)
    expect(evaluated.paused).toBe(false)
    expect(evaluated.until).toBeNull()
    // Nothing lapsing hands back the very state it was given.
    expect(evaluateControl(evaluated, NOW_FIXTURE)).toBe(evaluated)
  })

  it('0124 §2: reducing does not write into emptyControl', () => {
    reduceControl(histories.control.requestsQueued, NOW_FIXTURE)
    expect(emptyControl.requested).toEqual([])
    expect(emptyControl.continuing).toEqual([])
    expect(emptyControl.discussions).toEqual([])
  })

  it('0100 §4: a pause with no cause is nobody’s in particular', () => {
    const paused = (data: Record<string, unknown>) =>
      reduceControl(log([{ type: 'ConductorPaused', data: { by: 'lingtai', reason: 'old', ...data } }]), NOW)
    expect(paused({}).cause).toBeNull()
    expect(paused({ cause: 'not-a-cause' }).cause).toBeNull()
    expect(paused({ cause: 'setup' }).cause).toBe('setup')
  })
})

describe('pausedAt and scopeControl (#874)', () => {
  const pause = (until: string | null = null) => ({
    type: 'ConductorPaused',
    data: { by: 'steven', reason: 'r', until },
  })
  const ask = { type: 'ConductorShutdownRequested', data: { by: 'steven', reason: 'x', timeoutMs: null } }

  it('is the version of the standing pause, and clears on resume and on expiry', () => {
    const at = new Date('2026-01-01T00:00:00Z')
    expect(reduceControl(log([ask, pause()]), at).pausedAt).toBe(2)
    expect(reduceControl(log([pause(), { type: 'ConductorResumed', data: { by: 'steven' } }]), at).pausedAt).toBeNull()
    const timed = log([pause('2026-01-01T01:00:00Z')])
    expect(reduceControl(timed, at).pausedAt).toBe(1)
    expect(reduceControl(timed, new Date('2026-01-01T02:00:00Z')).pausedAt).toBeNull()
  })

  it('is the identity at since 0', () => {
    const state = reduceControl(log([pause(), ask]), NOW)
    expect(scopeControl(state, 0)).toBe(state)
  })

  it('clears a pause at the watermark and keeps one after it', () => {
    const state = reduceControl(log([pause()]), NOW)
    expect(scopeControl(state, 1)).toMatchObject({ paused: false, pausedAt: null, by: null, reason: null })
    expect(scopeControl(state, 0).paused).toBe(true)
  })

  it('keeps a pause that holds across starts, below the watermark', () => {
    const holding = { type: 'ConductorPaused', data: { by: 'lingtai', reason: 'r', holdsAcrossStarts: true } }
    const state = reduceControl(log([holding]), NOW)
    expect(scopeControl(state, 5).paused).toBe(true)
  })

  it('no longer changes a shutdown at any watermark, and keeps a pause above it', () => {
    const state = reduceControl(log([ask, pause()]), NOW)
    for (const since of [0, 1, 5]) expect(scopeControl(state, since).shutdown).toEqual(state.shutdown)
    expect(scopeControl(state, 1).paused).toBe(true)
  })
})

describe('ConductorStarted ends a standing shutdown (0126)', () => {
  const ask = { type: 'ConductorShutdownRequested', data: { by: 'steven', reason: 'x', timeoutMs: null } }
  const started = { type: 'ConductorStarted', data: { by: 'daemon', reason: null, sha: null, dirty: false, worker: 'w', handoff: null } }

  it('a start after a request ends it', () => {
    expect(reduceControl(log([ask, started]), NOW).shutdown).toBeNull()
  })

  it('a request after a start stands', () => {
    expect(reduceControl(log([started, ask]), NOW).shutdown).toMatchObject({ by: 'steven', reason: 'x' })
  })

  it('a start leaves a pause and the requests as they were', () => {
    const run = { type: 'RunRequested', data: { project: 'p', issue: '1', by: 'steven' } }
    const before = reduceControl(log([quotaPause, run]), NOW)
    const after = reduceControl(log([quotaPause, run, started]), NOW)
    expect(after).toEqual(before)
  })
})
