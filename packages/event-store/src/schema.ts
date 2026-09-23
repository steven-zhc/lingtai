/**
 * The tables, created without the Prisma CLI (#186).
 *
 * `pnpm db:init` is Prisma's, and Prisma's CLI is a development dependency: an
 * installed binary does not carry it, and a person who has just installed has
 * no checkout to run it from. `lingtai init` still has to leave a Postgres URL
 * with tables behind it. So this applies **the migrations Prisma planned** —
 * each operation's own `precheck`, `execute` and `postcheck`, read from
 * `migrations/app/<name>/ops.json` — rather than a second description of the
 * schema that could drift from the contract.
 *
 * **All or nothing.** Postgres DDL is transactional, so a creation interrupted
 * half way — Ctrl+C, a dropped connection — leaves no tables rather than some,
 * and the next `lingtai init` begins again from a database it recognises as
 * empty.
 *
 * **A database that has `events` is left alone.** Its tables are somebody's log,
 * and re-running a finished init reports and changes nothing. The one repair
 * made there is the trigger, when it is missing — without it every append is
 * silent and the loop wakes only on the sweep.
 *
 * **But only once it is Lingtai's `events`.** A name is not a shape: an
 * application database — a Supabase project — can have an `events` table of
 * its own, and the repair's rules would make every UPDATE and DELETE the
 * application makes on it silently do nothing. So before anything is repaired,
 * and before a creation commits, `events` and `checkpoints` are compared with
 * the columns the migrations make, and a table that differs is refused by name
 * with nothing changed.
 */
import initial from "../migrations/app/20260831T1721_initial/ops.json" with { type: "json" };
import dropOutbox from "../migrations/app/20260904T2359_drop_outbox/ops.json" with { type: "json" };

interface Statement {
  description: string;
  sql: string;
  params?: unknown[];
}

interface Operation {
  id: string;
  label: string;
  precheck: Statement[];
  execute: Statement[];
  postcheck: Statement[];
}

/**
 * Every migration under `migrations/app`, oldest first. `unit/schema.test.ts`
 * lists the directory and fails on one missing from here — a migration planned
 * and not in this list would be a table nothing creates.
 */
export const MIGRATIONS: readonly { name: string; ops: readonly Operation[] }[] = [
  { name: "20260831T1721_initial", ops: initial as Operation[] },
  { name: "20260904T2359_drop_outbox", ops: dropOutbox as Operation[] },
];

/** What this needs of a connection — `pg.Client`'s shape, and a test's. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export type SchemaOutcome =
  /** The tables were made here, in one transaction. */
  | { created: true; applied: string[] }
  /** `events` was already there. `repaired` names the trigger when it was missing and was put back. */
  | { created: false; repaired: string[] };

/**
 * Applied after the tables exist — by `pnpm db:bootstrap` after Prisma's
 * migration, and by `createSchema` after its own. Prisma models tables, not
 * triggers or rules, so this is raw SQL by necessity. It was `sql/notify.sql`;
 * it is a string so that the bundle carries it, since a `.sql` file beside the
 * source is not in `dist/`.
 *
 * **The payload is the seq only.** NOTIFY caps at 8000 bytes and an event body
 * can exceed that, so a listener reads the row it is told about.
 *
 * **Append-only is enforced by the database** rather than by convention. A
 * correction is a new event; there is no legitimate UPDATE or DELETE.
 *
 * **The old names are dropped at the end.** The project was called Escapement
 * until 2026-09-02 (0017), and a database bootstrapped before that carries its
 * objects under those names. Dropped last, so the replacements already exist:
 * an events table briefly without its no-delete rule is not a window worth
 * opening. The old trigger is the one that matters — left in place it would
 * keep notifying a channel nothing listens on, and the loop would wake on
 * nothing.
 */
