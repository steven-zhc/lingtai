/**
 * `lingtai init`: from a machine with a binary and nothing else to the board,
 * on the wizard (#186, [doc/design/1.0.md](../../../doc/design/1.0.md) *The
 * first run*).
 *
 *   look       git, which runtimes are installed and signed in, what ~/.lingtai holds
 *   store      postgres or sqlite, written down — a URL connected to, its tables created
 *   agent      detected; more than one signed in is asked; none is refused by name
 *   App        one already configured is verified by a real call
 *   board      started here, and a browser opened on the wizard's first screen
 *
 * **Resuming is not a mode.** Each choice is written to `~/.lingtai/config.yml`
 * the moment it is made and verified, and every run begins by reading what is
 * already there — so an interrupted init continues where it stopped, and a
 * finished one reports and changes nothing, by the same code path. There is no
 * progress file to disagree with the configuration it describes.
 *
 * **Nothing is written before its choice.** The URL is written after the
 * connection answered and the tables exist, the agent after it was chosen, and
 * the App's key by the board's own page (`@lingtai/conductor/create-app`), which
 * is GitHub's manifest flow: the one step here that is a person on somebody
 * else's page.
 *
 * **A failure returns to the choice.** A URL that does not connect, or an agent
 * named in the file that is no longer signed in, asks again — never selects the
 * other thing silently, which is how a machine signed in to two runtimes ends
 * up running the one nobody picked.
 *
 * **The store is written, never inferred** (0056, #215). `database.store` is
 * `postgres` or `sqlite` and it is this command that puts it there: an empty
 * answer is the SQLite choice, and taking it *removes* `database.url` rather
 * than reporting one store while leaving the other's value behind. What is
 * confirmed at the end is `storeChoice()`'s reading of the file just written —
 * the same function a later command asks — so the screen and the machine cannot
 * disagree.
 *
 * **Either store finishes setup**, since #179: a written `sqlite` opens a log,
 * a projection and a beacon, so the run goes on to the agent, the App and the
 * board exactly as a Postgres one does. What is said about such a machine is
 * `SQLITE_MACHINE`, in one place.
 *
 * **Changing a store that answers is an edit, not a re-run** — 0056 left that
 * open and this settles it. A store already written and connecting is reported
 * and not asked about again, exactly as the agent is: re-asking would make
 * every run of a finished `init` a chance to answer the wrong way. To switch,
 * set `database.store` in `~/.lingtai/config.yml` and run `lingtai init`, which
 * finds the half-state that edit leaves — `store: sqlite` beside the old
 * `url` — refuses it by name, and completes the switch by asking. 0055 §3 is
 * still the thing to know before doing it: the other store is a new log, not
 * the same one somewhere else.
 *
 * **Subscriptions are not Lingtai's business.** Whether a runtime can run is
 * asked of the runtime; whether it is paid for is not asked at all.
 *
 * Like `install.ts`, none of this needs the log to exist — `entry.ts` answers
 * `init` before `lingtai.ts` loads `@lingtai/event-store` — and everything
 * outside this file is reached through `InitWorld`, so a test drives every step
 * and every interruption with no database, network or browser.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { Document, isMap, parseDocument } from "yaml";
import { claudeCodeAuth, codexAuth } from "@lingtai/agent/auth";
import { runnableEnv } from "@lingtai/agent-env";
import {
  SQLITE_MACHINE,
  type StoreChosen,
  boardPort,
  describeStore,
  redactUrl,
  stateDir,
  storeChoice,
} from "@lingtai/env";
import { createFileLocker, type HeldLock } from "@lingtai/env/lock";
import { paint } from "@lingtai/env/colour";
import { type SchemaOutcome, createSchema } from "@lingtai/event-store/schema";
import { boardLock, builtBoardDir, serveBoard } from "./board.ts";

// -------------------------------------------------------------- the world --

export const RUNTIMES = ["claude-code", "codex"] as const;
export type RuntimeName = (typeof RUNTIMES)[number];

export interface RuntimeFound {
  id: RuntimeName;
  installed: boolean;
  signedIn: boolean;
  /** What the runtime said, verbatim. */
  detail: string;
}

export type DatabaseCheck = { ok: true; schema: SchemaOutcome } | { ok: false; why: string };

export type AppCheck =
  | { configured: false }
  | { configured: true; ok: true; slug: string; owner: string }
  | { configured: true; ok: false; why: string };

