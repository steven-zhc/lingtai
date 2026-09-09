/**
 * Whether a projection's table still has the columns its DDL declares.
 *
 * `create` is `create table if not exists`, so it runs once and never again.
 * Every later change to the DDL is therefore a change to a *statement nobody
 * executes*, and the table goes on holding the shape it was born with. #84 added
 *
 *     awaiting_approval boolean not null default false,
 *
 * to `task_view`'s `create table`, the live table had been created days earlier,
 * and the first append after the merge threw `column task_view.awaiting_approval
 * does not exist` and stopped the daemon with it. The checkpoint froze at 933
 * against a head of 941, a run in flight was orphaned, and the board was stale
 * until somebody noticed.
 *
 * Nothing was wrong with the tests: a test database gets a *fresh* table, with
 * the new column. Nothing was wrong with the remedy either — `lingtai projection
 * rebuild task_view` fixes it, and is documented. The gap was that the one check
 * covering projections looked at **lag**, and lag was zero right up to the
 * moment the column was needed.
 *
 * So: read the columns out of the DDL itself, read the columns out of the
 * catalogue, and compare. Two properties make this worth having.
 *
 * **The DDL is the only source of truth.** The declared columns are not a second
 * list somebody has to remember to update — they are recovered by running
 * `create` against a context that records the SQL instead of executing it. A
 * column that is in the `create table` is declared, by construction.
 *
 * **It costs one catalogue query.** No rebuild, no probe table, no write at all,
 * so it can run on every `lingtai doctor` and at every daemon start — which is
 * the whole point, because the alternative is finding out when the daemon stops.
 */
import pg from "pg";
import { databaseUrl } from "@lingtai/env";
import type { Projection, ProjectionContext } from "./projection.ts";

/** One table that exists and does not match the DDL that declares it. */
export interface ProjectionDrift {
  table: string;
  /** Declared by the DDL, absent from the live table. The #84 direction. */
  missing: readonly string[];
  /** In the live table, no longer declared. A `not null` leftover breaks inserts. */
  unexpected: readonly string[];
}

export interface ProjectionShape {
  projection: string;
  /** Declared, created, and matching. */
  matched: readonly string[];
  /** Declared and not created yet. Not drift: `create` will make them. */
  absent: readonly string[];
  /** Declared, created, and different. */
  drift: readonly ProjectionDrift[];
}

/**
 * A projection whose table no longer matches its DDL, refused rather than
 * followed.
 *
 * Thrown by `start()`, so a process that would trip over the missing column
 * says so before it takes any work — the message names the remedy, because the
 * remedy is not obvious from `column x does not exist`.
 */
export class ProjectionShapeError extends Error {
  // Assigned in the body, not declared as constructor parameters: a parameter
  // property is the one TypeScript form Node's type stripping refuses, and
  // nothing but running it under Node catches that (0010).
  readonly projection: string;
  readonly drift: readonly ProjectionDrift[];

  constructor(projection: string, drift: readonly ProjectionDrift[]) {
    super(describeDrift(projection, drift));
    this.name = "ProjectionShapeError";
    this.projection = projection;
    this.drift = drift;
  }
}

/** Table-level clauses that sit where a column name would. */
const NOT_A_COLUMN = new Set(["primary", "unique", "constraint", "check", "foreign", "exclude", "like"]);

const CREATE_TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_$]*)"?\s*\(/i;

/**
 * The body between a `(` and its match, with `--` comments elided.
 *
 * The comments have to go before the commas are counted: `task_view` documents
 * half its columns in prose, and prose has commas in it.
 */
function body(sql: string, open: number): string | null {
  let depth = 0;
  let quoted = false;
  let out = "";
  for (let i = open; i < sql.length; i++) {
    const c = sql[i]!;
    if (quoted) {
      out += c;
      if (c === "'") quoted = false;
      continue;
    }
    if (c === "'") {
      quoted = true;
      out += c;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      if (nl === -1) return null;
      i = nl - 1;
      continue;
    }
    if (c === "(") {
      depth++;
      if (depth === 1) continue;
    } else if (c === ")") {
      depth--;
      if (depth === 0) return out;
    }
    out += c;
  }
  return null;
}

