import { config, parse } from "dotenv";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

/**
 * Where configuration values come from, for every package that needs one.
 *
 * Loads the environment from the workspace root rather than from whichever
 * directory a command happened to start in.
 *
 * `dotenv/config` alone would only read `packages/event-store/.env`, which is wrong
 * twice over: the file belongs at the root, where the board and the CLI will
 * also want it, and it should be `.env.local` so that `.env.example` can stay
 * committed as the template.
 *
 * Order is priority — dotenv does not overwrite a key that is already set, so
 * the first file to define one wins. A real environment variable beats them all,
 * which is what makes CI and launchd work without a file at all.
 *
 * **The database URL has a third source, behind both**: `database.url` in
 * `~/.lingtai/config.yml`, where `lingtai init` writes the one it verified
 * (#186). `postgresUrl` and `directUrlIfSet` fall back to it when neither the
 * environment nor an env file names one — see `machineDatabaseUrl` — so a
 * command that connects with no variable and no env file is reading that file.
 */
const here = dirname(fileURLToPath(import.meta.url));
/**
 * `packages/env/src` → the repository root. Bundled, `import.meta.url` is
 * `dist/lingtai.cjs`'s, and the root is one directory up (#183):
 * `apps/release/src/build.ts` defines `LINGTAI_BUNDLED`, and the source never does.
 */
declare const LINGTAI_BUNDLED: boolean | undefined;
const root = resolve(here, typeof LINGTAI_BUNDLED === "undefined" ? "../../.." : "..");

/**
 * What was really exported into this process, taken **before** any env file is
 * merged into `process.env` below.
 *
 * One reader, `storeChoice`, has to tell a variable somebody exported from a
 * variable a checkout's `.env.local` supplied, and after `config()` has run
 * `process.env` cannot be asked: dotenv sets a name it did not find and leaves
 * one it did, so the merged environment holds no record of which happened.
 * [0056 §4](../../../doc/decisions/0056-the-store-is-a-written-choice.md) is
 * why that distinction exists — the file is found by walking up from this
 * source file, so whether it exists depends on the directory a process started
 * in, and a fact four processes must agree about cannot come from there.
 *
 * Every other reader here still asks the merged environment, which is what
 * makes `.env.local` a convenience for everything else.
 */
const exported: NodeJS.ProcessEnv = { ...process.env };

const loaded = config({
  path: [resolve(root, ".env.local"), resolve(root, ".env")],
  quiet: true,
});

/**
 * What the machine's own env **file** holds — not the whole process environment.
 *
 * The distinction is the whole of `#60`'s default. An agent's environment is
 * "the two files merged" ([0021](../../../doc/decisions/0021-the-recipe-decides-the-environment.md)):
 * this one and the project's. It is deliberately **not** `process.env`, because
 * that also carries the operator's shell — `AWS_*`, npm tokens, whatever is
 * exported in the terminal a command was typed into — and none of that is
 * something either file said to hand over.
 *
 * `LINGTAI_*` names are stripped by `agent-env`, not here: this function's job
 * is to say what the file holds, and whose it is, is somebody else's question.
 */
export function machineEnvFile(): Record<string, string> {
  return { ...(loaded.parsed ?? {}) };
}

/**
 * Whether this process is a test run.
 *
 * Vitest sets `VITEST`; the explicit override exists for anything that runs the
 * suite by another name.
 */
function inTest(from: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(from["VITEST"] || from["LINGTAI_TEST"]);
}

/**
 * The connection a test may use, which is never the operator's.
 *
 * This is a choke point on purpose. The alternative — teaching each test to
 * pick the right URL — leaves every default I did not audit still pointing at
 * the real database, and `integrate()` and `approve()` both fall back to the
 * default store when no store is passed.
 *
 * It **throws** when the test URL is missing rather than falling back. A silent
 * fallback is how the operator's board came to hold twenty-four cards from ten
 * throwaway `esctest*` projects and not one real one: the suite had been
 * writing to the live log for as long as it had existed, and nothing said so.
 *
 * Deleting that afterwards is not cheap either. A projection can be truncated
 * and replayed, so the cards come back; the only way to remove them is to
 * delete from an append-only log, which is a thing this system should never
 * make routine.
 */
/**
 * Which variable to read for a connection, given who is asking.
 *
 * Exported because two callers cannot go through `postgresUrl()`: Prisma's
 * config and the bootstrap script both have to work with *nothing* configured
 * — `contract emit` and `migration plan` are offline commands — so they read
 * the variable rather than demanding it. They still have to obey the same rule
 * about which variable, and this is that rule, written once.
 *
 *   LINGTAI_TEST=1 pnpm --filter @lingtai/event-store db:bootstrap
 *
 * is how the test database gets its schema.
 */
export function dbVar(name: "DATABASE_URL" | "DIRECT_DATABASE_URL", from: NodeJS.ProcessEnv = process.env): string {
  return inTest(from) ? `${PREFIX}TEST_${name}` : `${PREFIX}${name}`;
}

