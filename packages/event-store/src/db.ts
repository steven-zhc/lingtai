import postgres from "@prisma/orm-postgres/runtime";
import { postgresUrl } from "./env.ts";
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
export function createDb(url: string = postgresUrl()) {
  return postgres<Contract>({ contractJson, url });
}

export type Db = ReturnType<typeof createDb>;

/*
 * There is no process-wide `db` here any more (#179).
 *
 * `export const db = createDb()` ran at import and called `postgresUrl()`
 * there, so importing this package — which every `lingtai` command does — was
 * a Postgres install's admission test: a machine that had written `sqlite` was
 * refused before anything could read what it had written, and
 * `apps/cli/src/entry.ts` had to answer five commands before `lingtai.ts`
 * loaded at all.
 *
 * The one client a process holds is `processLog()`'s in `choose.ts`, built
 * from the written choice at first use. This factory stays for the caller that
 * wants a *second*, independent connection — 0009's reason, unchanged.
 */
