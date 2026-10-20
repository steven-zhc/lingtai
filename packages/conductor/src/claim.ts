import { parsePayload, reduceTicket, type ReleaseCause } from '@lingtai/domain'
/**
 * Claiming a work item.
 *
 * This replaces `.runtime/loop.lock.d`, a directory the old loop created to hold
 * a lock and which leaked after every `kill -9` — recovering meant noticing and
 * running `rm -rf` by hand. There is nothing to unwind here, and that is not a
 * tidier implementation of the same idea but a different one:
 *
 *   - **The claim is an append at an expected version.** `UNIQUE (stream_id,
 *     version)` decides the race. The loser gets a `ConcurrencyError`, re-reads,
 *     and finds the item already held. No lock table, no lock file.
 *   - **Nothing here expires.** A claim carried a `leaseUntilMs` for a while and
 *     [0027](../../../doc/decisions-archive/0027-the-lease-is-deleted.md) deleted it: a
 *     fixed thirty minutes, never renewed, on runs the recipe lets live for one
 *     to two hours. It excluded nobody — two conductors pass a timestamp check
 *     together — and past the half hour it did the opposite of its job, handing
 *     a live run's ticket to the next caller. Held is held.
 *
 * A crash therefore costs a `TicketReleased`, not an intervention: the next
 * conductor to take `lingtai:daemon` knows it is the only one, so every claim
 * naming another worker is dead and it appends the release
 * (`daemon/reconcile.ts`). Liveness is the lock, which the kernel maintains;
 * exclusion is the constraint. Neither is a number.
 */
import { ConcurrencyError, type EventStore, eventStore } from '@lingtai/event-store'

export interface ClaimOptions {
  runId: string
  /**
   * Who holds it — host and pid.
   *
   * Not decoration. It is what recovery is decided on (0027): a conductor
   * holding the lock releases every claim recorded by a *different* worker,
   * because it has proof there is no such conductor left alive.
   */
  worker?: string
  /**
   * What the task is, if the caller knows.
   *
   * Recorded on the claim because the queue left the log (0012): this is now
   * the only place a title enters it, and without one a rebuilt projection has
   * nothing to show for work that has already merged — GitHub only lists what
   * is still open. Null is honest when the caller genuinely does not know.
   */
  title?: string | null
  kind?: string | null
  store?: EventStore
}

export interface Claim {
  ticketId: string
  runId: string
  worker: string
  /** The stream version the claim landed at; the next append expects this. */
  version: number
}

export type ClaimRefusal =
  /**
   * Someone else holds it. No countdown: there is nothing to count down to,
   * and a caller that waited for one would wait for ever.
   */
  | { reason: 'held'; by: string; runId: string }
  /** Another claimant won the append. Re-read and look again. */
  | { reason: 'lost-race' }
  /** Not in a state that can be claimed — landed, or blocked on a person. */
  | { reason: 'not-claimable'; status: string }

export type ClaimResult = { ok: true; claim: Claim } | { ok: false; refusal: ClaimRefusal }

/**
 * What this process calls itself in a claim.
 *
 * Exported because recovery compares against it (0027). A restarted conductor
 * has a new pid, so it does not recognise its predecessor's claims as its own —
 * which is the point: those are exactly the claims nobody is coming back for.
 */
export function conductorWorker(): string {
  return `${process.env['HOSTNAME'] ?? 'local'}:${process.pid}`
}

/**
 * Takes the work item, or says why not.
 *
 * Never throws on a lost race: losing is an ordinary outcome of two schedulers
 * looking at the same queue, and a caller that has to catch an exception to
 * discover it will eventually forget to.
 */