export const NOTIFY_SQL = `
CREATE OR REPLACE FUNCTION lingtai_notify_event() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('lingtai', NEW.seq::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lingtai_events_notify ON events;
CREATE TRIGGER lingtai_events_notify
  AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION lingtai_notify_event();

CREATE OR REPLACE RULE lingtai_events_no_update AS
  ON UPDATE TO events DO INSTEAD NOTHING;
CREATE OR REPLACE RULE lingtai_events_no_delete AS
  ON DELETE TO events DO INSTEAD NOTHING;

DROP TRIGGER IF EXISTS escapement_events_notify ON events;
DROP FUNCTION IF EXISTS escapement_notify_event();
DROP RULE IF EXISTS escapement_events_no_update ON events;
DROP RULE IF EXISTS escapement_events_no_delete ON events;
`;

/**
 * The columns the migrations make, as `information_schema.columns` names their
 * types. `unit/schema.test.ts` reads them back out of `ops.json`, so a
 * migration that changes a column and not this is a failing test.
 */
export const SHAPE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  checkpoints: { last_seq: "bigint", name: "text", updated_at: "timestamp with time zone" },
  events: {
    actor: "text",
    at: "timestamp with time zone",
    causation: "bigint",
    data: "jsonb",
    schema_ver: "integer",
    seq: "bigint",
    stream_id: "text",
    type: "text",
    version: "integer",
  },
};

/** What differs between the tables there and `SHAPE` — empty when they are Lingtai's. */
async function foreign(client: Queryable): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [Object.keys(SHAPE)],
  );
  const differs: string[] = [];
  for (const [table, columns] of Object.entries(SHAPE)) {
    const there = new Map(
      rows.filter((r) => r["table_name"] === table).map((r) => [String(r["column_name"]), String(r["data_type"])]),
    );
    if (there.size === 0) {
      differs.push(`no table "${table}"`);
      continue;
    }
    for (const [column, type] of Object.entries(columns)) {
      const found = there.get(column);
      if (found === undefined) differs.push(`"${table}" has no column ${column}`);
      else if (found !== type) differs.push(`"${table}".${column} is ${found}, not ${type}`);
    }
    for (const column of there.keys()) {
      if (!(column in columns)) differs.push(`"${table}" has a column ${column} Lingtai does not make`);
    }
  }
  return differs;
}

function notLingtais(differs: readonly string[]): Error {
  return new Error(
    `this database has tables that are not Lingtai's log — ${differs.join("; ")}. Nothing was changed: ` +
      "give Lingtai a database, or a schema, of its own",
  );
}

async function holds(client: Queryable, check: Statement): Promise<boolean> {
  const { rows } = await client.query(check.sql, check.params ?? []);
  return rows[0]?.["result"] === true;
}

export async function createSchema(client: Queryable): Promise<SchemaOutcome> {
  const { rows } = await client.query(`SELECT to_regclass('"public"."events"') IS NOT NULL AS "result"`);
  if (rows[0]?.["result"] === true) {
    const differs = await foreign(client);
    if (differs.length > 0) throw notLingtais(differs);
    const trigger = await client.query(
      `SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'lingtai_events_notify' AND NOT tgisinternal) AS "result"`,
    );
    if (trigger.rows[0]?.["result"] === true) return { created: false, repaired: [] };
    await client.query(NOTIFY_SQL);
    return { created: false, repaired: ["the NOTIFY trigger and the append-only rules"] };
  }

  const applied: string[] = [];
  await client.query("BEGIN");
  try {
    for (const migration of MIGRATIONS) {
      for (const op of migration.ops) {
        let due = true;
        for (const check of op.precheck) due = due && (await holds(client, check));
        if (!due) continue;
        for (const step of op.execute) await client.query(step.sql, step.params ?? []);
        for (const check of op.postcheck) {
          if (!(await holds(client, check))) {
            throw new Error(`${migration.name}: ${op.label} did not hold afterwards — ${check.description}`);
          }
        }
        applied.push(op.label);
      }
    }
    // A precheck passes over a table that is already there, so a `checkpoints` of somebody else's is caught here.
    const differs = await foreign(client);
    if (differs.length > 0) throw notLingtais(differs);
    await client.query(NOTIFY_SQL);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
  return { created: true, applied };
}
