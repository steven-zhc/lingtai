/**
 * The control reduce.
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

import { CONTROL_FOLD_TYPES, reduceControlEvent, emptyControl, isSetupPause, reduceControl } from '../src/control.ts'
import type { Envelope } from '../src/envelope.ts'
import { Actor } from '../src/envelope.ts'
import { type EventType, SCHEMA_VER, parsePayload } from '../src/events.ts'
import { histories } from '../test/histories.ts'

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

const setupPause = {
  type: 'ConductorPaused',
  data: {
    by: 'lingtai',
    reason: 'a recipe asks for sandboxed, which purecheck cannot provide',
    cause: 'setup',
    holdsAcrossStarts: true,
    until: null,
  },
}

describe('the setup is the one pause that stops the conductor (0126)', () => {
  it('reduces a tagged setup pause to a pause, with its by and reason', () => {
    const state = reduceControl(log([setupPause]))
    expect(state.paused).toBe(true)
    expect(state.by).toBe('lingtai')
    expect(state.reason).toContain('purecheck')
  })

  it('reduces a setup pause written before `cause` existed, which held across starts', () => {
    const state = reduceControl(
      log([{ type: 'ConductorPaused', data: { by: 'lingtai', reason: 'old setup', holdsAcrossStarts: true } }]),
    )
    expect(state.paused).toBe(true)
    expect(state.reason).toBe('old setup')
  })

  it('reduces every other shape of ConductorPaused to nothing', () => {
    const others = [
      { by: 'human:steven', reason: 'thinking', cause: 'person' },
      { by: 'human:steven', reason: 'thinking', cause: 'person', holdsAcrossStarts: true },
      { by: 'lingtai', reason: 'a run never started', cause: 'account-limit', until: '2026-09-10T04:00:00.000Z' },
      { by: 'lingtai', reason: 'the ceiling', cause: 'day-ceiling', until: '2026-08-03T00:00:00.000Z' },
      { by: 'human:steven', reason: 'untagged' },
      { by: 'human:steven', reason: 'untagged', holdsAcrossStarts: false },
    ]
    for (const data of others) {
      const events = log([{ type: 'ConductorPaused', data }])
      for (const e of events) parsePayload(e.type as never, e.data)
      expect(reduceControl(events), data.reason).toEqual(emptyControl)
    }
    // Not valid payloads today, but a log may hold them: a cause that is not `setup` stops nothing.
    for (const cause of ['somebody-else', null]) {
      const data = { by: 'lingtai', reason: 'odd', cause, holdsAcrossStarts: true }
      expect(reduceControl(log([{ type: 'ConductorPaused', data }]))).toEqual(emptyControl)
    }
  })

  it("leaves the setup pause's reason alone when a person's pause lands after it", () => {
    const state = reduceControl(
      log([setupPause, { type: 'ConductorPaused', data: { by: 'human:steven', reason: 'also', cause: 'person' } }]),
    )
    expect(state.paused).toBe(true)
    expect(state.by).toBe('lingtai')
    expect(state.reason).toContain('purecheck')
  })

  it('is lifted by ConductorResumed', () => {
    const state = reduceControl(log([setupPause, { type: 'ConductorResumed', data: { by: 'human:steven' } }]))
    expect(state).toEqual(emptyControl)
  })

  it('holds no matter when it is read', () => {
    expect(reduceControl(log([setupPause])).paused).toBe(true)
  })

  it('leaves a drain exactly where it found it', () => {
    const state = reduceControl(
      log([
        { type: 'ConductorShutdownRequested', data: { by: 'human:steven', reason: 'deploying', timeoutMs: null } },
        setupPause,
      ]),
    )
    expect(state.paused).toBe(true)
    expect(state.shutdown?.reason).toBe('deploying')
  })

  it('isSetupPause says the same of a bare payload', () => {
    expect(isSetupPause({ cause: 'setup' })).toBe(true)
    expect(isSetupPause({ holdsAcrossStarts: true })).toBe(true)
    expect(isSetupPause({ holdsAcrossStarts: false })).toBe(false)
    expect(isSetupPause({})).toBe(false)
    expect(isSetupPause({ cause: 'person', holdsAcrossStarts: true })).toBe(false)
    expect(isSetupPause({ cause: null, holdsAcrossStarts: true })).toBe(false)
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
    )

    // A resume lifts a pause. It does not withdraw a question.
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
        {
          type: 'ConductorPaused',
          data: { by: 'human:ops', reason: 'the importer is flaky', cause: 'setup', holdsAcrossStarts: true },
        },
        asked('human:steven', 'restarting: picking up #88'),
        { type: 'ConductorShutdownWithdrawn', data: { by: 'human:steven', version: 2, reason: 'restarted' } },
      ]),
    )

    expect(state.shutdown).toBeNull()
    expect(state.paused).toBe(true)
    expect(state.by).toBe('human:ops')
    expect(state.reason).toBe('the importer is flaky')
  })

  it('is not lifted by a resume, which still lifts the pause beside it (0126)', () => {
    const state = reduceControl(
      log([
        { type: 'ConductorPaused', data: { by: 'human:ops', reason: 'x', cause: 'setup', holdsAcrossStarts: true } },
        asked('human:steven', 'restarting'),
        { type: 'ConductorResumed', data: { by: 'human:steven' } },
      ]),
    )

    expect(state.paused).toBe(false)
    expect(state.shutdown).toMatchObject({ by: 'human:steven', version: 2 })
  })

  it('does not lift a newer request somebody else made', () => {
    const state = reduceControl(
      log([
        asked('human:steven', 'restarting: picking up #88'),
        asked('human:ops', 'the database is being moved'),
        { type: 'ConductorShutdownWithdrawn', data: { by: 'human:steven', version: 1, reason: 'restarted' } },
      ]),
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
    const state = reduceControl(log([asked, handed, started]))
    expect(state.shutdown).toBeNull()
    expect(Object.keys(state).sort()).toEqual([
      'by',
      'continuing',
      'dayCeiling',
      'discussions',
      'paused',
      'reason',
      'requested',
      'shutdown',
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
    expect(reduceControl(only)).toEqual(reduceControl(all))
  })
})

describe('the control reduce in two halves (#836)', () => {
  it('0124 §2: reducing does not write into emptyControl', () => {
    reduceControl(histories.control.requestsQueued)
    expect(emptyControl.requested).toEqual([])
    expect(emptyControl.continuing).toEqual([])
    expect(emptyControl.discussions).toEqual([])
  })

  it('0124 §2: reduceControlEvent is the whole fold of the fixture', () => {
    const applied = histories.control.requestsQueued.reduce(reduceControlEvent, emptyControl)
    expect(applied).toEqual(reduceControl(histories.control.requestsQueued))
  })
})

describe('ConductorStarted ends a standing shutdown (0126)', () => {
  const ask = { type: 'ConductorShutdownRequested', data: { by: 'steven', reason: 'x', timeoutMs: null } }
  const started = {
    type: 'ConductorStarted',
    data: { by: 'daemon', reason: null, sha: null, dirty: false, worker: 'w', handoff: null },
  }

  it('a start after a request ends it', () => {
    expect(reduceControl(log([ask, started])).shutdown).toBeNull()
  })

  it('a request after a start stands', () => {
    expect(reduceControl(log([started, ask])).shutdown).toMatchObject({ by: 'steven', reason: 'x' })
  })

  it('a start leaves a pause and the requests as they were', () => {
    const run = { type: 'RunRequested', data: { project: 'p', issue: '1', by: 'steven' } }
    const wait = { type: 'ContinueRequested', data: { project: 'p', issue: '2', by: 'steven' } }
    const talk = { type: 'DiscussionRequested', data: { chatId: 'c', ticketId: 't', attempt: 1 } }
    const before = reduceControl(log([setupPause, run, wait, talk, ask]))
    const after = reduceControl(log([setupPause, run, wait, talk, ask, started]))
    expect(before.continuing.length).toBeGreaterThan(0)
    expect(before.discussions.length).toBeGreaterThan(0)
    expect(before.shutdown).not.toBeNull()
    expect(before.paused).toBe(true)
    expect(before.requested.length).toBeGreaterThan(0)
    expect(after).toEqual({ ...before, shutdown: null })
  })
})

describe('the day ceiling pair (#1003)', () => {
  const REACHED = { day: '2026-11-11', reportedUsd: 20, estimatedUsd: 5, ceilingUsd: 25 }

  it('DayCeilingReached sets reached, with its time and position', () => {
    const state = reduceControl(log([{ type: 'DayCeilingReached', data: REACHED }]))
    expect(state.dayCeiling.reached).toMatchObject({ ...REACHED, seq: 1 })
    expect(state.dayCeiling.raised).toBeNull()
  })

  it('DayCeilingLifted clears reached; a system lift sets no raise', () => {
    const state = reduceControl(
      log([
        { type: 'DayCeilingReached', data: REACHED },
        { type: 'DayCeilingLifted', data: { day: REACHED.day, why: 'new-day' } },
      ]),
    )
    expect(state.dayCeiling).toEqual({ reached: null, raised: null })
  })

  it('a person’s lift also sets raised', () => {
    const state = reduceControl(
      log([
        { type: 'DayCeilingReached', data: REACHED },
        { type: 'DayCeilingLifted', data: { day: REACHED.day, why: 'person', by: 'human:steven', toUsd: 40 } },
      ]),
    )
    expect(state.dayCeiling.reached).toBeNull()
    expect(state.dayCeiling.raised).toMatchObject({ day: REACHED.day, toUsd: 40, by: 'human:steven' })
  })

  it('a system lift leaves an earlier raise standing', () => {
    const state = reduceControl(
      log([
        { type: 'DayCeilingLifted', data: { day: REACHED.day, why: 'person', by: 'human:steven', toUsd: 40 } },
        { type: 'DayCeilingLifted', data: { day: REACHED.day, why: 'config-raised' } },
      ]),
    )
    expect(state.dayCeiling.raised?.toUsd).toBe(40)
  })

  it('neither touches the pause, its cause or the waiver', () => {
    const base = reduceControl(
      log([{ type: 'ConductorPaused', data: { by: 'human:steven', reason: 'r', until: null, cause: 'person' } }]),
    )
    const after = reduceControl(
      log([
        { type: 'ConductorPaused', data: { by: 'human:steven', reason: 'r', until: null, cause: 'person' } },
        { type: 'DayCeilingReached', data: REACHED },
        { type: 'DayCeilingLifted', data: { day: REACHED.day, why: 'person', by: 'human:steven', toUsd: 40 } },
      ]),
    )
    expect({ ...after, dayCeiling: base.dayCeiling }).toEqual(base)
  })

  it('an unparseable reached is the same answer as none', () => {
    const state = reduceControl(log([{ type: 'DayCeilingReached', data: { day: 5 } }]))
    expect(state.dayCeiling.reached).toBeNull()
  })
})
