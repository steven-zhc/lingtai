/**
 * Exactly one conductor, decided by Postgres rather than by a pid file.
 *
 * A second conductor is not a hypothetical, and it does not have to be a second
 * daemon. launchd keeps one daemon alive, the obvious way to debug it is to run
 * `lingtai daemon` in a terminal while that one is still up — and `CLAUDE.md`
 * teaches people to run `lingtai run` by hand, which conducts exactly the same
 * work through the same `conductorPass`. **A conductor is anything that claims,
 * not a process with a particular name** (#93). Two of them racing for the same
 * ticket is the failure that makes the whole claim mechanism pointless — and it
 * would present as an expensive mystery rather than an error.
 *
 * That is also why the lock is the liveness proof
 * [0027](../../../doc/decisions/0027-the-lease-is-deleted.md) rests on: a
 * process holding this lock knows no other conductor exists, so every foreign
 * claim it finds is dead. The proof is only as true as the set of processes
 * that take it, which is why `lingtai run` takes it too.
 *
 * A session-level advisory lock is the right shape because it is held by the
 * *connection*: a killed conductor releases it when its socket closes, with
 * nothing to clean up and no stale file to explain. Same mechanism the merge
 * lane already uses, for the same reason.
 *
 * Losing is not an error. The second process exits 0 saying who holds it —
 * `lingtai daemon` while launchd's copy is running is a reasonable thing to do,
 * and greeting it with a stack trace would teach people to ignore stack traces.
 */
import { directDatabaseUrl } from "@lingtai/env";
import pg from "pg";

/** One lock for the whole conductor, per database. Hashed to the bigint the API takes. */
export const DAEMON_LOCK_KEY = "lingtai:daemon";

export interface DaemonLock {
  /** Releases the lock and closes the connection that held it. */
  release(): Promise<void>;
}

export type LockResult =
  | { ok: true; lock: DaemonLock }
  /** Somebody else holds it. `holder` is their pid and host, when they recorded one. */
  | { ok: false; holder: string | null };

export interface AcquireOptions {
  /**
   * Session mode, not the pooler. A transaction-mode connection can hand the
   * next statement a different backend, and a session lock held by a backend
   * you no longer have is a lock you cannot release — see ADR 0009.
   */
  url?: string;
  key?: string;
  /**
   * What the holder calls itself, recorded as `application_name` so the next
   * caller — and `lingtai doctor` — gets a name rather than a bare pid. There
   * are two kinds of conductor now, and "who has it" is the whole question.
   *
   * Best effort, like everything about the holder: a pooler in front of
   * Postgres owns the backend and reports *its* name, so what comes back may be
   * `Supavisor pid 887352`. That still says the lock is held and by which
   * backend, which is what the answer has to carry.
   */
  name?: string;
}

/**
 * Who holds `key`, or null if nobody does.
 *
 * Best effort. `pg_locks` says a lock is held but not by whom in any useful
 * sense, so this reports the backend's own description rather than inventing a
 * name.
 */
async function holderOf(client: pg.Client, key: string): Promise<string | null> {
  const who = await client.query<{ holder: string }>(
    `select coalesce(a.application_name, '') || ' pid ' || a.pid::text as holder
     from pg_locks l
     join pg_stat_activity a on a.pid = l.pid
     where l.locktype = 'advisory' and l.granted and l.objid = (hashtext($1)::bigint & 4294967295)
     limit 1`,
    [key],
  );
  return who.rows[0]?.holder?.trim() ?? null;
}

export async function acquireDaemonLock(options: AcquireOptions = {}): Promise<LockResult> {
  const client = new pg.Client({
    connectionString: options.url ?? directDatabaseUrl(),
    application_name: options.name ?? "lingtai",
  });
  await client.connect();

  try {
    const key = options.key ?? DAEMON_LOCK_KEY;
    const got = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)::bigint) as locked",
      [key],
    );

    if (!got.rows[0]?.locked) {
      // Best effort here, and only here: the lock was already refused, so a
      // failed query costs the holder's name and not the answer.
      const holder = await holderOf(client, key).catch(() => null);
      await client.end();
      return { ok: false, holder };
    }

    return {
      ok: true,
      lock: {
        async release() {
          // Ending the connection would release it anyway. Unlocking first
          // means a conductor that is shutting down cleanly does not depend on
          // socket teardown timing to let the next one start.
          await client.query("select pg_advisory_unlock(hashtext($1)::bigint)", [key]).catch(() => {});
          await client.end().catch(() => {});
        },
      },
    };
  } catch (err) {
    await client.end().catch(() => {});
    throw err;
  }
}