/** Splits on commas that are not inside `numeric(10, 2)` or a string literal. */
function definitions(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (const c of inner) {
    if (quoted) {
      cur += c;
      if (c === "'") quoted = false;
      continue;
    }
    if (c === "'") quoted = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/**
 * The columns one statement declares, or null if it is not a `create table`.
 *
 * Indexes and everything else a `create` issues fall through as null, which is
 * what makes recording the whole of `create` safe.
 */
export function declaredColumns(sql: string): { table: string; columns: string[] } | null {
  const head = CREATE_TABLE.exec(sql);
  if (!head) return null;
  const inner = body(sql, head.index + head[0].length - 1);
  if (inner === null) return null;

  const columns: string[] = [];
  for (const def of definitions(inner)) {
    const word = /^\s*"?([a-z_][a-z0-9_$]*)"?/i.exec(def);
    if (!word) continue;
    const name = word[1]!.toLowerCase();
    if (NOT_A_COLUMN.has(name)) continue;
    columns.push(name);
  }
  return { table: head[1]!.toLowerCase(), columns };
}

/**
 * What the projection's own DDL says its tables look like.
 *
 * `create` is called with a context that records rather than executes, so this
 * touches no database and cannot be out of date with respect to the code that
 * runs. It is also why `create` must not read its own query results — see the
 * note on `Projection.create`.
 */
export async function declaredShape(projection: Projection): Promise<Map<string, string[]>> {
  const declared = new Map<string, string[]>();
  const recorder: ProjectionContext = {
    async query(text: string) {
      const table = declaredColumns(text);
      if (table) declared.set(table.table, table.columns);
      return [];
    },
  };
  await projection.create(recorder);
  return declared;
}

/** The comparison, inside a connection somebody else owns. */
export async function shapeIn(
  projection: Projection,
  ctx: ProjectionContext,
): Promise<ProjectionShape> {
  const declared = await declaredShape(projection);
  const tables = [...declared.keys()];
  if (tables.length === 0) {
    return { projection: projection.name, matched: [], absent: [], drift: [] };
  }

  const rows = await ctx.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns
     where table_schema = current_schema() and table_name = any($1::text[])`,
    [tables],
  );
  const live = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = live.get(row.table_name) ?? new Set<string>();
    set.add(row.column_name);
    live.set(row.table_name, set);
  }

  const matched: string[] = [];
  const absent: string[] = [];
  const drift: ProjectionDrift[] = [];
  for (const [table, columns] of declared) {
    const have = live.get(table);
    // No row in the catalogue means the table does not exist, and a table that
    // does not exist is not drifted — `create` makes it, at the current shape.
    if (!have) {
      absent.push(table);
      continue;
    }
    const missing = columns.filter((c) => !have.has(c));
    const unexpected = [...have].filter((c) => !columns.includes(c)).sort();
    if (missing.length === 0 && unexpected.length === 0) matched.push(table);
    else drift.push({ table, missing, unexpected });
  }
  return { projection: projection.name, matched, absent, drift };
}

/**
 * The same comparison, on its own connection. What `lingtai doctor` asks.
 *
 * Reads `information_schema` and nothing else, which is the rule the doctor is
 * built on: a diagnostic that writes to the system of record is the wrong shape.
 */
export async function projectionShape(
  projection: Projection,
  url = databaseUrl(),
): Promise<ProjectionShape> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await shapeIn(projection, {
      async query(text, values) {
        const r = await client.query(text, values ? [...values] : undefined);
        return r.rows;
      },
    });
  } finally {
    await client.end();
  }
}

/**
 * The finding, with the remedy in it.
 *
 * `column task_view.awaiting_approval does not exist` is the symptom, and it
 * sends the reader looking for a migration that does not exist. Naming the
 * rebuild is the difference between a diagnosis and a puzzle.
 */
export function describeDrift(projection: string, drift: readonly ProjectionDrift[]): string {
  const what = drift
    .map((d) => {
      const bits: string[] = [];
      if (d.missing.length > 0) bits.push(`missing ${d.missing.join(", ")}`);
      if (d.unexpected.length > 0) bits.push(`no longer declared: ${d.unexpected.join(", ")}`);
      return `${d.table} ${bits.join("; ")}`;
    })
    .join(" · ");
  return `${projection} has drifted from its table — ${what}. Replay, never a repair by hand: lingtai projection rebuild ${projection}`;
}

/** One line for a report: what was compared, and what it found. */
export function describeShape(shape: ProjectionShape): string {
  if (shape.drift.length > 0) return describeDrift(shape.projection, shape.drift);
  const parts: string[] = [];
  if (shape.matched.length > 0) {
    parts.push(`${shape.matched.join(", ")} match the columns the DDL declares`);
  }
  if (shape.absent.length > 0) {
    parts.push(`${shape.absent.join(", ")} not created yet — create makes them at the current shape`);
  }
  return parts.join(" · ") || `${shape.projection} declares no tables`;
}