export interface InitWorld {
  /**
   * The environment every choice is read against — `storeChoice()`'s argument,
   * so a test drives the real reader by handing it a `LINGTAI_HOME` of its own
   * and, where it means the exported variable, a `LINGTAI_DATABASE_URL`.
   */
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** One line from the person. Null when nobody is at a terminal to answer. */
  ask: (question: string) => Promise<string | null>;
  /** `git --version`, or null when there is no git. */
  git: () => Promise<string | null>;
  /** Every runtime, asked whether it is installed and signed in. */
  runtimes: () => Promise<RuntimeFound[]>;
  /** Connect, and create the tables where there are none. */
  database: (url: string) => Promise<DatabaseCheck>;
  /** The App this machine is configured with, asked with a real call. */
  app: () => Promise<AppCheck>;
  /** Resolves once an App is configured and answers — written by the board's first screen. */
  appeared: () => Promise<{ slug: string; owner: string }>;
  /**
   * A Lingtai board already answering on this port — the machine's own, from
   * `lingtai board` or the service — as its URL, or null. Asked before one is
   * started, since a second on the same port is refused.
   */
  boardAt: (port: number) => Promise<string | null>;
  /** Serve the board; the process stays up for it. */
  board: (port: number) => Promise<{ url: string } | { refused: string }>;
  /** Open a browser. False when none could be. */
  open: (url: string) => Promise<boolean>;
}

const USAGE = "lingtai init [--database-url <postgres url>] [--agent claude-code|codex] [--port <n>]";

// ---------------------------------------------------------- config.yml --

export function configPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "config.yml");
}

/** The machine file as a document, so a write keeps every comment and key it did not choose. */
function readConfig(path: string): Document | { refused: string } {
  if (!existsSync(path)) return new Document({});
  const doc = parseDocument(readFileSync(path, "utf8"));
  if (doc.errors.length > 0) {
    return { refused: `${path} does not parse as YAML (${doc.errors[0]!.message}) — fix it and run lingtai init again` };
  }
  if (doc.contents === null) return new Document({});
  if (!isMap(doc.contents)) return { refused: `${path} is not a mapping — fix it and run lingtai init again` };
  return doc;
}

/**
 * Beside, then renamed over: an interruption mid-write leaves the old file or
 * the new one, never half of either. `0600`, because a database URL carries its
 * password.
 */
function writeConfig(path: string, doc: Document, home: string): void {
  mkdirSync(home, { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  writeFileSync(partial, doc.toString(), { mode: 0o600 });
  chmodSync(partial, 0o600);
  renameSync(partial, path);
}

/**
 * A URL fit to print: the password is never shown.
 *
 * `@lingtai/env`'s, because the store's own refusals quote a `database.url`
 * too — one redaction, so there is one place a password could escape from.
 */
export { redactUrl as redact } from "@lingtai/env";

// ------------------------------------------------------------ the command --

function parseArgs(argv: readonly string[]): { flags: Record<string, string> } | { refused: string } {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]!;
    if (!["--database-url", "--agent", "--port"].includes(name)) return { refused: `${USAGE} — no ${name}` };
    const value = argv[i + 1];
    if (value === undefined) return { refused: `${USAGE} — ${name} takes a value` };
    flags[name.slice(2)] = value;
    i++;
  }
  return { flags };
}

function refuse(world: Pick<InitWorld, "log">, line: string, code = 1): number {
  world.log(paint.fail(line));
  return code;
}