/**
 * **Every name Lingtai reads for itself begins with this** (`#63`).
 *
 * Not tidiness. Since 0021 the agent's environment is `process.env` merged with
 * the project's own file, the file winning — so a project whose file is missing
 * a `DATABASE_URL` line got **Lingtai's own log** under a name its application
 * connects to without hesitating, and `required: [DATABASE_URL]` could not tell
 * that apart from a correct line because the merged data had a value either
 * way. A missing line and a right one gave the same answer.
 *
 * `LINGTAI_DATABASE_URL` is a name no managed application asks for, so the
 * missing line becomes an ordinary absent one, which `required` catches loudly
 * before anything is claimed.
 *
 * [0021](../../../doc/decisions/0021-the-recipe-decides-the-environment.md)
 * decided to remove `RESERVED` — the denylist that stopped a recipe naming
 * Lingtai's own credentials — on the grounds that exposure is the operator's to
 * manage. That removal is `#60` and has not landed yet; this makes it safe to
 * land, because after the prefix there is no generic name left in the
 * conductor's environment worth reaching for. Structural, rather than
 * remembered.
 *
 * `TEST_` goes *after* the prefix: `LINGTAI_TEST_DATABASE_URL`, so the rule
 * "begins with `LINGTAI_`" has no exceptions and is therefore checkable — see
 * `test/prefix.test.ts`, which reads this file.
 *
 * **A project's own file is not covered.** `DATABASE_URL` in
 * `nextloom-ai-admin.env` stays `DATABASE_URL`, because that is what admin's
 * application reads. This is only about the names Lingtai uses for itself.
 */
export const PREFIX = "LINGTAI_";

/**
 * The old, unprefixed name, when it is set and the new one is not.
 *
 * Only consulted on the path that was going to fail anyway, so an operator with
 * a `DATABASE_URL` of their own for something else is never bothered. Without
 * it the message is "LINGTAI_DATABASE_URL is not set" about a machine where
 * `DATABASE_URL` is plainly set, which reads as a bug in Lingtai.
 *
 * **Delete this once no machine running Lingtai predates `#63`** — in practice,
 * once this operator's `.env.local` and `~/.lingtai/env/lingtai.env` are
 * renamed, which the same change did. It is kept only for a machine that
 * upgrades later.
 */
function renamedFrom(name: string, from: NodeJS.ProcessEnv): string | null {
  const old = name.startsWith(`${PREFIX}TEST_`)
    ? `TEST_${name.slice(`${PREFIX}TEST_`.length)}`
    : name.slice(PREFIX.length);
  return from[old] ? old : null;
}

function testUrl(name: string, from: NodeJS.ProcessEnv = process.env): string {
  const full = `${PREFIX}TEST_${name}`;
  const value = optional(full, from);
  if (!value) {
    const was = renamedFrom(full, from);
    throw new Error(
      `${full} is not set, and the tests will not run against ${PREFIX}${name}. ` +
        (was ? `${was} is set — it was renamed to ${full} (#63). ` : "") +
        "The suite writes real events, and writing them to the operator's own log " +
        "leaves work items and board cards that only deleting from an append-only " +
        `table can remove. Point ${PREFIX}TEST_DATABASE_URL and ` +
        `${PREFIX}TEST_DIRECT_DATABASE_URL at a database of their own — see .env.example.`,
    );
  }
  return value;
}

function required(name: string, from: NodeJS.ProcessEnv = process.env): string {
  const v = from[name];
  if (!v) {
    const was = renamedFrom(name, from);
    throw new Error(
      `${name} is not set. ` +
        (was
          ? `${was} is set — it was renamed to ${name} (#63), so that a project's own ` +
            `${was} can never be confused with Lingtai's. Rename the line.`
          : name.includes("DATABASE_URL")
            ? "lingtai init asks for one and writes it to ~/.lingtai/config.yml; from a checkout, .env.local at the repo root works too."
            : "Copy .env.example to .env.local at the repo root and fill it in."),
    );
  }
  return v;
}

/**
 * `database.url` in `~/.lingtai/config.yml` — where `lingtai init` writes the
 * one it was given and verified (#186) — or undefined where the file names none.
 *
 * **Behind the environment and the env files, never in front of them**: a set
 * `LINGTAI_DATABASE_URL` wins, as a real variable beats a file everywhere else
 * here. And **never for a test** — `postgresUrl` and `directUrlIfSet` do not ask
 * this while `inTest`, because a file on the operator's machine is exactly the
 * operator's log, and `testUrl` exists to refuse that.
 *
 * One URL, not two: 1.0's store has no pooled/direct split (doc/design/1.0.md),
 * so this stands in for both names. A file that does not parse is refused by
 * name rather than read as no URL, which would say *not set* about a machine
 * where somebody plainly set one.
 */
export function machineDatabaseUrl(from: NodeJS.ProcessEnv = process.env): string | undefined {
  const machine = machineDatabase(from);
  if (machine.unreadable !== undefined) throw new Error(machine.unreadable);
  return machine.url;
}

interface MachineDatabase {
  /** `database.url`, where the file has one. */
  url?: string;
  /** Why the file could not be read at all — never *it names no URL*. */
  unreadable?: string;
}

/**
 * What the file says, as data: a URL, nothing, or a file that could not be read
 * at all — **three answers and not two**, so that a caller which must not refuse
 * does not have to catch one (#213).
 *
 * `machineDatabaseUrl` is this plus the refusal, for the callers that are about
 * to connect; `machineUrlIfReadable` is this without it, for the two readers
 * that only look.
 */
function machineDatabase(from: NodeJS.ProcessEnv): MachineDatabase {
  const path = join(stateDir(from), "config.yml");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    return {
      unreadable: `${path} could not be parsed as YAML, so its database.url could not be read: ${(err as Error).message}`,
    };
  }
  const database = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>)["database"] : undefined;
  const url = database !== null && typeof database === "object" ? (database as Record<string, unknown>)["url"] : undefined;
  return typeof url === "string" && url !== "" ? { url } : {};
}

