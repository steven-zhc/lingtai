/**
 * **What a command that appends does on a machine whose log is SQLite**: it
 * refuses, by name, and writes nothing — until #175.
 *
 * Absence chooses the store (#179, [0055](../../../doc/decisions/0055-absence-chooses-the-store.md)),
 * and the store is ahead of the system around it: the projections and the
 * `LISTEN`/`NOTIFY` waker still read `databaseUrl()`, so a command that holds a
 * projector — `approve`, `run`, `ask`, `close`, `end`, `backlog`, `requeue` —
 * dies in `createProjectionRunner` before it has done anything, by name.
 *
 * **Two kinds of command hold no projector, and they were the hole.** `add`
 * onboards a repository, and `pause`/`resume`/`shutdown`/`now` append a control
 * event — deliberately without a projector, so a pause against a daemon that
 * has been down does not replay the backlog first (`lingtai.ts`'s
 * `controlCommand`). Both reach `eventStore` directly, and since the singleton
 * opens whichever store this machine chose, both *succeeded* on a SQLite
 * machine: `lingtai add steven/foo` printed its onboarding summary and exited
 * 0, having written `ProjectConfigured` at seq 1 into a log the board cannot
 * read, `lingtai run` cannot conduct from, and the same command's own advice
 * then tells the operator to abandon by naming a Postgres URL. That is the one
 * outcome worse than refusing: work recorded where nothing will look for it.
 *
 * **And `board` is the third, because serving is not reading.** The board runs
 * *in the CLI's own process*, and the first screen of `/setup/github-app` is a
 * Create button that runs `create-app.ts`'s `append(...GitHubAppCreated)`
 * through this same singleton. The page only reads to decide whether to offer
 * it, so nothing refuses on the way in; the append arrives after a press, with
 * no projector and no Postgres between it and `~/.lingtai/lingtai.db`, and the
 * page then says the App is on Lingtai's log. `lingtai init` stops before this
 * screen for the same reason (0055 §7) — `lingtai board` is the other door to
 * it, and needs the same guard.
 *
 * So the refusal every operator-facing document already promised — README,
 * `.env.example`, `doc/operating.md`, `lingtai init`'s amber line and `lingtai
 * doctor`'s `store` row all say *lingtai add, approve and run refuse by name* —
 * is made true here rather than assumed. It names `LINGTAI_DATABASE_URL`, says
 * nothing was written, and gives both ways out.
 *
 * **This whole file goes when #175 lands.** Nothing else has to change for it
 * to: the moment the projections and the waker take whichever store
 * `storeChoice` chose, a SQLite machine is a working machine, and these three
 * commands are the only callers.
 */
import { storeChoice } from "@lingtai/env";

/**
 * The sentence to print and refuse with, or null where this machine's log is a
 * Postgres one and the command may go on.
 *
 * A machine that names only `LINGTAI_DIRECT_DATABASE_URL` is neither: it is a
 * Postgres machine missing a line, and `storeChoice` throws there by name
 * (0055 §2). That throw is left to propagate — the caller is already a command
 * that would have hit it one line later.
 */
export function refusedBecauseSqlite(from: NodeJS.ProcessEnv = process.env): string | null {
  const choice = storeChoice(from);
  if (choice.kind === "postgres") return null;
  return (
    `LINGTAI_DATABASE_URL is not set, and nothing else names a Postgres connection — so this machine's log ` +
    `is SQLite, in ${choice.path}, which is what naming none chooses (#179). Nothing that appends runs on it ` +
    `yet: the projections and the LISTEN/NOTIFY waker are still Postgres (#175), so an event written there is ` +
    `one the board, lingtai status and every later pass cannot read. Nothing was written. Name a Postgres URL ` +
    `— the variable, .env.local, or lingtai init — and lingtai doctor's store row says which store it found`
  );
}
