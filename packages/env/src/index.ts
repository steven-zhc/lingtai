import { config, parse } from "dotenv";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
 */
const here = dirname(fileURLToPath(import.meta.url));
/** `packages/env/src` → the repository root. */
const root = resolve(here, "../../..");

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
function inTest(): boolean {
  return Boolean(process.env["VITEST"] || process.env["LINGTAI_TEST"]);
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
export function dbVar(name: "DATABASE_URL" | "DIRECT_DATABASE_URL"): string {
  return inTest() ? `${PREFIX}TEST_${name}` : `${PREFIX}${name}`;
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

function testUrl(name: string): string {
  const full = `${PREFIX}TEST_${name}`;
  const value = optional(full);
  if (!value) {
    const was = renamedFrom(full, process.env);
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

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    const was = renamedFrom(name, process.env);
    throw new Error(
      `${name} is not set. ` +
        (was
          ? `${was} is set — it was renamed to ${name} (#63), so that a project's own ` +
            `${was} can never be confused with Lingtai's. Rename the line.`
          : "Copy .env.example to .env.local at the repo root and fill it in."),
    );
  }
  return v;
}

/** Pooled. Ordinary reads and writes. */
export function databaseUrl(): string {
  return inTest() ? testUrl("DATABASE_URL") : required(`${PREFIX}DATABASE_URL`);
}

/**
 * Session mode, against the same database.
 *
 * Migrations, `LISTEN/NOTIFY` and session-level advisory locks all need a
 * connection that is not handed to someone else between statements. Through a
 * transaction pooler each of those fails **silently** — a cross-connection
 * NOTIFY simply never arrives, which would leave the system looking merely slow
 * rather than broken. Measured against Supabase's pooler on 2026-08-31; see
 * doc/decisions/0009-two-connections.md.
 *
 * On a plain Postgres this may be the same string as `databaseUrl()`.
 */
export function directDatabaseUrl(): string {
  return inTest() ? testUrl("DIRECT_DATABASE_URL") : required(`${PREFIX}DIRECT_DATABASE_URL`);
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