/** The machine file's URL, asked only of this process's own environment and never in a test. */
function machineUrl(from: NodeJS.ProcessEnv): string | undefined {
  return from === process.env && !inTest(from) ? machineDatabaseUrl(from) : undefined;
}

/**
 * The same, **total**: a `config.yml` that does not parse is undefined here
 * rather than a thrown error.
 *
 * The refusal is not lost, it is moved to the caller it belongs to — the one
 * opening a connection, which is where naming the broken file is a remedy
 * (#186). `postgresUrlIfSet`, `directUrlIfSet` and so `logConfigured` are
 * questions *about* configuration, and a question about configuration that
 * throws is the same defect #213 is about, one layer down: `lingtai upgrade`
 * and `lingtai uninstall` are the two commands that repair a broken install,
 * and a half-written `config.yml` must not be what stops them.
 */
function machineUrlIfReadable(from: NodeJS.ProcessEnv): string | undefined {
  return from === process.env && !inTest(from) ? machineDatabase(from).url : undefined;
}

// --------------------------------------------------------------- the store --

/** The two stores a machine can run (0055). */
export type Store = "postgres" | "sqlite";

/** Where a choice was read: this process's real environment, or the machine file. */
export type StoreSource = "environment" | "config.yml";

export type StoreChosen =
  | {
      store: "postgres";
      url: string;
      /**
       * The session-mode connection **to the database `url` names**, for the
       * one thing that cannot go through a transaction pooler: `LISTEN`/
       * `NOTIFY` (0009).
       *
       * It is part of the choice rather than a second lookup because
       * `directPostgresUrl()` answers a different question — *what does this
       * process's merged environment name* — and the two are not the same
       * database. A machine whose `config.yml` says `url: A` beside a
       * checkout's `.env.local` holding `LINGTAI_DATABASE_URL=B` would open
       * the store on A and register the `LISTEN` on B: every append lands in
       * A, no notification from A ever reaches a session on B, and each
       * subscriber drains once on connect and is never nudged again while the
       * board goes on rendering that one drain. Silent, and exactly the
       * split-log failure 0056 exists to remove.
       *
       * So it is `url` itself unless a session-mode name was *really exported*
       * — the one legitimate second URL, because on Supabase the pooled and
       * direct strings genuinely differ (0009). A `config.yml` carries one URL
       * and it stands in for both names, which is what `machineDatabaseUrl`
       * already says.
       */
      directUrl: string;
      where: StoreSource;
      from: string;
    }
  | { store: "sqlite"; path: string; where: StoreSource; from: string };

/**
 * Which refusal it is.
 *
 * A caller that only reports prints `refused` and needs none of this. `lingtai
 * init` is the one caller that *repairs* them, and it treats them differently:
 * nothing chosen is the question it is about to ask anyway, while the other two
 * are a file it is fixing and says so first.
 */
export type StoreUnchosen = "nothing chosen" | "no url" | "two keys" | "unreadable";

export interface StoreRefused {
  refused: string;
  because: StoreUnchosen;
}

export type StoreChoice = StoreChosen | StoreRefused;

/** The log's file when a machine chose SQLite, under `stateDir()` (doc/design/1.0.md). */
export const SQLITE_LOG = "lingtai.db";

/**
 * **The one sentence anything operator-facing says about a SQLite machine.**
 *
 * A constant because the last attempt to change what this claim says had to
 * edit six copies of it — `lingtai init`'s amber line, a `doctor` row's detail,
 * the README, `.env.example`, `doc/operating.md` and an ADR — and the review
 * that refused it named the six as the reason it could not be read (#215). Six
 * copies is also six chances for one of them to go on saying the old thing
 * after #179 lands.
 *
 * The documents point here rather than restating it. A caller may add its own
 * remedy after it — which command *it* offers is its own business — and must
 * not rewrite the claim.
 *
 * **#179 does not rewrite it, though #179 is the ticket named in it.** Both
 * readers are under `apps/cli/` — `lingtai init`'s amber line and a `doctor`
 * row — and both still act on the old claim: `sqliteChosen` prints this and
 * returns 1 without serving a board, and `storeRow` renders the machine as
 * `warn`. Changing the sentence alone would tell an operator that SQLite runs,
 * one line above a command that exits non-zero and offers Postgres instead.
 *
 * So it goes stale here, knowingly: the stores do open from a written `sqlite`
 * now, and this line and its two readers move together at
 * [#214](https://github.com/steven-zhc/lingtai/issues/214), where `init` and
 * `doctor` read the choice. That is what one constant is *for* — the claim
 * changes in one edit, beside the commands that act on it, rather than in six
 * files that then disagree.
 */
export const SQLITE_NOT_OPEN_YET =
  "SQLite is a choice this machine can record and no version opens it yet — #179 is what makes a store open from the " +
  "written choice. Until that lands, Postgres is the store this version runs on";

/**
 * The variables really exported into this process.
 *
 * An environment handed in never had an env file merged into it, so it is
 * already its own answer — which is also what lets `lingtai init` and a test
 * drive this function with an environment of their own.
 */
function realEnvironment(from: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return from === process.env ? exported : from;
}

/**
 * The file the choice is read from, or null where this environment has none.
 *
 * This process's own environment reads the machine's file unless this is a test
 * run — `machineUrl`'s rule, for its reason: the suite's environment must never
 * reach the operator's file. An environment handed in reads one only when it
 * names its own `LINGTAI_HOME`, so a test that hands in `{}` is answered
 * without touching any machine at all.
 */