export async function initCommand(argv: readonly string[], world: InitWorld): Promise<number> {
  const parsed = parseArgs(argv);
  if ("refused" in parsed) return refuse(world, parsed.refused, 2);
  const { flags } = parsed;
  const asked = flags["port"] === undefined ? null : Number(flags["port"]);
  if (asked !== null && (!Number.isInteger(asked) || asked <= 0)) return refuse(world, `${USAGE} — --port takes a port number`, 2);

  const home = stateDir(world.env);
  const path = configPath(world.env);

  // ---- look -----------------------------------------------------------------
  world.log(paint.accent("looking before asking"));
  const git = await world.git();
  world.log(git ? `  git          ${git}` : paint.fail("  git          not on PATH"));
  const runtimes = await world.runtimes();
  for (const r of runtimes) {
    const state = !r.installed ? "not installed" : r.signedIn ? r.detail : `installed, not signed in — ${r.detail}`;
    world.log(`  ${r.id.padEnd(12)} ${state}`);
  }
  world.log(`  ${"home".padEnd(12)} ${home} — ${describeHome(home, path)}`);
  if (!git) {
    return refuse(world, "git is not on PATH — the mirror and the worktrees are git. Install it and run lingtai init again; nothing was written");
  }

  const config = readConfig(path);
  if ("refused" in config) return refuse(world, config.refused);

  // ---- the store ------------------------------------------------------------
  const store = await chooseStore(world, config, path, home, flags["database-url"] ?? null);
  if (store !== null) return store;

  // ---- the agent ------------------------------------------------------------
  const agent = await chooseAgent(world, config, path, home, runtimes, flags["agent"] ?? null);
  if (agent !== null) return agent;

  // ---- the App --------------------------------------------------------------
  const app = await world.app();
  if (app.configured && !app.ok) {
    return refuse(
      world,
      `the GitHub App configured here does not answer — ${app.why}. A second App is not created beside it: ` +
        "fix its credentials, or remove them, and run lingtai init again",
    );
  }
  world.log(
    app.configured
      ? paint.pass(`app          ${app.slug}, owned by ${app.owner} — it answered`)
      : "app          none yet — the board's first screen creates it through GitHub's manifest flow",
  );

  // ---- the board, on the wizard ---------------------------------------------
  // The port is decided here and not at the top: `board.port` is read out of
  // the same file `readConfig` above refuses by name, and a file that does not
  // parse should say so once, in its own words, rather than through the port.
  const port = asked ?? boardPort(world.env);
  // A board already up is this machine's, and the wizard is on it: a re-run uses it rather than failing on its port.
  const running = await world.boardAt(port);
  const board = running !== null ? { url: running } : await world.board(port);
  if ("refused" in board) {
    return refuse(world, `the board did not start — ${board.refused}. Everything chosen above is kept, and lingtai init again continues from here`);
  }
  const wizard = `${board.url}${app.configured ? "/setup/repository" : "/setup/github-app"}`;
  world.log(
    (await world.open(wizard))
      ? paint.pass(`opened ${wizard}`)
      : paint.signal(`no browser could be opened here — open ${wizard}`),
  );
  if (!app.configured) {
    world.log(paint.signal("waiting for the App — press Create on that page, and GitHub brings you back"));
    const made = await world.appeared();
    world.log(paint.pass(`app          ${made.slug}, owned by ${made.owner} — it answered`));
    world.log(`next, install it and pick a repository: ${board.url}/setup/repository`);
  }
  world.log(
    running !== null
      ? paint.muted(`the board was already running at ${running} — this started none`)
      : paint.muted("the board keeps running in this terminal — ctrl-c stops it, and lingtai board starts it again"),
  );
  return 0;
}

