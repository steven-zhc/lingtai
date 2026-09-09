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
  const who = await client
    .query<{ holder: string }>(
      `select coalesce(a.application_name, '') || ' pid ' || a.pid::text as holder
       from pg_locks l
       join pg_stat_activity a on a.pid = l.pid
       where l.locktype = 'advisory' and l.granted and l.objid = (hashtext($1)::bigint & 4294967295)
       limit 1`,
      [key],
    )
    .catch(() => null);
  return who?.rows[0]?.holder?.trim() ?? null;
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
      const holder = await holderOf(client, key);
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
