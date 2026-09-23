import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, NOTIFY_SQL, type Queryable, SHAPE, createSchema } from "../src/schema.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A connection that answers the catalogue questions from a set of names, and
 * records what it was asked to run. Enough to check the order and the
 * all-or-nothing shape; that the SQL itself is right is Prisma's plan, and
 * `pnpm db:bootstrap` proves it against a database.
 */
/** `information_schema.columns`'s rows for tables of these shapes. */
function columns(shape: Record<string, Record<string, string>>) {
  return Object.entries(shape).flatMap(([table_name, cols]) =>
    Object.entries(cols).map(([column_name, data_type]) => ({ table_name, column_name, data_type })),
  );
}

function fake(present: { events: boolean; trigger: boolean; shape?: Record<string, Record<string, string>> }) {
  const ran: string[] = [];
  const client: Queryable = {
    async query(sql) {
      if (sql.includes("information_schema.columns")) return { rows: columns(present.shape ?? SHAPE) };
      if (sql.includes(`to_regclass('"public"."events"')`)) return { rows: [{ result: present.events }] };
      if (sql.includes("pg_trigger")) return { rows: [{ result: present.trigger }] };
      // Every precheck says *not there yet*, every postcheck *there now*.
      if (/IS NULL AS "result"|SELECT NOT EXISTS/.test(sql)) return { rows: [{ result: true }] };
      if (/IS NOT NULL AS "result"|SELECT EXISTS/.test(sql)) return { rows: [{ result: true }] };
      ran.push(sql);
      return { rows: [] };
    },
  };
  return { client, ran };
}

describe("createSchema (#186)", () => {
  it("names every migration Prisma planned — one added to migrations/app and not here is refused", () => {
    const planned = readdirSync(join(here, "../migrations/app"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "refs")
      .map((entry) => entry.name)
      .sort();
    expect(MIGRATIONS.map((m) => m.name)).toEqual(planned);
  });

  it("knows the columns the migrations make — a column changed in ops.json and not in SHAPE is refused", () => {
    const TYPES: Record<string, string> = {
      text: "text",
      jsonb: "jsonb",
      int8: "bigint",
      BIGSERIAL: "bigint",
      int4: "integer",
      timestamptz: "timestamp with time zone",
    };
    const made: Record<string, Record<string, string>> = {};
    for (const { ops } of MIGRATIONS) {
      for (const op of ops) {
        for (const step of op.execute) {
          const create = /^CREATE TABLE "public"\."(\w+)" \(([\s\S]*)\)$/.exec(step.sql);
          if (create) {
            made[create[1]!] = Object.fromEntries(
              [...create[2]!.matchAll(/^\s*"(\w+)" (\w+)/gm)].map((m) => [m[1]!, TYPES[m[2]!] ?? m[2]!]),
            );
          }
          const drop = /^DROP TABLE "public"\."(\w+)"/.exec(step.sql);
          if (drop) delete made[drop[1]!];
        }
      }
    }
    expect(made).toEqual(SHAPE);
  });

  it("refuses an events table that is not Lingtai's, and applies nothing to it", async () => {
    // An application's own `events`, and no `checkpoints`: the repair's rules would silence its UPDATEs and DELETEs.
    const { client, ran } = fake({
      events: true,
      trigger: false,
      shape: { events: { id: "uuid", name: "text", payload: "jsonb", created_at: "timestamp with time zone" } },
    });
    await expect(createSchema(client)).rejects.toThrow(/not Lingtai's log.*no table "checkpoints".*Nothing was changed/);
    expect(ran).toEqual([]);
  });

  it("refuses a Lingtai events table beside no checkpoints, rather than calling it present", async () => {
    const { client, ran } = fake({ events: true, trigger: true, shape: { events: SHAPE["events"]! } });
    await expect(createSchema(client)).rejects.toThrow(`no table "checkpoints"`);
    expect(ran).toEqual([]);
  });

  it("rolls back a creation that met somebody else's checkpoints table", async () => {
    const { client, ran } = fake({
      events: false,
      trigger: false,
      shape: { ...SHAPE, checkpoints: { id: "integer", note: "text" } },
    });
    await expect(createSchema(client)).rejects.toThrow("not Lingtai's log");
    expect(ran.at(-1)).toBe("ROLLBACK");
    expect(ran).not.toContain(NOTIFY_SQL);
    expect(ran).not.toContain("COMMIT");
  });

  it("creates the tables in one transaction, then the trigger, on an empty database", async () => {
    const { client, ran } = fake({ events: false, trigger: false });
    const outcome = await createSchema(client);
    expect(outcome.created).toBe(true);
    expect(ran[0]).toBe("BEGIN");
    expect(ran.at(-2)).toBe(NOTIFY_SQL);
    expect(ran.at(-1)).toBe("COMMIT");
    expect(ran.some((sql) => sql.startsWith(`CREATE TABLE "public"."events"`))).toBe(true);
  });

  it("rolls back when a step fails, so an interrupted creation leaves nothing behind", async () => {
    const ran: string[] = [];
    const client: Queryable = {
      async query(sql) {
        if (sql.includes(`to_regclass('"public"."events"')`)) return { rows: [{ result: false }] };
        if (sql.includes('"result"')) return { rows: [{ result: true }] };
        ran.push(sql);
        if (sql.startsWith(`CREATE TABLE "public"."events"`)) throw new Error("connection dropped");
        return { rows: [] };
      },
    };
    await expect(createSchema(client)).rejects.toThrow("connection dropped");
    expect(ran.at(-1)).toBe("ROLLBACK");
    expect(ran).not.toContain("COMMIT");
  });

  it("leaves a database with a log in it alone", async () => {
    const { client, ran } = fake({ events: true, trigger: true });
    expect(await createSchema(client)).toEqual({ created: false, repaired: [] });
    expect(ran).toEqual([]);
  });

  it("puts back a missing trigger and touches no table", async () => {
    const { client, ran } = fake({ events: true, trigger: false });
    const outcome = await createSchema(client);
    expect(outcome).toEqual({ created: false, repaired: ["the NOTIFY trigger and the append-only rules"] });
    expect(ran).toEqual([NOTIFY_SQL]);
  });
});