function machineChoiceFile(from: NodeJS.ProcessEnv): string | null {
  if (from === process.env) return inTest(from) ? null : join(stateDir(from), "config.yml");
  return from["LINGTAI_HOME"] ? join(stateDir(from), "config.yml") : null;
}

/**
 * The session-mode connection that goes with a chosen Postgres URL — see
 * `StoreChosen.directUrl` for why it is part of the choice and not a second
 * lookup.
 *
 * Read by the same rule the choice itself is: the *exported* name for a
 * machine, the merged one for a test, which is what keeps a checkout's
 * `.env.local` out of a machine's selection (0056 §4) while leaving
 * `LINGTAI_TEST_DIRECT_DATABASE_URL` exactly where the suite is told to put it.
 */
function sessionUrlFor(url: string, from: NodeJS.ProcessEnv): string {
  return optional(dbVar("DIRECT_DATABASE_URL", from), inTest(from) ? from : realEnvironment(from)) ?? url;
}

function notSetUp(name: string, path: string | null, url?: string): StoreRefused {
  return {
    because: "nothing chosen",
    refused:
      "nothing on this machine says which store it runs" +
      (path === null ? "" : `: ${path} names no database.store`) +
      (url === undefined ? "" : ", though it names a database.url — which store that URL is for was never written down") +
      ` — lingtai init asks and writes the choice. An exported ${name} also decides, and supplies the URL with it.`,
  };
}

/**
 * **Which store this machine runs is a value somebody wrote down**, and this is
 * the one function that reads it
 * ([0056](../../../doc/decisions/0056-the-store-is-a-written-choice.md)).
 *
 * Nothing infers it from a variable being unset. *Unset* is not a fact a
 * process can establish: the URL `postgresUrl()` reads has three sources, one
 * of them a `.env.local` found by walking up from this file, so `pnpm lingtai`
 * from the checkout and a launchd job started from `~` reach opposite answers
 * about whether anything is there, and neither can tell.
 * Four processes, four stores, and every append into the empty one reported as
 * success — which, for a system whose first rule is that the log settles it, is
 * the worst failure available.
 *
 * So there are **four answers and three of them are refusals**, returned as
 * data rather than thrown: `lingtai upgrade` and `lingtai uninstall` are the
 * commands that repair a broken install, and a half-written `config.yml` must
 * not be what stops them (#213).
 *
 * | `config.yml` | this says |
 * |---|---|
 * | no `database.store` | refused — this machine has not been set up, `lingtai init` |
 * | `store: sqlite` | SQLite, under `stateDir()` |
 * | `store: postgres` with a URL | Postgres |
 * | `store: postgres`, no URL anywhere | refused, saying where a URL is looked for |
 * | `store: sqlite` beside a `url` | refused, quoting both |
 *
 * An exported `LINGTAI_DATABASE_URL` wins and supplies the URL, which is what
 * makes CI, launchd and a container work with no file at all (0056 §3) — and it
 * is the *exported* one, never a checkout's `.env.local` (§4).
 *
 * **What opens the store it names is `chosenStore()` below** (#179): the three
 * factories — the log, the projections and the beacon — each ask that, and no
 * other file in the repository reads a variable or a file to decide.
 */
export function storeChoice(from: NodeJS.ProcessEnv = process.env): StoreChoice {
  // The test side for a test, as every other read here does — so a suite that
  // exists to assert Postgres can never be answered by the operator's machine.
  const name = dbVar("DATABASE_URL", from);
  // **`realEnvironment` is how 0056 §4 is kept**, and it is kept for the
  // machine's name only. The snapshot predates dotenv, so a checkout's
  // `.env.local` cannot decide, for a machine, which store that machine runs.
  //
  // **A test side is not a machine's.** `dbVar` has already moved to
  // `LINGTAI_TEST_DATABASE_URL`, which 0056 §4 names as a value `.env.local`
  // goes on supplying and `.env.example` documents there — so reading the
  // snapshot for it would refuse every suite whose URL is in the one file the
  // suite is told to put it in, while `postgresUrl()` beside it answered.
  // What 0046 forbids is a *fallback*, and there is none: with no test URL
  // anywhere this still refuses, by name.
  const url = optional(name, inTest(from) ? from : realEnvironment(from));
  if (url !== undefined) {
    // Said as it is: a machine's name was really exported, and a test's may
    // have come from the env files. A line somebody reads must not claim the
    // stronger of the two.
    const said = inTest(from) && optional(name, realEnvironment(from)) === undefined
      ? `${name}, in this process's environment`
      : `${name}, exported into this process`;
    return { store: "postgres", url, directUrl: sessionUrlFor(url, from), where: "environment", from: said };
  }

  const path = machineChoiceFile(from);
  if (path === null) return notSetUp(name, null);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // No file is no choice, and it is the same sentence: a machine that has not
    // been set up is not a machine that chose SQLite.
    return notSetUp(name, path);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    return {
      because: "unreadable",
      refused:
        `${path} could not be parsed as YAML, so which store this machine runs went unanswered: ` +
        `${(err as Error).message} — fix that file, or lingtai init writes it again`,
    };
  }
  const database =
    parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>)["database"] : undefined;
  const at = database !== null && typeof database === "object" ? (database as Record<string, unknown>) : {};
  const written = typeof at["url"] === "string" && at["url"] !== "" ? (at["url"] as string) : undefined;
  const store = at["store"];
  if (store === undefined || store === null || store === "") return notSetUp(name, path, written);
  if (store !== "postgres" && store !== "sqlite") {
    return {
      because: "nothing chosen",
      refused:
        `${path} sets database.store to ${JSON.stringify(store)}, which is neither postgres nor sqlite, so which ` +
        "store this machine runs went unanswered — lingtai init writes one of the two",
    };
  }
  if (store === "sqlite") {
    if (written !== undefined) {
      return {
        because: "two keys",
        refused:
          `${path} says database.store: sqlite and names database.url: ${redactUrl(written)} — two keys disagreeing ` +
          "about which store this machine runs, and neither is guessed at. lingtai init writes the one you choose and " +
          "removes the other",
      };
    }
    return { store: "sqlite", path: join(stateDir(from), SQLITE_LOG), where: "config.yml", from: path };
  }
  if (written === undefined) {
    return {
      because: "no url",
      refused:
        `${path} says database.store: postgres and names no database.url — a URL is looked for in ${name} exported ` +
        `into this process, then in database.url in that file, and nowhere else: a checkout's .env.local does not ` +
        "decide this (0056 §4). lingtai init asks for one and writes it",
    };
  }
  return {
    store: "postgres",
    url: written,
    directUrl: sessionUrlFor(written, from),
    where: "config.yml",
    from: `${path} database.url`,
  };
}