export async function claimTicket(ticketId: string, options: ClaimOptions): Promise<ClaimResult> {
  const store = options.store ?? eventStore
  const worker = options.worker ?? conductorWorker()

  const events = await store.read(ticketId)
  const state = reduceTicket(events)

  if (state.lifecycle.status === 'claimed') {
    // Held is held. There is no expiry to fall through to, so the only way past
    // this is an appended release — which is what a conductor that has just
    // proved itself alone does at startup.
    const held = state.lifecycle
    return { ok: false, refusal: { reason: 'held', by: held.worker, runId: held.runId } }
  }
  if (state.lifecycle.status !== 'backlog') {
    return { ok: false, refusal: { reason: 'not-claimable', status: state.lifecycle.status } }
  }

  try {
    const [written] = await store.append(ticketId, state.version, [
      {
        type: 'TicketClaimed',
        actor: 'conductor',
        data: parsePayload('TicketClaimed', {
          runId: options.runId,
          worker,
          title: options.title ?? null,
          kind: options.kind ?? null,
        }),
      },
    ])
    return {
      ok: true,
      claim: { ticketId, runId: options.runId, worker, version: written!.version },
    }
  } catch (err) {
    // The other claimant appended first. The constraint is the whole of the
    // mutual exclusion; this is what losing it looks like.
    if (err instanceof ConcurrencyError) return { ok: false, refusal: { reason: 'lost-race' } }
    throw err
  }
}

export type ContinueRefusal =
  /** Not `approved` — a requeue, a second approval, a close, all land between the approval and this claim. */
  | { reason: 'not-approved'; status: string }
  /** Approved onto a different run than the one this call means to continue. */
  | { reason: 'wrong-run'; runId: string }
  /** Another claimant won the append — the daemon and a CLI/board call raced for the same continuation. */
  | { reason: 'lost-race' }

export type ContinueResult = { ok: true; claim: Claim } | { ok: false; refusal: ContinueRefusal }

/**
 * Takes a run back up for its continuation (#465, 0118 §11) — `claimTicket`'s
 * sibling, for the one state `claimTicket` itself refuses: `approved`,
 * never `backlog`.
 *
 * **The same `TicketClaimed`, naming the same `runId` the approval was
 * about.** The fold already de-duplicates a run already in `runs`
 * (`ticket.ts`'s own `TicketClaimed` case), so this is not a second kind
 * of claim on the log — it is the ordinary one, appended again, onto a run
 * that has already spent its first claim. A close or a second decision
 * landing between the approval and this call is a `ConcurrencyError` the
 * version check catches on its own; `wrong-run` and `not-approved` are read
 * off the state this call itself fetched, for a caller that wants to say
 * *why* before it ever reaches the store.
 */
export async function continueTicket(
  ticketId: string,
  runId: string,
  options: { worker?: string; store?: EventStore } = {},
): Promise<ContinueResult> {
  const store = options.store ?? eventStore
  const worker = options.worker ?? conductorWorker()

  const events = await store.read(ticketId)
  const state = reduceTicket(events)

  if (state.lifecycle.status !== 'approved') {
    return { ok: false, refusal: { reason: 'not-approved', status: state.lifecycle.status } }
  }
  if (state.lifecycle.runId !== runId) {
    return { ok: false, refusal: { reason: 'wrong-run', runId: state.lifecycle.runId } }
  }

  try {
    const [written] = await store.append(ticketId, state.version, [
      {
        type: 'TicketClaimed',
        actor: 'conductor',
        data: parsePayload('TicketClaimed', { runId, worker, title: null, kind: null }),
      },
    ])
    return { ok: true, claim: { ticketId, runId, worker, version: written!.version } }
  } catch (err) {
    if (err instanceof ConcurrencyError) return { ok: false, refusal: { reason: 'lost-race' } }
    throw err
  }
}

/**
 * Hands the item back. The only way back: there is no expiry (0027).
 *
 * `cause` is `null` for every caller here and the reconciler's own release of
 * a dead worker — neither has one of 0120's causes to name (#502, 464.md
 * choice 4) — and `{_tag: 'Restart', restart}` for `conduct.ts`'s own restart,
 * which calls this directly rather than through a second function.
 */
export async function releaseTicket(
  ticketId: string,
  runId: string,
  reason: string,
  store: EventStore = eventStore,
  cause: ReleaseCause | null = null,
): Promise<void> {
  const events = await store.read(ticketId)
  const state = reduceTicket(events)
  await store.append(ticketId, state.version, [
    {
      type: 'TicketReleased',
      actor: 'conductor',
      data: parsePayload('TicketReleased', { runId, reason, cause }),
    },
  ])
}
