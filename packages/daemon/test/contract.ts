/**
 * What a `DaemonStore` is, stated once and run against every implementation.
 *
 * **This file is why there can be two of them** (#220). An interface with one
 * implementation is a shape; an interface with two and no contract is a pair of
 * codebases that agree until the day they do not. So the behaviours are written
 * down here, once, and both stores are run against them:
 *
 * - `integration/daemon-store.test.ts` runs it against Postgres, where a database is
 *   available. That run is what says the beacon `lingtai doctor` and the board
 *   read answers this way.
 * - `integration/sqlite.test.ts` runs it against `createSqliteDaemonStore`, where none
 *   is. That run is what says a laptop with nothing installed can be asked
 *   whether a daemon is up.
 *
 * ## It asserts a *mutable row*, and none of the event store's contract transfers
 *
 * `event-store/test/contract.ts` is about append-and-replay: nothing it says is
 * true of `daemon_status`, which is one row that is written over. So what is
 * asserted here is what a beacon has to be:
 *
 * - **liveness** — a beat lands and a later read sees it, near enough to now
 *   that `lastBeat` calls it up;
 * - **last-write-wins** — one row, and the last word written is the word read,
 *   whichever process wrote it. The row's *beginning* survives the overwriting,
 *   which is what makes a beat an update of a running daemon rather than a new
 *   life for it;
 * - **stopped is not never-started** — a daemon that died leaves a row that has
 *   gone stale, and a machine where none has ever run has no row at all. Both
 *   are ordinary answers, and every reader of this row — two `doctor` rows,
 *   three chips on the board — says a different sentence about each.
 *
 * ## And the control stream beside it, because they are one question
 *
 * *Is a daemon up* is the beacon; *is it being told anything* is the log. The
 * store names which log, so the watermark (`#159`) — the reason a fresh daemon
 * ignores a drain that was already acted on — is asserted here too, against
 * whichever log the implementation under test carries.
 *
 * Written against **properties, not a database**: nothing below names a
 * dialect, a connection or a driver. That is the rule that let
 * `event-store/test/contract.ts` be passed unchanged by a store written months
 * later (#178).
 */
import { CONTROL_STREAM, parsePayload } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store/store'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  startBeacon,
  readControl,
  recordStartEffect,
  requestShutdownUnlessStandingEffect,
  resumeConductor,
} from '../src/control.ts'
import { STALE_AFTER_MS, lastBeat, type Beat, type DaemonStore } from '../src/store.ts'

const recordStart = (...args: Parameters<typeof recordStartEffect>) => Effect.runPromise(recordStartEffect(...args))

export interface DaemonFixture {
  /** The store under test. */
  store: DaemonStore
  /** A second store over the same beacon and the same log — what "two processes" means. */
  another(): Promise<DaemonStore>
  /**
   * Removes the beacon's row, leaving the state a machine is in before any
   * daemon has ever run.
   *
   * A fixture's rather than the contract's, because "no row" is the one thing
   * this interface cannot express: a store writes beats and reads them, and
   * nothing in it deletes. Postgres shares one row with the rest of the suite,
   * so a test that left one behind would tell the next file a daemon is up.
   */
  forget(): Promise<void>
  /**
   * A `like` pattern matching every stream `stream()` hands out, and nothing
   * else in the log.
   *
   * The fixture's, because only it knows what it named its throwaway project —
   * and `streams()` is asked in exactly this shape by `reconcile`.
   */
  prefix: string
  /** A work-item stream id nothing else in the log uses. */
  stream(issue: number): string
  /** Closes everything this fixture opened. */
  close(): Promise<void>
}

/** A beat with everything named, so an assertion can be about one field. */
function beating(over: Partial<Beat> = {}): Beat {
  return {
    pid: 4242,
    host: 'contract-host',
    state: 'up',
    currentRunId: null,
    codeSha: null,
    codeDirty: false,
    fresh: false,
    startedAt: null,
    ...over,
  }
}

const claimed = (runId: string) => ({
  type: 'TicketClaimed',
  actor: 'conductor',
  data: { runId, worker: 'local:1', title: null, kind: 'bug' },
})

/**
 * Puts the control stream back to *nobody is being told anything*, by
 * appending.
 *
 * **The reset that makes the control-stream half of this contract survivable.**
 * `ctl-conductor` is one stream for the whole installation and Postgres's log
 * is append-only and shared: a run killed between asking for a drain and
 * withdrawing it — Ctrl+C, a dropped connection — leaves a request standing,
 * and the next run's `requestShutdownUnlessStanding` then finds it and appends
 * nothing at all. `asked` is `false`, the assertion fails, and no rerun and no
 * teardown repairs it: a log that does not delete has no `delete` to offer.
 *
 * So the repair is two events, one per thing that can stand: `ConductorStarted`
 * ends a drain (0126), and `ConductorResumed` lifts a pause. It is run
 * before every assertion as well as after one, which is what makes an
 * interrupted run cost the next one nothing.
 *
 * Silent when there is nothing to lift, and that is the ordinary case: on a
 * fresh SQLite file it is one read of an empty stream.
 */