/**
 * The choice, or the refusal **thrown by name** — what a factory that is about
 * to open a store calls (#179).
 *
 * `storeChoice` is total because `lingtai upgrade`, `lingtai uninstall` and
 * `lingtai doctor` report on a machine rather than open it. This is the other
 * face, for the three factories that cannot carry on without an answer: the
 * log (`@lingtai/event-store`), the projections (`@lingtai/projector`) and the
 * beacon (`@lingtai/daemon`).
 *
 * **It throws where nothing was written, and never defaults.** A machine that
 * has not been set up is not a machine that chose SQLite
 * ([0056](../../../doc/decisions/0056-the-store-is-a-written-choice.md) §2),
 * and the refusal it throws names `lingtai init`. That is the whole of the
 * blocker that refused #179's ninth pass: under a rule that read *absence* as
 * *SQLite*, a process that could not see the checkout's `.env.local` opened a
 * second, empty log and reported every append into it as success.
 *
 * **At first use and not at import.** `eventStore` and `log` are deferred
 * (`@lingtai/event-store/choose`), so `lingtai version`, `upgrade`, `rollback`,
 * `uninstall` and `init` load the modules that reach a store and are refused by
 * nothing — the refusal arrives at the first append, read or beat, which is the
 * first moment a process needs the answer.
 */
export function chosenStore(from: NodeJS.ProcessEnv = process.env): StoreChosen {
  const choice = storeChoice(from);
  if ("refused" in choice) throw new Error(choice.refused);
  return choice;
}

/**
 * The choice as a line somebody reads — **derived from the choice, never
 * composed beside it**.
 *
 * `lingtai init` confirms what it wrote with this, and `lingtai doctor` reports
 * with it, so the screen at the end of setup and the answer a later command
 * gets cannot drift apart. They did: the last attempt printed *SQLite* from the
 * answer that was typed while the file still held a `database.url` that went on
 * selecting Postgres (#215).
 */
export function describeStore(choice: StoreChoice): string {
  if ("refused" in choice) return choice.refused;
  return choice.store === "postgres"
    ? `Postgres, ${redactUrl(choice.url)} ← ${choice.from}`
    : `SQLite, ${choice.path} ← ${choice.from}`;
}

/**
 * A URL fit to print: the password is never shown.
 *
 * Here because both sides of the choice quote URLs — `lingtai init`'s
 * confirmation, and the refusal that quotes a `database.url` beside a
 * `store: sqlite` — and a second copy of this is a second chance to print a
 * password.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "(a URL that does not parse)";
  }
}

/**
 * The board's port (#187). `17820`, and no configuration is required to get it.
 *
 * **Here rather than in `apps/board/package.json`**, which held it as
 * `next dev -p 3200` until now: somebody who installed Lingtai has no
 * `package.json` to edit, and the CLI, the service files and the URL in a
 * notification each need the same number. One constant, read by all of them.
 *
 * **Not higher.** macOS hands out `49152–65535` as ephemeral ports and Linux
 * `32768–60999`, so a default in either range is one the kernel also gives to
 * other processes — it would collide at random, intermittently, and mostly not
 * at all, which is harder to find than a fixed clash. `10000–32767` is the band.
 */
export const BOARD_PORT = 17820;

/**
 * Reserved, and **bound by nothing**.
 *
 * The daemon listens on no port at all: everything reaches it through the log
 * (0014, 0022), its hook socket is a unix socket path and its liveness beacon
 * is a file (#46). So there is one listener here, and `17821` is kept beside it
 * for the second one — the board's GitHub webhook receiver moving to the
 * daemon, if it ever does (doc/design/installing.md).
 *
 * It is reserved rather than bound because **a port with no use is a port the
 * next reader has to explain**, and the two ways that ends — inventing a
 * purpose for it, or deleting it — are both worse than a number written down.
 * `packages/env/test/board-port.test.ts` reads every package's `src` and fails
 * if any mention of the number **or of this name** is anything but prose — an
 * import of `RESERVED_PORT` included, since importing it is the only way to
 * bind the port without writing the digits.
 */
export const RESERVED_PORT = 17821;

/**
 * `board.port` in `~/.lingtai/config.yml`, or undefined where the file names
 * none — the same third source, and the same rules, as `machineDatabaseUrl`.
 *
 * The file need not exist. A value that is not a port number is refused by name
 * rather than ignored, which would serve the board on 17820 and say nothing
 * about the number somebody plainly wrote down.
 */
