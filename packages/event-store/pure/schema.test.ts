import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, NOTIFY_SQL, type Queryable, createSchema } from "../src/schema.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A connection that answers the catalogue questions from a set of names, and
 * records what it was asked to run. Enough to check the order and the
 * all-or-nothing shape; that the SQL itself is right is Prisma's plan, and
 * `pnpm db:bootstrap` proves it against a database.
 */
function fake(present: { events: boolean; trigger: boolean }) {
  const ran: string[] = [];
  const client: Queryable = {
    async query(sql) {
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
