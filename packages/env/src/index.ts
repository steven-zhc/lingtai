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
 * (#186). `databaseUrl` and `directUrlIfSet` fall back to it when neither the
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
 * Exported because two callers cannot go through `databaseUrl()`: Prisma's
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
 * here. And **never for a test** — `databaseUrl` and `directUrlIfSet` do not ask
 * this while `inTest`, because a file on the operator's machine is exactly the
 * operator's log, and `testUrl` exists to refuse that.
 *
 * One URL, not two: 1.0's store has no pooled/direct split (doc/design/1.0.md),
 * so this stands in for both names. A file that does not parse is refused by
 * name rather than read as no URL, which would say *not set* about a machine
 * where somebody plainly set one.
 */
export function machineDatabaseUrl(from: NodeJS.ProcessEnv = process.env): string | undefined {
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
    throw new Error(`${path} could not be parsed as YAML, so its database.url could not be read: ${(err as Error).message}`);
  }
  const database = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>)["database"] : undefined;
  const url = database !== null && typeof database === "object" ? (database as Record<string, unknown>)["url"] : undefined;
  return typeof url === "string" && url !== "" ? url : undefined;
}

/** The machine file's URL, asked only of this process's own environment and never in a test. */
function machineUrl(from: NodeJS.ProcessEnv): string | undefined {
  return from === process.env && !inTest(from) ? machineDatabaseUrl(from) : undefined;
}

/**
 * Where the log goes when nothing named a Postgres URL — `~/.lingtai/lingtai.db`,
 * as doc/design/1.0.md's "Where things live" has it.
 *
 * Under `stateDir`, so `LINGTAI_HOME` moves it with everything else Lingtai owns
 * on this machine. A second answer to *where does Lingtai keep its own files*
 * is a second answer that can drift.
 */
export function sqliteLogPath(from: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(from), "lingtai.db");
}

/** Which store this machine's log is, and where it is. */
export type StoreChoice =
  | { readonly kind: "postgres"; readonly url: string }
  | { readonly kind: "sqlite"; readonly path: string };

/**
 * **Absence is the choice** (#179).
 *
 * A Postgres URL — the variable, an env file, or `database.url` in
 * `~/.lingtai/config.yml` — selects Postgres. Nothing at all selects SQLite in
 * `~/.lingtai/`. No flag and no prompt, and therefore no second setting that
 * could fall out of step with the first: the same shape as `merge: []` meaning
 * nothing holds, where the configuration **is** the decision rather than a
 * thing consulted alongside one.
 *
 * **It chooses for the application. It chooses nothing for the tests.** Under
 * `inTest` this asks `testUrl`, which refuses when `LINGTAI_TEST_DATABASE_URL`
 * is unset and must never fall through to SQLite: that fallback would let
 * `pnpm test:db` pass against a file while claiming to assert Postgres, and
 * asserting Postgres is the whole subject of that half of the suite (`#158`) —
 * the projections, `LISTEN`/`NOTIFY`, two clients racing. The refusal is pinned
 * by `test/env.test.ts`, and its reason is written out at `testUrl`.
 *
 * Read by `@lingtai/event-store`'s singleton, which is what makes it the
 * choice and not a description of one, and by `lingtai doctor`, which prints
 * it: *which database am I on* stopped being answerable by looking for a
 * variable the moment an absent one started meaning something.
 */
export function storeChoice(from: NodeJS.ProcessEnv = process.env): StoreChoice {
  if (inTest(from)) return { kind: "postgres", url: testUrl("DATABASE_URL", from) };
  const url = optional(`${PREFIX}DATABASE_URL`, from) ?? machineUrl(from);
  if (url !== undefined) return { kind: "postgres", url };
  // **Absence is nothing at all naming a connection.** A machine with only
  // `LINGTAI_DIRECT_DATABASE_URL` set is a Postgres machine missing a line, not
  // a machine that chose SQLite — and choosing SQLite there would start an empty
  // log beside a database somebody plainly configured. It refuses by name, as
  // it did before any of this existed.
  //
  // **And the same of the pre-#63 name.** `DATABASE_URL` is what this variable
  // was called, so a machine that has one and no `LINGTAI_DATABASE_URL` is
  // either an install that predates the rename or the mistake `renamedFrom`
  // exists for — every provider's dashboard calls the variable `DATABASE_URL`.
  // Either way somebody plainly named a connection, and reporting *nothing
  // names one, so this machine chose SQLite* is a deliberate choice they did not
  // make, with the one-word fix nowhere on the screen. `required` is what says
  // it, and saying it is the only reason this branch is here: `databaseUrl()`
  // ran it as its last step before #179 and that is the line this restores.
  if (optional(`${PREFIX}DIRECT_DATABASE_URL`, from) || renamedFrom(`${PREFIX}DATABASE_URL`, from)) {
    return { kind: "postgres", url: required(`${PREFIX}DATABASE_URL`, from) };
  }
  return { kind: "sqlite", path: sqliteLogPath(from) };
}

/**
 * The pre-#63 name, where it is set and the prefixed one is not — otherwise
 * null, which is every ordinary machine.
 *
 * Exported for `lingtai doctor`, which decides which store is in use without
 * going through `storeChoice` — it has a `~/.lingtai/config.yml` URL of its own
 * to fold in, and a synthetic environment that `machineUrl` deliberately will
 * not read. Asking this rather than reading `DATABASE_URL` there keeps *which
 * name this one was renamed from* written once: a report that answered that
 * question differently from the refusal is the report saying `sqlite` about a
 * machine every command refuses.
 */
export function renamedDatabaseUrl(from: NodeJS.ProcessEnv = process.env): string | null {
  return optional(`${PREFIX}DATABASE_URL`, from) ? null : renamedFrom(`${PREFIX}DATABASE_URL`, from);
}

/**
 * Pooled. Ordinary reads and writes — **and Postgres, demanded**.
 *
 * Through `storeChoice`, so which sources are read and in what order cannot
 * differ from the choice itself. It still refuses by name where nothing names
 * a URL, and that refusal is now a fact about the caller rather than about the
 * machine: what is left reading this is the code that can only be Postgres —
 * the projections, the `LISTEN`/`NOTIFY` waker, the daemon's own reconcile and
 * converge queries, `lingtai doctor`'s catalogue reads — so on a SQLite machine
 * it is asking for something that is not there, and saying so by name is right.
 * A caller that wants whichever store this machine has asks `storeChoice`, and
 * one that wants to know **whether there is a log at all** asks it too: since
 * absence names a store, "no URL" and "no log" stopped being the same fact, and
 * reading this for the second question is how `lingtai uninstall` came to tell a
 * SQLite machine it had no log while listing that log among what it would
 * remove.
 */
export function databaseUrl(from: NodeJS.ProcessEnv = process.env): string {
  const chosen = storeChoice(from);
  return chosen.kind === "postgres" ? chosen.url : required(`${PREFIX}DATABASE_URL`, from);
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
 * On a plain Postgres this may be the same string as `databaseUrl()`, and then
 * it need not be written at all: see `directUrlIfSet`. Neither set still
 * refuses, by the direct name.
 */
export function directDatabaseUrl(from: NodeJS.ProcessEnv = process.env): string {
  return (
    directUrlIfSet(from) ??
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
    machineUrl(from)
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