export function machineBoardPort(from: NodeJS.ProcessEnv = process.env): number | undefined {
  const path = join(stateDir(from), "config.yml");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw new Error(`${path} could not be parsed as YAML, so its board.port could not be read: ${(err as Error).message}`);
  }
  const board = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>)["board"] : undefined;
  const port = board !== null && typeof board === "object" ? (board as Record<string, unknown>)["port"] : undefined;
  if (port === undefined || port === null) return undefined;
  const n = typeof port === "number" ? port : Number(port);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    // Not "17820 is the default": nothing fell back to it, and a sentence that
    // named the default beside the refusal read as though the value had been
    // ignored and the board served on 17820 anyway.
    throw new Error(
      `${path} sets board.port to ${JSON.stringify(port)}, which is not a port number, so no port was read — ` +
        `take that line out to have the default, ${BOARD_PORT}`,
    );
  }
  return n;
}

/** The port the board is served on and linked to: the file's, else `BOARD_PORT`. */
export function boardPort(from: NodeJS.ProcessEnv = process.env): number {
  return machineBoardPort(from) ?? BOARD_PORT;
}

/** Where the board answers, for a link somebody clicks. Loopback: 0008 gave it no authentication. */
export function boardUrl(from: NodeJS.ProcessEnv = process.env): string {
  return `http://127.0.0.1:${boardPort(from)}`;
}

/**
 * **Whether a log is configured at all** — and never *is Postgres configured*,
 * which is the question next door (#213).
 *
 * `databaseUrl()` was read as this one three times in `apps/cli/src/entry.ts`,
 * written `try { databaseUrl() } catch { return false }`. While every log is
 * Postgres the two sentences have the same answer, so the conflation reads as
 * prose and not as a type error: the answer is a thrown exception caught by a
 * one-line `catch`, which goes on compiling and starts lying the day a log
 * needs no URL. #178 landed a store that is a file, so the two stopped having
 * to be the same claim — nothing chooses between them yet, and that is #179.
 *
 * So: a boolean, **read rather than caught**. The shape matters as much as the
 * name — a `try`/`catch` around a getter is what made this invisible for five
 * passes of #179. Where a log stops having to be Postgres, this body changes
 * and its callers do not: one place decides, and no caller decides again by
 * catching.
 *
 * It is still exactly what `postgresUrl()` reads, and **since #179 that is no
 * longer the same set of machines as *has a log*.** A machine that wrote
 * `store: sqlite` runs one, in a file, and this answers false about it; so does
 * a machine that carries a `database.url` and no `database.store`, which 0056
 * calls not set up and must not collapse into *chose SQLite* (0016 §4).
 *
 * That is left standing deliberately and it is not this function's decision to
 * make. Its three callers are `lingtai uninstall`, `lingtai upgrade` and the
 * drain beneath both (`apps/cli/src/world.ts`), and what they do with a
 * file-backed log — whether `~/.lingtai` holding the log changes what an
 * uninstall may remove, and what it must say first — is a question about those
 * commands, which [#214](https://github.com/steven-zhc/lingtai/issues/214)
 * opens and #179 deliberately does not answer. Until then this reads as it
 * always has: *is Postgres configured*, which on every machine that exists
 * today is also *is there a log*.
 *
 * **Total.** It answers on every machine, including one whose `config.yml` was
 * truncated mid-write: `false`, because nothing here names a log, while
 * `postgresUrl()` refuses by that file's path and `lingtai doctor` fails the
 * environment row on it. A boolean that can throw would be the `catch` back in
 * a different shape, and it would land on the two commands — `upgrade` and
 * `uninstall` — that exist to repair a broken install.
 */
export function logConfigured(from: NodeJS.ProcessEnv = process.env): boolean {
  return postgresUrlIfSet(from) !== undefined;
}

/**
 * The pooled Postgres URL where one is configured; undefined where none is.
 *
 * Reads, and never refuses — **including a `~/.lingtai/config.yml` it cannot
 * parse**, which is undefined here and a refusal in `postgresUrl()`. `lingtai
 * doctor` wants this face too: it reports on an environment rather than
 * demanding one, and reports the unreadable file as its own failing row.
 *
 * `postgresUrl()` is this plus the refusal and `logConfigured()` is this plus
 * `!== undefined`, so *is there one* and *what is it* are one read and cannot
 * drift apart: wherever this is undefined, `postgresUrl()` refuses.
 */
export function postgresUrlIfSet(from: NodeJS.ProcessEnv = process.env): string | undefined {
  return optional(dbVar("DATABASE_URL", from), from) ?? machineUrlIfReadable(from);
}

/**
 * Pooled. Ordinary reads and writes, **against Postgres** — which is not the
 * same claim as *the log*, however long the two have coincided. A caller that
 * opens a `pg` connection wants this one; a caller deciding whether anything is
 * configured wants `logConfigured()`.
 */
export function postgresUrl(from: NodeJS.ProcessEnv = process.env): string {
  return (
    postgresUrlIfSet(from) ??
    // `machineUrl` again, and not for the value: the reader above is silent
    // about a `config.yml` it could not parse, and this caller is about to
    // connect — so the file is named here (#186) rather than reported as *not
    // set* on a machine where somebody plainly set one.
    machineUrl(from) ??
    (inTest(from) ? testUrl("DATABASE_URL", from) : required(`${PREFIX}DATABASE_URL`, from))
  );
}

