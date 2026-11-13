/**
 * `lingtai upgrade`'s drain, once a log is configured — the doctor gate, the
 * request and the wait — separate from `entry.ts` so a test can run it against
 * a memory store.
 *
 * **A drain this person left standing is theirs to finish** (0042 §7, as
 * `lingtai restart` adopts one), and nothing here withdraws it (0126): the next
 * start ends it. A request still standing has not been ended by a start, so
 * whatever holds the lock started before it, or has not yet recorded its start —
 * and either obeys it. Waiting on it is therefore right, and asking again is not
 * needed.
 *
 * **A refusal says what it leaves standing.** Doctor is gated before anything
 * is asked, and where this person's earlier drain is still standing the
 * refusal names it rather than saying nothing was asked to stop.
 */
import type { Asking, ControlState } from '@lingtai/daemon'
import { paint } from '@lingtai/env/colour'
import { Cause, Effect, type Scope } from 'effect'

import type { Drained } from './install.ts'

export interface UpgradeDrain {
  by: string
  reason: string
  /** Waive a red doctor, and nothing else. */
  despiteDoctor: boolean
  /** Run `lingtai doctor`, print it, and say how many failures gate. */
  doctor: Effect.Effect<number, unknown>
  holder: Effect.Effect<string | null, unknown>
  control: Effect.Effect<Pick<ControlState, 'shutdown'>, unknown>
  request: (by: string, reason: string) => Effect.Effect<Asking, unknown>
  inFlight: Effect.Effect<string, unknown>
  wait: Effect.Effect<'free' | 'interrupted' | 'gave-up', unknown>
  log: (line: string) => void
  /** How often the wait checks that the drain still stands. */
  watchMs?: number
}

/**
 * The loop that asks again whenever no request stands, every `everyMs`: one
 * Effect, so its IO is Effect's (0101 §6). Each round's read and append are
 * uninterruptible, so interrupting the loop waits for the round in flight and
 * nothing starts after it. A round that fails — or dies, as a store's failure
 * does — is dropped and the next one asks again; only interruption passes.
 */
export const keepAskedLoop = (
  standing: Effect.Effect<unknown, unknown>,
  ask: Effect.Effect<unknown, unknown>,
  everyMs: number,
): Effect.Effect<never> =>
  Effect.forever(
    Effect.sleep(everyMs).pipe(
      Effect.andThen(
        Effect.uninterruptible(
          standing.pipe(
            Effect.flatMap((s) => (s === null ? ask : Effect.void)),
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause as Cause.Cause<never>) : Effect.void,
            ),
          ),
        ),
      ),
    ),
  )

const NOTHING_AFTER: Drained = { ok: true, after: Effect.void }

export const drainForUpgrade = (how: UpgradeDrain): Effect.Effect<Drained, unknown> => Effect.scoped(drainScoped(how))

const drainScoped = (how: UpgradeDrain): Effect.Effect<Drained, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const { by, reason, log } = how
    const theirs = (standing: { by: string; reason: string }): Drained => {
      log(
        paint.fail(
          `not upgrading: a shutdown asked by ${standing.by} — ${standing.reason} — is standing, ` +
            'and starting a conductor (lingtai daemon) ends it. Nothing was asked to stop by this command',
        ),
      )
      return { ok: false, code: 1 }
    }

    const earlier = (yield* how.control).shutdown
    const own = earlier !== null && earlier.by === by ? earlier : null

    if ((yield* how.doctor) > 0 && !how.despiteDoctor) {
      log(
        paint.fail(
          own === null
            ? 'not upgrading: lingtai doctor failed, and nothing was asked to stop. --despite-doctor upgrades anyway, once read'
            : `not upgrading: lingtai doctor failed, and nothing more was asked to stop — but the drain you asked for earlier ` +
                `(${own.reason}) is still standing, and the next start ends it. ` +
                '--despite-doctor upgrades anyway, once read',
        ),
      )
      return { ok: false, code: 1 }
    }

    const holder = yield* how.holder
    if (holder === null) {
      if (own !== null) {
        log(`nothing is conducting — the drain you asked for (${own.reason}) is done; the next lingtai start ends it`)
      } else log('nothing is conducting — nothing to drain')
      return NOTHING_AFTER
    }

    // Asked even when this person's own request stood a moment ago: `own` was read
    // before the doctor, and a daemon that recorded its start since has ended it.
    // `request` finds a request still standing and appends nothing over it, and
    // appends a new one, above that daemon's watermark, when none does.
    const asked = yield* how.request(by, reason)
    if (!asked.asked && asked.standing.by !== by) return theirs(asked.standing)
    if (!asked.asked)
      log(
        paint.held(
          `a drain you asked for is already standing (${asked.standing.reason}) — waiting on it; ${holder} reads it.`,
        ),
      )
    log(paint.held(`draining ${holder} — ${yield* how.inFlight}.`))

    // A start that lands during the wait ends the request too, and a drain nobody
    // is obeying is waited on for ever: so it is asked again whenever none stands.
    yield* Effect.forkScoped(
      keepAskedLoop(how.control.pipe(Effect.map((c) => c.shutdown)), how.request(by, reason), how.watchMs ?? 2000),
    )
    const waited = yield* how.wait
    if (waited !== 'free') return { ok: false, code: waited === 'interrupted' ? 130 : 1 }
    // Joined, not abandoned: the scope closing waits for a round in flight, so
    // nothing is appended once this has returned.
    return NOTHING_AFTER
  })