async function quiesceControl(events: EventStore): Promise<void> {
  const state = await readControl(events)
  if (state.shutdown !== null) {
    // `since` of Infinity: every standing request is an earlier process's.
    await recordStart('human:contract', null, { sha: null, dirty: false }, Number.POSITIVE_INFINITY, events)
  }
  if (state.paused) await resumeConductor('human:contract', events)
}

export function describeDaemonStoreContract(name: string, open: () => Promise<DaemonFixture>): void {
  /** Opened per assertion: a store that leaked between them would hide a leak. */
  async function withStore<T>(fn: (f: DaemonFixture) => Promise<T>): Promise<T> {
    const fixture = await open()
    try {
      await Effect.runPromise(fixture.store.create())
      // Every assertion starts where a fresh machine does: the table exists,
      // nothing has beaten, and nothing is being said to the conductor.
      // Postgres shares both the row and `ctl-conductor` with the rest of the
      // suite, so this is what makes the order of these tests not matter — and
      // what makes a previous run that died half way through not matter either.
      await fixture.forget()
      await quiesceControl(fixture.store.events)
      return await fn(fixture)
    } finally {
      // Here rather than in a `try` around each pair below, so that no
      // assertion can be written without it: every one of them leaves the
      // beacon and the control stream as it found them, however it ends.
      await fixture.forget().catch(() => {})
      await quiesceControl(fixture.store.events).catch(() => {})
      await fixture.close().catch(() => {})
    }
  }

  describe(`${name}: the beacon`, () => {
    it('has no row until something beats, and says so rather than guessing', async () => {
      await withStore(async ({ store }) => {
        expect(await Effect.runPromise(store.status())).toBeNull()
      })
    })

    it('lands a beat that a later read sees, and reads as up', async () => {
      await withStore(async ({ store }) => {
        await Effect.runPromise(store.beat(beating({ state: 'starting', currentRunId: 'pass-1', codeSha: 'abc1234' })))

        const status = await Effect.runPromise(store.status())
        expect(status).not.toBeNull()
        expect(status!.pid).toBe(4242)
        expect(status!.host).toBe('contract-host')
        expect(status!.state).toBe('starting')
        expect(status!.currentRunId).toBe('pass-1')
        expect(status!.codeSha).toBe('abc1234')
        expect(status!.codeDirty).toBe(false)
        // The whole point of the row: `lingtai doctor` and the board's health
        // dot decide on the age, and the age has to be near enough to now.
        expect(lastBeat(status!).up).toBe(true)
        expect(lastBeat(status!).state).toBe('starting')
      })
    })

    it('carries a dirty worktree and an absent commit back exactly as written', async () => {
      // `code_dirty` is a boolean in one store and an integer in the other, and
      // `code_sha` is null on every daemon older than #98. Both are read by
      // `daemon: currency` to decide whether a restart is owed.
      await withStore(async ({ store }) => {
        await Effect.runPromise(store.beat(beating({ codeSha: 'def5678', codeDirty: true })))
        expect((await Effect.runPromise(store.status()))!.codeDirty).toBe(true)

        await Effect.runPromise(store.beat(beating({ codeSha: null, codeDirty: false })))
        const later = await Effect.runPromise(store.status())
        expect(later!.codeSha).toBeNull()
        expect(later!.codeDirty).toBe(false)
      })
    })

    it('keeps the last word, whichever process wrote it, and one row for all of them', async () => {
      await withStore(async (fixture) => {
        const { store } = fixture
        await Effect.runPromise(store.beat(beating({ state: 'starting' })))
        const first = await Effect.runPromise(store.status())

        // Past the clock's resolution, so "replaced" and "kept" read differently.
        await new Promise((resolve) => setTimeout(resolve, 25))
        const second = await fixture.another()
        try {
          await Effect.runPromise(
            second.beat(beating({ state: 'draining', pid: 9999, currentRunId: 'pass-2', fresh: true })),
          )
        } finally {
          await Effect.runPromise(second.close())
        }

        // One row: the second process did not add a beacon of its own, it
        // overwrote the one there is. Two daemons cannot both be up — the
        // conductor lock sees to that — so a second row would be a lie.
        const status = await Effect.runPromise(store.status())
        expect(status!.state).toBe('draining')
        expect(status!.pid).toBe(9999)
        expect(status!.currentRunId).toBe('pass-2')
        // A new process's first beat begins the row again: `started_at` is
        // what an interrupted triage is read against, so it is this life's.
        expect(status!.startedAt.getTime()).toBeGreaterThan(first!.startedAt.getTime())
        const begun = status!.startedAt.getTime()
        // And a beat that is not fresh leaves it where it is.
        await Effect.runPromise(store.beat(beating({ state: 'up' })))
        expect((await Effect.runPromise(store.status()))!.startedAt.getTime()).toBe(begun)
        // Beating moves, because that is the only field liveness is read from.
        expect(status!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(first!.lastSeenAt.getTime())
      })
    })

    it('tells a daemon that stopped from one that never started', async () => {
      await withStore(async ({ store }) => {
        // Never started: no row at all, and a reader says "no daemon has run —
        // lingtai run works by hand".
        expect(await Effect.runPromise(store.status())).toBeNull()

        // Stopped: a row, holding the word the process last said, and stale.
        // The clock is the reader's, so this needs no wait — what the contract
        // asserts is that the *row* carries enough to decide it.
        await Effect.runPromise(store.beat(beating({ state: 'stopping' })))
        const status = await Effect.runPromise(store.status())
        expect(status).not.toBeNull()

        const later = status!.lastSeenAt.getTime() + STALE_AFTER_MS + 1
        const gone = lastBeat(status!, later)
        expect(gone.up).toBe(false)
        // Still carried: `stopping` is a daemon that was told to go and
        // `starting` one that died on the way up, and `doctor` says which.
        expect(gone.state).toBe('stopping')
      })
    })

    it('stops beating when the process holding it stops, and leaves its last word', async () => {
      // The beacon is the one timer in the system, and what a *killed* daemon
      // looks like is this: the row stops moving and goes stale, carrying the
      // word the process last said. Run here rather than only against Postgres
      // (`beacon.test.ts`) because it is the whole of how either store reports
      // a daemon that is gone.
      await withStore(async ({ store }) => {
        const beacon = startBeacon('up', { store, every: 50 })
        await beacon.stop('stopping')

        const stopped = await Effect.runPromise(store.status())
        expect(stopped!.state).toBe('stopping')

        // Two ticks' worth of the period it was started with. Nothing writes,
        // because the timer went with the process.
        await new Promise((resolve) => setTimeout(resolve, 200))
        const later = await Effect.runPromise(store.status())
        expect(later!.lastSeenAt.getTime()).toBe(stopped!.lastSeenAt.getTime())
        expect(later!.state).toBe('stopping')

        // And a reader past the threshold calls it down — which is the only
        // thing that can call it down, the word being what it *said*.
        expect(lastBeat(later!, later!.lastSeenAt.getTime() + STALE_AFTER_MS + 1).up).toBe(false)
      })
    })

    it("creates the row's table more than once without losing the row", async () => {
      // Called at every daemon start, so it has to be idempotent in the way
      // that matters: a start must not wipe what the last daemon said.
      await withStore(async ({ store }) => {
        await Effect.runPromise(store.beat(beating({ state: 'up' })))
        await Effect.runPromise(store.create())
        expect((await Effect.runPromise(store.status()))!.state).toBe('up')
      })
    })
  })

  // The setup's pause, appended the way `pauseConductorOnce` does: the only pause that stops the conductor.
  async function setupPause(events: EventStore, reason: string): Promise<void> {
    const head = await events.head(CONTROL_STREAM)
    await events.append(CONTROL_STREAM, head, [
      {
        type: 'ConductorPaused',
        actor: 'conductor',
        data: parsePayload('ConductorPaused', {
          by: 'lingtai',
          reason,
          until: null,
          cause: 'setup',
          holdsAcrossStarts: true,
        }),
      },
    ])
  }

  describe(`${name}: the log the control stream lives in`, () => {
    it('holds the setup pause until somebody lifts it', async () => {
      await withStore(async ({ store }) => {
        await setupPause(store.events, 'the recipe asks for a tier nobody provides')
        const paused = await readControl(store.events)
        expect(paused.paused).toBe(true)
        expect(paused.by).toBe('lingtai')
        expect(paused.reason).toBe('the recipe asks for a tier nobody provides')

        await resumeConductor('human:ada', store.events)
        expect((await readControl(store.events)).paused).toBe(false)
      })
    })

    it("reads a person's old pause as nothing", async () => {
      await withStore(async ({ store }) => {
        const head = await store.events.head(CONTROL_STREAM)
        await store.events.append(CONTROL_STREAM, head, [
          {
            type: 'ConductorPaused',
            actor: 'human:ada',
            data: parsePayload('ConductorPaused', { by: 'human:ada', reason: 'old', until: null, cause: 'person' }),
          },
        ])
        expect((await readControl(store.events)).paused).toBe(false)
        // Nothing stands, so there is nothing for the quiesce to lift either.
        await resumeConductor('human:ada', store.events)
      })
    })

    it('asks for one drain at a time, and a start ends it', async () => {
      await withStore(async ({ store }) => {
        const asked = await Effect.runPromise(
          requestShutdownUnlessStandingEffect('human:ada', 'restarting', null, store.events),
        )
        expect(asked.asked).toBe(true)

        // A second ask finds the first standing and appends nothing over it:
        // the reducer keeps the newest request, so hiding one would be a
        // request nobody decided to overrule.
        const again = await Effect.runPromise(
          requestShutdownUnlessStandingEffect('human:bob', 'me too', null, store.events),
        )
        expect(again.asked).toBe(false)

        const started = await recordStart(
          'human:ada',
          'it finished',
          { sha: null, dirty: false },
          Number.POSITIVE_INFINITY,
          store.events,
        )
        expect(started.recorded).toBe(true)
        expect((await readControl(store.events)).shutdown).toBeNull()
      })
    })

    it('lifts what a run that died half way through left standing', async () => {
      // The one above appends to `ctl-conductor`, which on Postgres is the real
      // stream, shared and without deletes. Interrupt it between the ask and
      // the start and a request stands for ever: every later run finds it,
      // `requestShutdownUnlessStanding` appends nothing, `asked` is false, and
      // no rerun and no teardown can repair a log that does not delete.
      //
      // So what is asserted here is the repair `withStore` runs before every
      // assertion — a start for the drain and a resume for the pause.
      await withStore(async ({ store }) => {
        await setupPause(store.events, 'and then the process was killed')
        await Effect.runPromise(requestShutdownUnlessStandingEffect('human:ada', 'restarting', null, store.events))

        await quiesceControl(store.events)

        const state = await readControl(store.events)
        expect(state.shutdown).toBeNull()
        expect(state.paused).toBe(false)
        // Which is the thing that matters: the next run gets to ask.
        const asked = await Effect.runPromise(
          requestShutdownUnlessStandingEffect('human:bob', 'mine', null, store.events),
        )
        expect(asked.asked).toBe(true)
      })
    })
  })

  describe(`${name}: the log, as the daemon asks it`, () => {
    it('reports a head that has moved past everything appended', async () => {
      await withStore(async (fixture) => {
        const { store } = fixture
        const before = await Effect.runPromise(store.head())

        const written = await store.events.append(fixture.stream(1), 0, [claimed('pass-a')])
        const seq = written.at(-1)!.seq

        const after = await Effect.runPromise(store.head())
        expect(after).toBeGreaterThan(before)
        // The log's end, which is where a starting daemon subscribes from: an
        // answer below this would replay, and one above it would skip.
        expect(after).toBeGreaterThanOrEqual(seq)
      })
    })

    it('finds the streams that hold a named type, and no others', async () => {
      await withStore(async (fixture) => {
        const { store } = fixture
        const claimedStream = fixture.stream(2)
        const landedStream = fixture.stream(3)
        await store.events.append(claimedStream, 0, [claimed('pass-b')])
        await store.events.append(landedStream, 0, [
          { type: 'TicketLanded', actor: 'conductor', data: { mergeCommit: 'abc1234', base: 'main' } },
        ])

        const found = await Effect.runPromise(
          store.streams({
            prefixes: [fixture.prefix],
            types: ['TicketClaimed'],
          }),
        )
        expect(found).toContain(claimedStream)
        expect(found).not.toContain(landedStream)

        // Ordered, because `reconcile` reports in this order and a report that
        // shuffles between passes is one nobody can diff.
        expect(found).toEqual([...found].sort())
      })
    })

    it('matches a prefix as SQL like does, case and all', async () => {
      // SQLite's `LIKE` reduces ASCII case and Postgres's does not. Left alone,
      // the two stores would disagree about which work items a reconcile even
      // looks at — so this is the assertion that keeps `sqlite.ts`'s pragma
      // honest.
      await withStore(async (fixture) => {
        const { store } = fixture
        const id = fixture.stream(4)
        await store.events.append(id, 0, [claimed('pass-c')])

        expect(
          await Effect.runPromise(store.streams({ prefixes: [fixture.prefix], types: ['TicketClaimed'] })),
        ).toContain(id)
        expect(
          await Effect.runPromise(
            store.streams({
              prefixes: [fixture.prefix.toUpperCase()],
              types: ['TicketClaimed'],
            }),
          ),
        ).toEqual([])
      })
    })

    it('asks nothing of the log when there is nothing to ask', async () => {
      // `reconcile` runs with no projects registered on a fresh machine, and
      // `type = any('{}')` matches nothing — so the empty answer is returned
      // rather than paid for.
      await withStore(async ({ store }) => {
        expect(await Effect.runPromise(store.streams({ prefixes: [], types: ['TicketClaimed'] }))).toEqual([])
        expect(await Effect.runPromise(store.streams({ prefixes: ['ticket-%'], types: [] }))).toEqual([])
      })
    })
  })
}
