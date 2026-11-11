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

import type { Drained } from './install.ts'

export interface UpgradeDrain {
  by: string
  reason: string
  /** Waive a red doctor, and nothing else. */
  despiteDoctor: boolean
  /** Run `lingtai doctor`, print it, and say how many failures gate. */
  doctor: () => Promise<number>
  holder: () => Promise<string | null>
  control: () => Promise<Pick<ControlState, 'shutdown'>>
  request: (by: string, reason: string) => Promise<Asking>
  inFlight: () => Promise<string>
  wait: () => Promise<'free' | 'interrupted' | 'gave-up'>
  log: (line: string) => void
  /** How often the wait checks that the drain still stands. */
  watchMs?: number
}

const NOTHING_AFTER: Drained = { ok: true, after: async () => {} }

export async function drainForUpgrade(how: UpgradeDrain): Promise<Drained> {
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

  const earlier = (await how.control()).shutdown
  const own = earlier !== null && earlier.by === by ? earlier : null

  if ((await how.doctor()) > 0 && !how.despiteDoctor) {
    log(
      paint.fail(
        own === null
          ? 'not upgrading: lingtai doctor failed, and nothing was asked to stop. --despite-doctor upgrades anyway, once read'
          : `not upgrading: lingtai doctor failed, and nothing more was asked to stop — but the drain you asked for earlier ` +
              `(${own.reason}) is still standing. ` +
              '--despite-doctor upgrades anyway, once read',
      ),
    )
    return { ok: false, code: 1 }
  }

  const holder = await how.holder()
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
  const asked = await how.request(by, reason)
  if (!asked.asked && asked.standing.by !== by) return theirs(asked.standing)
  if (!asked.asked)
    log(
      paint.held(
        `a drain you asked for is already standing (${asked.standing.reason}) — waiting on it; ${holder} reads it.`,
      ),
    )
  log(paint.held(`draining ${holder} — ${await how.inFlight()}.`))

  // A start that lands during the wait ends the request too, and a drain nobody
  // is obeying is waited on for ever: so it is asked again whenever none stands.
  let waiting = true
  const watch = (async () => {
    while (waiting) {
      await new Promise<void>((resolve) => setTimeout(resolve, how.watchMs ?? 2000).unref())
      if (!waiting) break
      const now = await how.control().then(
        (c) => c.shutdown,
        () => undefined,
      )
      if (now === null) await how.request(by, reason).catch(() => undefined)
    }
  })()
  void watch
  try {
    const waited = await how.wait()
    if (waited !== 'free') return { ok: false, code: waited === 'interrupted' ? 130 : 1 }
  } finally {
    waiting = false
  }
  return NOTHING_AFTER
}