function describeHome(home: string, path: string): string {
  if (!existsSync(home)) return "nothing yet";
  const said: string[] = [existsSync(path) ? "config.yml" : "no config.yml"];
  try {
    const entries = readdirSync(home, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    const projects = entries.filter((name) => existsSync(join(home, name, "recipe.yml")));
    said.push(projects.length > 0 ? `projects: ${projects.join(", ")}` : "no projects");
    if (entries.includes("versions")) {
      const versions = readdirSync(join(home, "versions")).filter((v) => !v.startsWith("."));
      said.push(`versions: ${versions.join(", ") || "none"}`);
    }
  } catch {
    // An unreadable home says only what the file check could.
  }
  return said.join(" · ");
}

function describeSchema(schema: SchemaOutcome): string {
  if (schema.created) return `tables created (${schema.applied.length} steps)`;
  return schema.repaired.length > 0 ? `tables present; put back ${schema.repaired.join(", ")}` : "tables present";
}

/**
 * Null once the store is settled; an exit code when it cannot be.
 *
 * **Choosing is an edit** (0056, #215): each answer is written as `store` and a
 * `url` that agrees with it, and the other store's value is taken out in the
 * same write. Then the file is read back with `storeChoice()` — the function a
 * later command asks — and *that* is what is printed, so the line at the end of
 * setup is a reading of the machine rather than a report of what was typed.
 */
async function chooseStore(
  world: InitWorld,
  config: Document,
  path: string,
  home: string,
  flag: string | null,
): Promise<number | null> {
  // An exported LINGTAI_DATABASE_URL decides and supplies the URL (0056 §3),
  // and nothing is written for it: it is the process's answer, not the file's,
  // and this command does not own the process a daemon will be started in.
  const preset = storeChoice(world.env);
  if (!("refused" in preset) && preset.where === "environment" && preset.store === "postgres") {
    const check = await world.database(preset.url);
    if (!check.ok) {
      return refuse(
        world,
        `the database ${preset.from} names, ${redactUrl(preset.url)}, does not answer — ${check.why}. ` +
          "It is not this command's to replace: fix it, or remove it, and run lingtai init again",
      );
    }
    world.log(paint.pass(`store        ${describeStore(preset)} · ${describeSchema(check.schema)}`));
    return null;
  }

  let candidate = flag;
  // The inherited URL below is tried **once**. Taking it again on the next pass
  // would be a loop that never reaches the question, since what makes it
  // inheritable — a `url` with no `store` — is still true after it failed.
  let inherited = false;
  for (;;) {
    if (candidate === null) {
      const settled = storeChoice(world.env);
      if (!("refused" in settled)) {
        if (settled.store === "sqlite") return sqliteChosen(world, settled);
        const check = await world.database(settled.url);
        if (check.ok) {
          world.log(paint.pass(`store        ${describeStore(settled)} · ${describeSchema(check.schema)}`));
          return null;
        }
        world.log(paint.fail(`store        ${describeStore(settled)} does not answer — ${check.why}`));
      } else if (settled.because === "unreadable") {
        // `readConfig` refused this already; it is here because the two readers
        // are separate and one of them must not be the only one that looks.
        return refuse(world, settled.refused);
      } else {
        // *Nothing chosen* is the question this command is about to ask, so it
        // is asked rather than reported — a refusal naming `lingtai init` is
        // absurd inside `lingtai init`. The other two are a file being
        // repaired, and what was wrong with it is said before asking again.
        if (settled.because !== "nothing chosen") world.log(paint.fail(settled.refused));
        // A machine set up before the store was a written value (#186) has a
        // `database.url` and no `store`. That URL is the choice nobody
        // recorded: it is verified and recorded, not asked for a second time.
        const older = config.getIn(["database", "url"]);
        if (!inherited && settled.because === "nothing chosen" && typeof older === "string" && older !== "") {
          candidate = older;
          inherited = true;
        }
      }
    }
    if (candidate === null) {
      const answer = await world.ask(paint.signal("a Postgres URL for the log — empty for SQLite: "));
      if (answer === null) {
        return refuse(world, `nobody is at a terminal to say which store — ${USAGE}. Nothing was written`);
      }
      candidate = answer.trim();
    }
    if (candidate === "") {
      // The SQLite choice, written — and `database.url` removed in the same
      // write. Left behind it would go on selecting Postgres under a screen
      // that had just said SQLite, which is the whole of #215.
      config.setIn(["database", "store"], "sqlite");
      config.deleteIn(["database", "url"]);
      writeConfig(path, config, home);
      const read = confirm(world, path, "sqlite");
      return typeof read === "number" ? read : sqliteChosen(world, read);
    }
    if (!/^postgres(ql)?:\/\//.test(candidate)) {
      world.log(paint.fail(`that is not a Postgres URL — it begins postgres:// or postgresql://. Nothing was written`));
    } else {
      const check = await world.database(candidate);
      if (check.ok) {
        config.setIn(["database", "store"], "postgres");
        config.setIn(["database", "url"], candidate);
        writeConfig(path, config, home);
        const read = confirm(world, path, "postgres");
        if (typeof read === "number") return read;
        world.log(paint.pass(`store        ${describeStore(read)} · ${describeSchema(check.schema)}`));
        return null;
      }
      world.log(paint.fail(`${redactUrl(candidate)} does not answer — ${check.why}. Nothing was written`));
    }
    candidate = null;
  }
}

/**
 * What the machine says now, read back after the write — or an exit code.
 *
 * The confirmation is derived from `storeChoice()` and never composed from the
 * answer that was typed, which is how the screen and the file came apart in the
 * first place. A disagreement between them is that defect, so it is a refusal
 * naming both rather than a line nobody would read.
 */
function confirm(world: InitWorld, path: string, expected: "postgres" | "sqlite"): StoreChosen | number {
  const read = storeChoice(world.env);
  if ("refused" in read || read.store !== expected) {
    return refuse(world, `${expected} was written to ${path}, and reading it back does not say so — ${describeStore(read)}`);
  }
  return read;
}

/**
 * The store is chosen and recorded, and **setup goes on from here** — null, as
 * the Postgres branch returns when its URL answered.
 *
 * It used to return 1 with an amber line, on the grounds that there was no
 * board to serve because no log opened from this choice. #179 opened one, so
 * the exit code went with the claim: a machine that is set up correctly must
 * not be told to run `init` again with a Postgres URL instead.
 *
 * There is no `world.database()` check to make first. A Postgres URL has to be
 * connected to and its tables created before anything is written; a SQLite log
 * is a file this machine will create on first open, with its own schema
 * (`openSqliteLog`), so the write above *is* the verification — and `confirm`
 * has already read the file back with the function every later command asks.
 *
 * The claim itself is `SQLITE_MACHINE`, said in one place. Muted rather than
 * amber: nothing here needs doing.
 */
function sqliteChosen(world: Pick<InitWorld, "log">, choice: StoreChosen): null {
  world.log(paint.pass(`store        ${describeStore(choice)}`));
  world.log(paint.muted(SQLITE_MACHINE));
  return null;
}

/** Null once an agent is settled; an exit code when it cannot be. */
async function chooseAgent(
  world: InitWorld,
  config: Document,
  path: string,
  home: string,
  runtimes: readonly RuntimeFound[],
  flag: string | null,
): Promise<number | null> {
  const signedIn = runtimes.filter((r) => r.signedIn).map((r) => r.id);
  const named = config.getIn(["runtime", "agent"]);

  if (typeof named === "string" && (flag === null || flag === named)) {
    if ((signedIn as string[]).includes(named)) {
      world.log(paint.pass(`agent        ${named} ← ${path} · signed in`));
      return null;
    }
    world.log(paint.fail(`agent        ${named} ← ${path} is not signed in — ${detailOf(runtimes, named)}`));
    // Back to the choice, and asked even when one other is signed in: that one is not what was written.
    return ask(world, config, path, home, runtimes, signedIn, null);
  }

  if (signedIn.length === 1 && (flag === null || flag === signedIn[0])) {
    return write(world, config, path, home, signedIn[0]!, "detected — the only runtime signed in");
  }
  return ask(world, config, path, home, runtimes, signedIn, flag);
}

function detailOf(runtimes: readonly RuntimeFound[], id: string): string {
  const found = runtimes.find((r) => r.id === id);
  if (!found) return "Lingtai has no runtime by that name";
  return found.installed ? found.detail : "not installed";
}

async function ask(
  world: InitWorld,
  config: Document,
  path: string,
  home: string,
  runtimes: readonly RuntimeFound[],
  signedIn: readonly RuntimeName[],
  flag: string | null,
): Promise<number | null> {
  if (signedIn.length === 0) {
    const each = runtimes.map((r) =>
      r.installed ? `${r.id} is installed and not signed in (${r.detail})` : `${r.id} is not installed`,
    );
    return refuse(
      world,
      `no agent runtime is signed in on this machine — ${each.join("; ")}. Sign in to one and run lingtai init again; ` +
        "whether it is paid for is between you and its provider. Nothing was written",
    );
  }
  if (flag !== null) {
    if ((signedIn as string[]).includes(flag)) return write(world, config, path, home, flag as RuntimeName, "--agent");
    world.log(paint.fail(`--agent ${flag} is not signed in here — ${detailOf(runtimes, flag)}`));
  }
  for (;;) {
    const options = signedIn.map((id, i) => `${i + 1}) ${id}`).join("  ");
    const answer = await world.ask(paint.signal(`${signedIn.join(" and ")} can run here — which one? ${options}: `));
    if (answer === null) {
      return refuse(world, `nobody is at a terminal to choose — ${USAGE}. Lingtai does not pick one silently; nothing was written`);
    }
    const trimmed = answer.trim();
    const picked = signedIn.find((id, i) => trimmed === id || trimmed === String(i + 1));
    if (picked !== undefined) return write(world, config, path, home, picked, "chosen");
    world.log(paint.fail(`"${trimmed}" is not one of ${signedIn.join(", ")}`));
  }
}

function write(
  world: InitWorld,
  config: Document,
  path: string,
  home: string,
  agent: RuntimeName,
  why: string,
): null {
  config.setIn(["runtime", "agent"], agent);
  writeConfig(path, config, home);
  world.log(paint.pass(`agent        ${agent} → ${path} · ${why}`));
  return null;
}

// ------------------------------------------------------------- live world --

/** The board lock this process holds while `lingtai init` serves one. See `board` below. */
let kept: HeldLock | null = null;

export function liveInitWorld(): InitWorld {
  return {
    env: process.env,
    log: (line) => console.log(line),
    ask: async (question) => {
      if (!process.stdin.isTTY) return null;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      // Ctrl+C at a question: every earlier answer is already written, and this one was not.
      rl.on("SIGINT", () => {
        console.log("\nstopped at the question — its answer was not written, and lingtai init again asks it here");
        process.exit(130);
      });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    git: async () => {
      const said = spawnSync("git", ["--version"], { encoding: "utf8" });
      return said.status === 0 ? said.stdout.trim() : null;
    },
    runtimes: async () => {
      const env = runnableEnv({});
      const asked = await Promise.all([claudeCodeAuth("claude", env), codexAuth("codex", env)]);
      return RUNTIMES.map((id, i) => ({
        id,
        // A missing binary is a spawn error, and not a runtime saying it is signed out.
        installed: !/ENOENT/.test(asked[i]!.detail),
        signedIn: asked[i]!.loggedIn,
        detail: asked[i]!.detail,
      }));
    },
    database: async (url) => {
      const pg = (await import("pg")).default;
      const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
      try {
        await client.connect();
        return { ok: true, schema: await createSchema(client) };
      } catch (err) {
        return { ok: false, why: (err as Error).message || String(err) };
      } finally {
        await client.end().catch(() => {});
      }
    },
    app: liveApp,
    appeared: async () => {
      for (;;) {
        const app = await liveApp();
        if (app.configured && app.ok) return { slug: app.slug, owner: app.owner };
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    },
    boardAt: async (port) => {
      const url = `http://127.0.0.1:${port}`;
      try {
        // The board's own title, so a port some other server holds is not mistaken for it.
        const res = await fetch(`${url}/setup/github-app`, { signal: AbortSignal.timeout(5000) });
        return (await res.text()).includes("<title>Lingtai</title>") ? url : null;
      } catch {
        return null;
      }
    },
    board: async (port) => {
      const host = "127.0.0.1";
      // The same lock `lingtai board start` takes (#187), and for the same
      // reason: a board this process serves and no lock names is one that
      // `lingtai board status` calls nobody's and `lingtai board stop` cannot
      // stop. Held for as long as this process serves — `kept` is module scope
      // so nothing collects the handle out from under the lock.
      const taken = await createFileLocker().tryLock(boardLock(port), `board on ${port}`);
      if (!taken.ok) {
        return { refused: `a board is already on ${port} — held by ${taken.holder ?? "a holder that has not named itself"}` };
      }
      kept = taken.lock;
      try {
        await serveBoard({ dir: builtBoardDir(), port, host });
      } catch (err) {
        await kept.release();
        kept = null;
        return { refused: (err as Error).message };
      }
      return { url: `http://${host}:${port}` };
    },
    open: (url) =>
      new Promise((resolve) => {
        const opener = process.platform === "darwin" ? "open" : "xdg-open";
        const child = spawn(opener, [url], { stdio: "ignore", detached: true });
        child.once("error", () => resolve(false));
        child.once("spawn", () => {
          child.unref();
          resolve(true);
        });
      }),
  };
}

/** `GET /app` with the App's own JWT — the call that proves the id and the key belong together. */
async function liveApp(): Promise<AppCheck> {
  const env = await import("@lingtai/env");
  if (!env.hasGitHubApp()) return { configured: false };
  try {
    const github = await import("@lingtai/github");
    const credentials = env.githubApp();
    const reader = github.createAppReader({ appId: credentials.appId, privateKey: credentials.privateKey });
    const app = await reader.request<{ slug: string; owner: { login: string } }>("GET", "/app", "app");
    return { configured: true, ok: true, slug: app.slug, owner: app.owner.login };
  } catch (err) {
    return { configured: true, ok: false, why: (err as Error).message };
  }
}