/**
 * Session mode, against the same database.
 *
 * Migrations and `LISTEN/NOTIFY` both need a connection that is not handed to
 * someone else between statements. No lock does: every lock is a file
 * (`./lock.ts`, 0052). Through a
 * transaction pooler each of those fails **silently** — a cross-connection
 * NOTIFY simply never arrives, which would leave the system looking merely slow
 * rather than broken. Measured against Supabase's pooler on 2026-08-31; see
 * doc/decisions/0009-two-connections.md.
 *
 * On a plain Postgres this may be the same string as `postgresUrl()`, and then
 * it need not be written at all: see `directUrlIfSet`. Neither set still
 * refuses, by the direct name.
 *
 * **It is about pooling and never about whether a log exists** (#213), which is
 * why the separation next door leaves its meaning exactly as it was and changes
 * only the word that said *database* where it meant *Postgres*. Nothing asks
 * this one whether anything is configured; `logConfigured()` is that question.
 */
export function directPostgresUrl(from: NodeJS.ProcessEnv = process.env): string {
  return (
    directUrlIfSet(from) ??
    // As `postgresUrl`: the reader is silent about a `config.yml` it could not
    // parse, and a caller that is about to connect is told which file it is.
    machineUrl(from) ??
    (inTest(from) ? testUrl("DIRECT_DATABASE_URL", from) : required(`${PREFIX}DIRECT_DATABASE_URL`, from))
  );
}

/**
 * The direct URL, or the pooled one standing in for it when the direct one is
 * absent (#176). Undefined when neither is set.
 *
 * Two URLs are Supabase's artifact rather than the architecture's — 0009: "On a
 * plain Postgres the two may be identical" — so a plain install writes one.
 * The fallback **only fills a gap**: a set direct URL always wins, because on
 * Supabase the two genuinely differ, and the pooled one there is exactly the
 * connection that breaks `LISTEN/NOTIFY` silently. `lingtai doctor`'s session
 * mode check is what catches a pooled URL standing in where it cannot.
 *
 * **The `TEST_` pair falls back the same way, and only within itself.** What
 * `testUrl` refuses is the operator's log; `LINGTAI_TEST_DATABASE_URL` standing
 * in for `LINGTAI_TEST_DIRECT_DATABASE_URL` is still the test database, so the
 * fallback cannot cross that line — `dbVar` picks both names from the same side.
 * `test-support/teardown.ts` already read the pair this way.
 *
 * Exported for the callers that must work with nothing configured (Prisma's
 * config, the bootstrap script), which read rather than demand.
 */
export function directUrlIfSet(from: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    optional(dbVar("DIRECT_DATABASE_URL", from), from) ??
    optional(dbVar("DATABASE_URL", from), from) ??
    // Total, as `postgresUrlIfSet` is: `lingtai doctor` reads this one to
    // report on an environment, and must not be the command a broken
    // `config.yml` stops.
    machineUrlIfReadable(from)
  );
}

/** Set, or undefined. For values whose absence is a legitimate state. */
export function optional(name: string, from: NodeJS.ProcessEnv = process.env): string | undefined {
  return from[name] || undefined;
}

/**
 * The GitHub App's credentials.
 *
 * An App rather than a personal access token, because a fine-grained PAT can be
 * wrong in a way nothing reports: on 2026-08-30 one covered the admin
 * repository's submodule but not the repository itself, and every CI run failed
 * with a 403 that said nothing about scope. An installation makes reachability
 * explicit. See doc/decisions/0006-github-app.md.
 *
 * The private key is a real secret. It is read from a file by default so it
 * never has to be pasted into a shell, and it never appears in any log — a
 * caller that needs to show configuration shows `keySource`, not the key.
 */
export interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
  /** Where the key came from, for diagnostics. Never the key itself. */
  keySource: string;
}

/**
 * A path from configuration, made absolute.
 *
 * `~` is expanded, because a config file is exactly where someone writes it and
 * nothing else expands it there: a shell does not touch a `.env` file, dotenv
 * reads the value literally, and `path.resolve` would produce a directory
 * *named* `~` inside the repository. The README documented `~/...` before this
 * existed, which would have failed with a bare ENOENT naming a path nobody
 * wrote.
 *
 * A relative path is relative to the repository root, not to whichever directory
 * a command happened to start in — the same rule the environment file itself
 * follows.
 */
/**
 * Where Lingtai keeps what it owns on this machine — clones, worktrees, the
 * per-project env files, the hook sockets.
 *
 * Here rather than beside the worktrees because it is not about worktrees: it
 * is a fact about the machine, which is what this package is for, and three
 * packages need it without needing each other. There were two copies before
 * (`conductor/worktree.ts` and `daemon/reconcile.ts`), differing in how they
 * fell back when `HOME` was unset.
 */
export function stateDir(from: NodeJS.ProcessEnv = process.env): string {
  return from["LINGTAI_HOME"] ?? join(from["HOME"] ?? homedir(), ".lingtai");
}

export function resolvePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(root, path);
}

/**
 * The checkout Lingtai is running from — where `.env.local`, `prompts/` and the
 * hook binary live.
 *
 * Already the anchor `resolvePath` and the dotenv load above use; exported
 * because it is now read by something other than a command. `#104` shows the
 * next attempt's prompt on the board before it is sent, and the template is
 * `prompts/ticket.md` at this root — the same file `conduct.ts` reads to run
 * one. Two ways of finding it would be two prompts the moment either moved.
 *
 * **Not the managed project's checkout.** That is a clone under `stateDir()`,
 * and a mirror of it under `repos/`; this is Lingtai's own source, which 0010
 * runs unbuilt.
 */
export function repoRoot(): string {
  return root;
}

