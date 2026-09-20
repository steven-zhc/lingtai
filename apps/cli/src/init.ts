/**
 * `lingtai init`: from a machine with a binary and nothing else to the board,
 * on the wizard (#186, [doc/design/1.0.md](../../../doc/design/1.0.md) *The
 * first run*).
 *
 *   look       git, which runtimes are installed and signed in, what ~/.lingtai holds
 *   database   a Postgres URL — connected to, and its tables created
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
 * **SQLite is the absence, and it is not built** (#179). An empty answer is
 * that choice, and this says so and asks again rather than writing a machine
 * whose board cannot start.
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
import { boardPort, stateDir } from "@lingtai/env";
import { paint } from "@lingtai/env/colour";
import { type SchemaOutcome, createSchema } from "@lingtai/event-store/schema";
import { boardPlace, dropBoardLock, holdBoardLock, serveBoard } from "./board.ts";

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
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** One line from the person. Null when nobody is at a terminal to answer. */
  ask: (question: string) => Promise<string | null>;
  /** `git --version`, or null when there is no git. */
  git: () => Promise<string | null>;
  /** Every runtime, asked whether it is installed and signed in. */
  runtimes: () => Promise<RuntimeFound[]>;
  /** A URL set outside `config.yml` — the environment, or an env file — and where. */
  presetDatabase: () => { url: string; from: string } | null;
  /** Connect, and create the tables where there are none. */
  database: (url: string) => Promise<DatabaseCheck>;
  /** The App this machine is configured with, asked with a real call. */
  app: () => Promise<AppCheck>;
  /** Resolves once an App is configured and answers — written by the board's first screen. */
  appeared: () => Promise<{ slug: string; owner: string }>;
  /**
   * A Lingtai board already answering on this port — the machine's own, from
   * `lingtai board start` or the service — as its URL, or null. Asked before
   * one is started, since a second on the same port is refused.
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

/** A URL fit to print: the password is never shown. */
export function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "(a URL that does not parse)";
  }
}

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
  if (asked !== null && (!Number.isInteger(asked) || asked <= 0)) {
    return refuse(world, `${USAGE} — --port takes a port number`, 2);
  }

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

  // The port only once the file has been proved to parse — this command is the
  // one that fixes a broken `config.yml`, so reading a setting out of it first
  // would refuse in `@lingtai/env`'s words over `readConfig`'s (#187).
  // `boardPort`, so `lingtai init` and `lingtai board start` name one address:
  // the machine file's `board.port` where it names one, and 17820 otherwise. It
  // was `3200` here and `-p 3200` in the board's `package.json`, which is the
  // wrong place — somebody who installed Lingtai does not edit its package.json.
  let port: number;
  try {
    port = asked ?? boardPort(world.env);
  } catch (err) {
    return refuse(world, `${(err as Error).message} — fix it and run lingtai init again`);
  }

  // ---- the database ---------------------------------------------------------
  const database = await chooseDatabase(world, config, path, home, flags["database-url"] ?? null);
  if (database !== null) return database;

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
      : paint.muted("the board keeps running in this terminal — ctrl-c stops it, and lingtai board start starts it again"),
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

/** Null once a database is settled; an exit code when it cannot be. */
async function chooseDatabase(
  world: InitWorld,
  config: Document,
  path: string,
  home: string,
  flag: string | null,
): Promise<number | null> {
  const preset = world.presetDatabase();
  if (preset !== null) {
    const check = await world.database(preset.url);
    if (!check.ok) {
      return refuse(
        world,
        `the database ${preset.from} names, ${redact(preset.url)}, does not answer — ${check.why}. ` +
          "It is not this command's to replace: fix it, or remove it, and run lingtai init again",
      );
    }
    world.log(paint.pass(`database     Postgres, ${redact(preset.url)} ← ${preset.from} · ${describeSchema(check.schema)}`));
    return null;
  }

  const written = config.getIn(["database", "url"]);
  let candidate = flag;
  if (typeof written === "string" && written !== "" && (candidate === null || candidate === written)) {
    const check = await world.database(written);
    if (check.ok) {
      world.log(paint.pass(`database     Postgres, ${redact(written)} ← ${path} · ${describeSchema(check.schema)}`));
      return null;
    }
    world.log(paint.fail(`database     ${redact(written)} ← ${path} does not answer — ${check.why}`));
    candidate = null;
  }

  for (;;) {
    if (candidate === null) {
      const answer = await world.ask(paint.signal("a Postgres URL for the log — empty for SQLite: "));
      if (answer === null) {
        return refuse(world, `nobody is at a terminal to say which database — ${USAGE}. Nothing was written`);
      }
      candidate = answer.trim();
    }
    if (candidate === "") {
      world.log(
        paint.fail(
          "SQLite is the choice an empty answer makes, and it is not built yet (#179) — a Postgres URL is the one store " +
            "this version runs on. Nothing was written",
        ),
      );
    } else if (!/^postgres(ql)?:\/\//.test(candidate)) {
      world.log(paint.fail(`that is not a Postgres URL — it begins postgres:// or postgresql://. Nothing was written`));
    } else {
      const check = await world.database(candidate);
      if (check.ok) {
        config.setIn(["database", "url"], candidate);
        writeConfig(path, config, home);
        world.log(paint.pass(`database     Postgres, ${redact(candidate)} → ${path} · ${describeSchema(check.schema)}`));
        return null;
      }
      world.log(paint.fail(`${redact(candidate)} does not answer — ${check.why}. Nothing was written`));
    }
    candidate = null;
  }
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
    presetDatabase: () => {
      const url = process.env["LINGTAI_DATABASE_URL"];
      return url ? { url, from: "LINGTAI_DATABASE_URL (the environment, or .env.local)" } : null;
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
      // The lock every path that serves a board takes (#187). Without it the
      // board this command leaves running is invisible to the rest of the
      // lifecycle: `board stop` finds nobody to signal, `board status` says
      // `nobody` is serving, and the next `board start` names it as something
      // that is not a board — on the one path that installs Lingtai.
      // `boardPlace`, the same question `board start` asks: the built board
      // beside this CLI, or — on a checkout, which is how a contributor runs
      // this — the workspace's own, served by its `next`.
      const place = boardPlace();
      if ("missing" in place) return { refused: place.missing };
      const held = await holdBoardLock(port);
      if (!("ok" in held)) {
        return { refused: `a board is already on ${port} — ${held.held ?? "it has not named itself"}. pnpm lingtai board stop stops it` };
      }
      try {
        await serveBoard({ place, port, host });
      } catch (err) {
        await dropBoardLock();
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
