import postgres from "@prisma/orm-postgres/runtime";
import { databaseUrl } from "./env.ts";
import type { Contract } from "./prisma/contract.d.ts";
import contractJson from "./prisma/contract.json" with { type: "json" };

/**
 * A client against Lingtai's own database. Never one belonging to a managed
 * project — it has to keep running while a managed project is the thing being
 * changed.
 *
 * The factory exists so a caller can hold a *second*, independent connection.
 * That is not a test convenience: 0009 is the record of a probe that shared one
 * connection between the actor and the observer and therefore proved nothing.
 * Anything claiming two writers race, or that a listener hears a writer, has to
 * be able to build the second client.
 *
 * Each call constructs its own `pg.Pool`. Close what you open — `await
 * client.close()` — or the process will not exit.
 */
export function createDb(url: string = databaseUrl()) {
  return postgres<Contract>({ contractJson, url });
}

export type Db = ReturnType<typeof createDb>;

/**
 * The process-wide client. Long-lived; never closed in a server — and built on
 * **first use** rather than at import (#179).
 *
 * It used to be `export const db = createDb()`, which read `databaseUrl()` while
 * this module loaded. That was a reasonable side effect while a machine with no
 * `LINGTAI_DATABASE_URL` was a misconfigured machine; since absence chooses
 * SQLite it is an ordinary one, and importing the barrel there must not demand
 * a URL nobody was asked for. Nothing else moves: still one client per process.
 */
let client: Db | undefined;
export function postgresDb(): Db {
  client ??= createDb();
  return client;
}