/**
 * The env files `@lingtai/env` loads, in its order — first to name a value wins.
 *
 * The same two paths as the `config()` call at the top of this file, which reads
 * them once. `appValues` reads them again on every call, for the App's names
 * below and no others.
 */
export function envFiles(): string[] {
  return [resolve(root, ".env.local"), resolve(root, ".env")];
}

/**
 * The App's names, from the environment or else the files as they are **now**
 * (#169) — and **every name from the source that names the App ID**.
 *
 * The private key was always re-read per call — `readFileSync` is inside
 * `githubApp` — while the App ID came from `process.env`, which Next.js and
 * dotenv both fill once, at start. So an App created at runtime by the board's
 * setup page worked by half: the key landed and every process, the board that
 * wrote it included, went on answering *no GitHub App configured*. Reading the
 * id the way the key is read closes that, in every process, with nothing to
 * restart.
 *
 * **One source per App, not one per name.** The id and the key are a pair, and
 * a `.env.local` copied from `.env.example` ships the key path filled in with
 * the id blank — so `process.env` holds a key path from start while the id is
 * only ever in the file. Asked name by name, the id came from the file and the
 * key path from that stale snapshot: the setup page writes a key aside because
 * one is already at the default path, points the file at it, and every call
 * signs the new App's JWT with the old App's key. So the source that names the
 * id is asked first for every other name, and the rest only for what it does
 * not say.
 *
 * `process.env` keeps winning where it names the id, so a deployment that
 * supplies the variables directly is unaffected. A file that cannot be read
 * says nothing.
 */
function appValues(from: NodeJS.ProcessEnv, files: readonly string[]): (name: string) => string | undefined {
  const sources: ((name: string) => string | undefined)[] = [(name) => optional(name, from)];
  for (const file of files) {
    let parsed: Record<string, string>;
    try {
      parsed = parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    sources.push((name) => parsed[name] || undefined);
  }
  const owner = sources.find((source) => source(`${PREFIX}GITHUB_APP_ID`) !== undefined);
  const ordered = owner === undefined ? sources : [owner, ...sources.filter((s) => s !== owner)];
  return (name) => {
    for (const source of ordered) {
      const value = source(name);
      if (value) return value;
    }
    return undefined;
  };
}

/**
 * The secret `/api/webhook` verifies deliveries with, read the way the App is.
 *
 * The setup page writes it into `.env.local` beside the id, while the board is
 * running — so a receiver reading `process.env` alone answered every delivery
 * of an App created with an active hook *webhooks are not configured* until
 * somebody restarted the board, under a screen saying nothing had to be.
 */
export function githubWebhookSecret(
  from: NodeJS.ProcessEnv = process.env,
  files: readonly string[] = from === process.env ? envFiles() : [],
): string | undefined {
  return appValues(from, files)(`${PREFIX}GITHUB_WEBHOOK_SECRET`);
}

/**
 * `from` exists so that a caller which was *handed* an environment reports on
 * that one. `lingtai doctor` takes an environment as an argument and is supposed to
 * be a function of it; reading past it to `process.env` made its report partly
 * about the argument and partly about the machine, which showed up the moment
 * the operator configured a real App and a test asserting "not configured"
 * started failing for a reason that had nothing to do with the code.
 *
 * `files` follows the same rule: the env files on disk are consulted only when
 * the environment is this process's own, since they are what that environment
 * was loaded from. A caller handing in another environment gets no files unless
 * it names them.
 */
export function githubApp(
  from: NodeJS.ProcessEnv = process.env,
  files: readonly string[] = from === process.env ? envFiles() : [],
): GitHubAppCredentials {
  const value = appValues(from, files);
  const appId = value(`${PREFIX}GITHUB_APP_ID`);
  if (!appId) {
    throw new Error(
      `${PREFIX}GITHUB_APP_ID is not set. ` +
        (renamedFrom(`${PREFIX}GITHUB_APP_ID`, from)
          ? `GITHUB_APP_ID is set — it was renamed (#63). Rename the line.`
          : "Copy .env.example to .env.local at the repo root and fill it in."),
    );
  }
  const path = value(`${PREFIX}GITHUB_APP_PRIVATE_KEY_PATH`);
  const inline = value(`${PREFIX}GITHUB_APP_PRIVATE_KEY`);

  if (path) {
    return { appId, privateKey: readFileSync(resolvePath(path), "utf8"), keySource: path };
  }
  if (inline) {
    // Some hosts can only carry the key as one line; \n restores the PEM.
    return { appId, privateKey: inline.replace(/\\n/g, "\n"), keySource: `${PREFIX}GITHUB_APP_PRIVATE_KEY` };
  }
  throw new Error(
    `Neither ${PREFIX}GITHUB_APP_PRIVATE_KEY_PATH nor ${PREFIX}GITHUB_APP_PRIVATE_KEY is set. ` +
      "See doc/decisions/0006-github-app.md for creating the App.",
  );
}

/**
 * Whether the App is configured at all, without throwing to find out — asked of
 * the environment and then of the env files as they are now, like `githubApp`.
 */
export function hasGitHubApp(
  from: NodeJS.ProcessEnv = process.env,
  files: readonly string[] = from === process.env ? envFiles() : [],
): boolean {
  const value = appValues(from, files);
  return Boolean(
    value(`${PREFIX}GITHUB_APP_ID`) &&
      (value(`${PREFIX}GITHUB_APP_PRIVATE_KEY_PATH`) || value(`${PREFIX}GITHUB_APP_PRIVATE_KEY`)),
  );
}