/**
 * Who is conducting, without becoming a conductor to find out.
 *
 * `acquireDaemonLock` answers the same question, but only by trying to take the
 * lock — which is exactly what a diagnostic must not do. `lingtai doctor` never
 * writes and must never take a lock the thing it is diagnosing needs, so this
 * reads `pg_locks` and nothing else.
 *
 * **A query that fails throws**, as a connection that fails does. Null means
 * `pg_locks` was read and nobody holds the lock; a statement timeout or a reset
 * backend read as that would tell `lingtai restart` the drain was over while the
 * old daemon was still in its pass (0042 §6).
 */
export async function conductorLockHolder(options: AcquireOptions = {}): Promise<string | null> {
  const client = new pg.Client({
    connectionString: options.url ?? directDatabaseUrl(),
    application_name: options.name ?? "lingtai-doctor",
  });
  await client.connect();
  try {
    return await holderOf(client, options.key ?? DAEMON_LOCK_KEY);
  } finally {
    await client.end().catch(() => {});
  }
}

/** A place in the queue for the conductor lock. See `queueForDaemonLock`. */
export interface LockPlace {
  /** Whether the place has become the lock. */
  held(): boolean;
  /** Why the place was lost, when the connection holding it failed; null while it stands. */
  lost(): Error | null;
  /**
   * Whether the lock is still held, asked on the connection that holds it. A
   * dropped connection is not always reported until it is written to, and
   * Postgres has released the lock with the session by then.
   */
  confirm(): Promise<boolean>;
  /** Releases the lock when held and leaves the queue when not. Safe to call twice. */
  leave(): Promise<void>;
}

/**
 * Wait in line for the lock rather than race for it (#174).
 *
 * `acquireDaemonLock` tries once, and that is right for a conductor. It is
 * wrong for `lingtai service shutdown`, which has to be the *next* holder: under
 * launchd's KeepAlive a daemon that drains and exits is started again at once,
 * and since #159 the copy reads only what is appended after it starts — so it
 * does not see the drain, and if it wins the lock it takes work that the unload
 * then kills. A blocking `pg_advisory_lock` is queued inside Postgres, and a
 * released lock is granted to the waiter before any `pg_try_advisory_lock` can
 * see it free. Queued before the drain is asked for, the place is ahead of
 * every copy the supervisor can start.
 */
export async function queueForDaemonLock(options: AcquireOptions = {}): Promise<LockPlace> {
  const url = options.url ?? directDatabaseUrl();
  const key = options.key ?? DAEMON_LOCK_KEY;
  const client = new pg.Client({ connectionString: url, application_name: options.name ?? "lingtai" });
  await client.connect();
  let pid: number;
  try {
    pid = (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  } catch (err) {
    await client.end().catch(() => {});
    throw err;
  }

  let held = false;
  let lost: Error | null = null;
  let leaving: Promise<void> | null = null;
  client.on("error", (err) => {
    lost ??= err;
  });
  const waiting = client.query("select pg_advisory_lock(hashtext($1)::bigint)", [key]).then(
    () => {
      held = true;
    },
    (err: Error) => {
      if (leaving === null) lost ??= err;
    },
  );

  return {
    held: () => held,
    lost: () => lost,
    async confirm() {
      if (!held || lost !== null || leaving !== null) return false;
      let timer: NodeJS.Timeout | undefined;
      try {
        const asked = client.query<{ held: boolean }>(
          "select exists(select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted) as held",
        );
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("the connection holding the lock did not answer in 10s")), 10_000);
        });
        const still = (await Promise.race([asked, timeout])).rows[0]?.held === true;
        if (!still) lost ??= new Error("the lock is no longer held on its connection");
        return still;
      } catch (err) {
        lost ??= err as Error;
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
    leave() {
      leaving ??= (async () => {
        if (!held && lost === null) {
          // Closing the socket does not take a backend out of a lock queue: it
          // would be granted the lock and hold it until it next wrote to a
          // client that is gone. So the wait is cancelled from another session.
          const cancel = new pg.Client({ connectionString: url, application_name: options.name ?? "lingtai" });
          const cancelled = await cancel
            .connect()
            .then(() => cancel.query<{ ok: boolean }>("select pg_cancel_backend($1) as ok", [pid]))
            .then((r) => r.rows[0]?.ok === true)
            .catch(() => false)
            .finally(() => cancel.end().catch(() => {}));
          // Not cancelled — no second connection to be had — and `waiting`
          // settles only on a grant, which may be a whole pass away. So the
          // socket is closed instead: the query fails here at once, and a
          // backend still queued lets the lock go when it writes the grant to a
          // client that is gone — a moment, not a pass.
          if (!cancelled) await client.end().catch(() => {});
        }
        await waiting;
        if (held) await client.query("select pg_advisory_unlock(hashtext($1)::bigint)", [key]).catch(() => {});
        await client.end().catch(() => {});
      })();
      return leaving;
    },
  };
}
