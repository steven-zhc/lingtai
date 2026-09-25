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
import { withProjectionStore } from "./choose.ts";
import { describeDrift } from "./store.ts";
import type {
  Projection,
  ProjectionContext,
  ProjectionDrift,
  ProjectionStore,
} from "./store.ts";

/**
 * Drift — what it is, how it is said, and the error that carries it — is
 * declared in `store.ts` and re-exported from here, which is where every reader
 * of it already looks. It sits there because the twins' read path raises it too
 * (`columnOf`) and this file reaches a store through `choose.ts`: importing it
 * from here would make `sqlite.ts` load `pg`.
 */
export { ProjectionShapeError, describeDrift, type ProjectionDrift } from "./store.ts";

export interface ProjectionShape {
  projection: string;
  /** Declared, created, and matching. */
  matched: readonly string[];
  /** Declared and not created yet. Not drift: `create` will make them. */
  absent: readonly string[];
  /** Declared, created, and different. */
  drift: readonly ProjectionDrift[];
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

/** The comparison, against a store somebody else owns. */
export async function shapeIn(
  projection: Projection,
  store: ProjectionStore,
): Promise<ProjectionShape> {
  const declared = await declaredShape(projection);
  const tables = [...declared.keys()];
  if (tables.length === 0) {
    return { projection: projection.name, matched: [], absent: [], drift: [] };
  }

  const live = await store.columnsOf(tables);

  const matched: string[] = [];
  const absent: string[] = [];
  const drift: ProjectionDrift[] = [];
  for (const [table, columns] of declared) {
    const have = live.get(table);
    // Absent from the catalogue means the table does not exist, and a table
    // that does not exist is not drifted — `create` makes it, at the current
    // shape.
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
 * The same comparison, on a connection of its own. What `lingtai doctor` asks.
 *
 * Reads the catalogue and nothing else, which is the rule the doctor is built
 * on: a diagnostic that writes to the system of record is the wrong shape.
 */
export async function projectionShape(
  projection: Projection,
  url?: string,
): Promise<ProjectionShape> {
  // `url` refines a Postgres connection and never picks the store: `lingtai
  // doctor` is the one caller that names one (#214), and a URL in an argument
  // must not open a store this machine did not choose (0056).
  return withProjectionStore({ ...(url === undefined ? {} : { url }), max: 1 }, (store) =>
    shapeIn(projection, store),
  );
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
