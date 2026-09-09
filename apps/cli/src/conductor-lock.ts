/**
 * The lock a command holds while it conducts.
 *
 * **One rule, both hosts: a process that claims holds the conductor lock for as
 * long as it runs** (#93). The daemon always did — `packages/daemon/src/lock.ts`
 * exists for exactly this — and `lingtai run` never did, because the lock's
 * reasoning was written about a second *daemon* and `lingtai run` was never
 * counted as a conductor. It conducts the same work through the same
 * `conductorPass`, and `CLAUDE.md` teaches people to run it by hand.
 *
 * The claim mechanism hid the consequence: while a claim carried a thirty-minute
 * lease, a live lease turned the second claimant away, so the gap only opened on
 * runs longer than half an hour. [0027](../../../doc/decisions/0027-the-lease-is-deleted.md)
 * deletes the lease and replaces it with a proof — *a process holding this lock
 * knows no other conductor exists, therefore every foreign claim is dead* — and
 * that proof is false for as long as anything can conduct without the lock.
 *
 * **Losing is not an error.** It exits 0 saying who holds it, the way
 * `lingtai daemon` already does. A person who types `lingtai run` while the
 * daemon is up has done a reasonable thing and needs an answer, not a stack
 * trace.
 *
 * A scope, not a pair of statements, for the reason `projector.ts` gives: `run`
 * returns on several paths, and an advisory lock held by a connection nobody
 * closes keeps the next conductor out until the process dies.
 */
import { DAEMON_LOCK_KEY, acquireDaemonLock } from "@lingtai/daemon";
import { Context, Data, Effect, Layer } from "effect";

/**
 * Somebody else is conducting. `holder` is their `application_name` and pid,
 * when Postgres could say — `lingtai daemon pid 5123`.
 */
export class ConductorBusy extends Data.TaggedError("ConductorBusy")<{
  readonly holder: string | null;
}> {}

/**
 * The lock could not be asked about at all — no database, wrong URL, a pooler
 * where a session-mode connection was wanted.
 *
 * Distinct from `ConductorBusy` because the two are opposite answers, and
 * reporting an unreachable log as "another conductor holds it" would send
 * somebody hunting for a process that does not exist.
 */
export class LockUnreadable extends Data.TaggedError("LockUnreadable")<{
  readonly detail: string;
}> {}

export class ConductorLock extends Context.Tag("lingtai/cli/ConductorLock")<
  ConductorLock,
  { readonly key: string }
>() {}

export interface ConductorLockOptions {
  /** The suite's own key, so a test does not fight the operator's daemon. */
  key?: string;
  /** Recorded as `application_name`, so the next caller is told what has it. */
  name?: string;
}

export const ConductorLockLive = (
  options: ConductorLockOptions = {},
): Layer.Layer<ConductorLock, ConductorBusy | LockUnreadable> =>
  Layer.scoped(
    ConductorLock,
    Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          acquireDaemonLock({
            name: options.name ?? "lingtai run",
            ...(options.key === undefined ? {} : { key: options.key }),
          }),
        catch: (err) => new LockUnreadable({ detail: (err as Error).message }),
      }).pipe(
        Effect.flatMap((held) =>
          held.ok ? Effect.succeed(held.lock) : Effect.fail(new ConductorBusy({ holder: held.holder })),
        ),
      ),
      // Released whichever way control left the scope, including the typed
      // refusals raised after it was taken.
      (lock) => Effect.promise(() => lock.release()),
    ).pipe(Effect.as({ key: options.key ?? DAEMON_LOCK_KEY })),
  );
