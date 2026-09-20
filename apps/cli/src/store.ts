/**
 * **What a command does on a machine whose log is SQLite**: it refuses, by
 * name, and writes nothing — until #175.
 *
 * Absence chooses the store (#179, [0055](../../../doc/decisions/0055-absence-chooses-the-store.md)),
 * and the store is ahead of the system around it: the projections, the
 * `LISTEN`/`NOTIFY` waker and the board's `task_view` reads still take
 * `databaseUrl()`, so on a machine that names no Postgres connection there is
 * nothing for any of them to open. The sentence below is what every
 * operator-facing document already promised — README, `.env.example`,
 * `doc/operating.md`, `lingtai init`'s amber line and `lingtai doctor`'s
 * `store` row all say *lingtai add, approve and run refuse by name*.
 *
 * **It was asked for at three doors, and the house has twenty.** The first
 * attempt guarded the commands that hold no projector — `add`, the four
 * control verbs, and `board`, which serves the App wizard — on the reasoning
 * that every other appending command dies in `createProjectionRunner`, which
 * reads `databaseUrl()` while it is being built. Two things were wrong with
 * that:
 *
 * - **The projector is not the first thing those commands touch.** `ask`,
 *   `answer`, `close`, `requeue` and `approve` call `loadProject` *before*
 *   `withProjector`, and `run` reads the pause off the control stream before
 *   it builds anything (`run.ts`'s `heedThePause`). Each of those goes through
 *   `@lingtai/event-store`'s singleton, which since #179 opens whichever store
 *   absence chose — so each one created `~/.lingtai/lingtai.db`, read the empty
 *   log it had just made, and refused with `no project named "foo"` or `no
 *   GitHub App configured`: a sentence about the wrong fault, on a machine the
 *   command had just quietly given a log to.
 * - **`drain()` is a second door to an identical append.** `lingtai shutdown`
 *   was guarded and `lingtai service shutdown` was not, though both end at
 *   `requestShutdownUnlessStanding` and `ConductorShutdownRequested`. Under
 *   launchd it drained, wrote the request into a fresh SQLite log the running
 *   daemon reads nothing of, printed `withdrew the drain`, and exited 0 — the
 *   drain #174 exists to perform, reported as done and never performed.
 *
 * So the question is asked the other way round. `REFUSAL` below has a row for
 * every command `lingtai.ts` dispatches, the gate at the top of `main` refuses
 * on this machine before any of them runs, and what is left — `doctor`, which
 * is the command that *says* which store this is, `env`, `attach`, `version`,
 * `init`, `help` — is named rather than inferred. A command added later with
 * no row is refused too: `pure/store.test.ts` fails on a `case` the table does
 * not carry, which is #167's rule for `RESTART_GUARDS` applied here.
 *
 * **This whole file goes when #175 lands.** Nothing else has to change for it
 * to: the moment the projections and the waker take whichever store
 * `storeChoice` chose, a SQLite machine is a working machine, the gate stops
 * firing and the table is deleted with it.
 */
import { storeChoice } from "@lingtai/env";

/**
 * Where each command's refusal on a SQLite machine is asked for.
 *
 * - `here` — the gate at the top of `main`, before the command runs at all.
 * - `within` — the command asks `refusedBecauseSqlite` itself, because
 *   something has to be answered first. Only the four control verbs, and only
 *   for `--help`: `lingtai shutdown --help` once took `--help` as the reason
 *   and stopped the daemon, so a question is answered before anything else on
 *   every machine, including this one. `controlCommand` asks on the next line.
 * - `never` — runs where there is no log. Each is about the *installation* or
 *   the machine rather than about the log, which is `entry.ts`'s rule for the
 *   five it answers before `lingtai.ts` is imported at all.
 *
 * A row per command and nothing derived, so that a command with no row is a
 * failing test rather than a door nobody counted.
 */
export const REFUSAL: Readonly<Record<string, "here" | "within" | "never">> = {
  add: "here",
  answer: "here",
  approve: "here",
  ask: "here",
  backlog: "here",
  board: "here",
  close: "here",
  daemon: "here",
  end: "here",
  projection: "here",
  requeue: "here",
  restart: "here",
  run: "here",
  service: "here",
  start: "here",
  status: "here",

  now: "within",
  pause: "within",
  resume: "within",
  shutdown: "within",

  "-h": "never",
  "--help": "never",
  attach: "never",
  doctor: "never",
  env: "never",
  help: "never",
  init: "never",
  version: "never",
};

/**
 * What else a refusal has to say, where the command's own hazard is not the
 * obvious one.
 *
 * `board` appends nothing itself: it *serves the page that does*. The board
 * runs in the CLI's own process, and the first screen of `/setup/github-app`
 * is a Create button that runs `create-app.ts`'s `append(...GitHubAppCreated)`
 * through the same singleton — so a SQLite machine got its App minted and
 * recorded at seq 1, and the page said so, on the one machine every other
 * command tells the operator to abandon. `lingtai init` stops before this
 * screen (0055 §7); this is the other door to it.
 */
export const ALSO: Readonly<Record<string, string>> = {
  board: "the board is served from this process, and its first screen is the App wizard, which appends GitHubAppCreated",
};

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
