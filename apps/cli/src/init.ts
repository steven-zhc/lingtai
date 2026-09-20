/**
 * `lingtai init`: from a machine with a binary and nothing else to the board,
 * on the wizard (#186, [doc/design/1.0.md](../../../doc/design/1.0.md) *The
 * first run*).
 *
 *   look       git, which runtimes are installed and signed in, what ~/.lingtai holds
 *   database   a Postgres URL — connected to, and its tables created; empty is
 *              SQLite, which takes any URL already in the file back out and
 *              ends the run there (#179)
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
 * **SQLite is the absence, so the file must be left holding no URL** (#179).
 * An empty answer settles the database rather than asking again — but absence
 * is read back out of this same `config.yml` by `storeChoice()`, so a
 * `database.url` left standing there would go on selecting Postgres on a
 * machine this command had just told the operator was on SQLite. The empty
 * answer therefore *removes* it, and says which URL it removed. That is the
 * only place init deletes rather than adds, and it is the same rule as
 * everywhere else here: what the file says **is** the choice, so a choice that
 * is absence has to leave the file saying nothing.
 *
 * It is not a conversion. Nothing moves between the two stores (0055), and the
 * Postgres that URL named is left exactly as it was.
 *
 * **And that answer ends the run.** Everything below the database step finishes
 * by serving the board here and opening the App wizard, which appends
 * `GitHubAppCreated` through the event store — so on a SQLite machine
 * continuing would create the log that every other command has just been told
 * to refuse, and `entry.ts` answers these five commands precisely so that none
 * of them is the thing that makes one. The choice is kept; the agent, the App
 * and the board are the next `lingtai init`'s.
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
import { Document, isMap, isScalar, parseDocument } from "yaml";
import { claudeCodeAuth, codexAuth } from "@lingtai/agent/auth";
import { runnableEnv } from "@lingtai/agent-env";
import { stateDir } from "@lingtai/env";
import { paint } from "@lingtai/env/colour";
import { type SchemaOutcome, createSchema } from "@lingtai/event-store/schema";
import { builtBoardDir, serveBoard } from "./board.ts";

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
   * `lingtai board` or the service — as its URL, or null. Asked before one is
   * started, since a second on the same port is refused.
   */
  boardAt: (port: number) => Promise<string | null>;
  /** Serve the board; the process stays up for it. */
  board: (port: number) => Promise<{ url: string } | { refused: string }>;
  /** Open a browser. False when none could be. */
  open: (url: string) => Promise<boolean>;
}

/** `lingtai board`'s default, so the two commands name one address. */
export const BOARD_PORT = 3200;

const USAGE = "lingtai init [--database-url <postgres url>] [--agent claude-code|codex] [--port <n>]";

// ---------------------------------------------------------- config.yml --

export function configPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "config.yml");
}

/** The machine file as a document, so a write keeps every comment and key it did not choose. */
function readConfig(path: string): Document | { refused: string } {
  if (!existsSync(path)) return new Document({});
  // `Document` and not the `Document.Parsed` this returns: the branch below
  // puts a node into `contents` that was never in the text, and a parsed
  // document's contents are typed as nodes that carry a source range. It is the
  // type this function hands back either way.
  const doc: Document = parseDocument(readFileSync(path, "utf8"));
  if (doc.errors.length > 0) {
    return { refused: `${path} does not parse as YAML (${doc.errors[0]!.message}) — fix it and run lingtai init again` };
  }
  // **A file of comments and nothing else is a file with comments in it.**
  // `new Document({})` here would be a fresh document, and the operator's
  // header would go out with the one it replaced — which is what the empty
  // answer now leaves behind (`render`), so the ordinary way to reach this
  // branch is a machine that chose SQLite and is naming a Postgres URL on the
  // next run. The contents are made a map in place; the comments stay on the
  // document they were parsed from.
  if (doc.contents === null) {
    doc.contents = doc.createNode({});
    return doc;
  }
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
  writeFileSync(partial, render(doc), { mode: 0o600 });
  chmodSync(partial, 0o600);
  renameSync(partial, path);
}

/**
 * The document as text — and **a document with no keys left is its comments and
 * nothing else**.
 *
 * `yaml` writes an empty map as the flow mapping `{}`, which is valid, is read
 * back as a map, and is a one-way door: `setIn` keeps the style it parsed, so
 * the next `lingtai init` to add a URL writes
 * `{ database: { url: … }, runtime: { agent: codex } }` on a single line with
 * the operator's header stranded under it, and every one after that grows the
 * same line. Reachable by one sequence and it is this command's own — the empty
 * answer takes `database.url` out, `dropKey` takes the empty `database:` with
 * it, and on a file where that was the only key what is left is a map with
 * nothing in it.
 *
 * So it is not written. The comments are, in the order they stood in, because
 * they are the whole of what the file still says and this command promises to
 * keep what it did not choose. `yaml` stores comment text without its `#`, one
 * line per `\n`, which is what putting them back costs.
 */
function render(doc: Document): string {
  if (!isMap(doc.contents) || doc.contents.items.length > 0) return doc.toString();
  const kept = [doc.commentBefore, doc.contents.commentBefore, doc.comment]
    .filter((c): c is string => typeof c === "string" && c !== "")
    .map((c) => c.split("\n").map((line) => `#${line}`).join("\n"))
    .join("\n");
  return kept === "" ? "" : `${kept}\n`;
}

/**
 * Take a top-level key out, and **leave the comments above it where a reader
 * put them**.
 *
 * `yaml` hangs a leading comment on the key that follows it, so a file whose
 * first line is `# the machine I run on` has that line attached to whichever
 * key happens to come first — and deleting that key deletes the header with it.
 * The rest of this file promises a write keeps every comment it did not choose;
 * the one deletion here (`chooseDatabase`'s empty answer) has to keep the same
 * promise, so the comment moves down to the key that now stands first rather
 * than going out with the one that was asked for.
 *
 * **And when nothing follows it, down to the end of the file.** `database:` is
 * as likely to be written last as first — it is the line `lingtai init` adds —
 * so *move it to the next key* has to answer the case where there is no next
 * key, or the promise holds only for the arrangement the test happened to
 * write. The document's trailing comment is where those lines land: the same
 * text, at the place in the file it already occupied, which is the whole of
 * what was promised.
 *
 * **And when it was the only key, the document has no keys at all.** That is
 * `render`'s case rather than this one's: an empty map written as `{}` is what
 * collapses the file to a single flow line on every later run, so the file
 * becomes those comments and nothing else.
 */
function dropKey(config: Document, key: string): void {
  const items = isMap(config.contents) ? config.contents.items : [];
  const index = items.findIndex((pair) => isScalar(pair.key) && pair.key.value === key);
  const going = index === -1 ? undefined : items[index]!.key;
  const next = index === -1 ? undefined : items[index + 1]?.key;
  if (isScalar(going) && typeof going.commentBefore === "string") {
    const moving = going.commentBefore;
    const under = (was: string | null | undefined): string => (was === null || was === undefined ? moving : `${moving}\n${was}`);
    if (isScalar(next)) next.commentBefore = under(next.commentBefore);
    else config.comment = under(config.comment);
  }
  config.delete(key);
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
  const port = flags["port"] === undefined ? BOARD_PORT : Number(flags["port"]);
  if (!Number.isInteger(port) || port <= 0) return refuse(world, `${USAGE} — --port takes a port number`, 2);

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
      // **Absence is written by making it absent** (#179). Nothing new goes into
      // the file — a `store: sqlite` key would be a second setting that could
      // disagree with the first — but a `database.url` already there is exactly
      // what `storeChoice()` reads on every later command, so leaving it would
      // make this line a lie: the operator is told SQLite and the machine goes
      // on appending to that Postgres. It comes out, and is named coming out.
      const previous = config.getIn(["database", "url"]);
      const removed = typeof previous === "string" && previous !== "" ? previous : null;
      if (removed !== null) {
        config.deleteIn(["database", "url"]);
        // An empty `database:` left behind reads as a setting nobody made.
        const rest = config.get("database");
        if (isMap(rest) && rest.items.length === 0) dropKey(config, "database");
        writeConfig(path, config, home);
      }
      const said = removed === null
        ? `nothing written to ${path}`
        : `${redact(removed)} removed from ${path} — a new log, and nothing is converted from the old one`;
      world.log(paint.signal(`database     SQLite, ${join(home, "lingtai.db")} · ${said}`));
      // Amber, and said here rather than only in the README, because this is
      // where a person makes the choice. The store is built and the system
      // around it is not: the projections, the waker and the board's reads all
      // take a Postgres URL, so every command that would reach the log is
      // refused before it runs — `REFUSAL` in `store.ts`. Somebody who presses
      // Enter and then meets that error was not warned by anything.
      world.log(
        paint.signal(
          "             nothing that appends runs on SQLite yet — lingtai add, approve and run refuse by name, " +
            "and lingtai doctor fails its store row, until #175 ports the projections. Run lingtai init again " +
            "with a Postgres URL to move off it",
        ),
      );
      // **And init stops here, rather than being the sixth appending path.**
      // The steps below end by serving the board *in this process* and opening
      // it on `/setup/github-app`, and rendering that page calls
      // `offerCreation`, which reads and appends `GitHubAppCreated` through
      // `@lingtai/event-store`'s singleton — the same `storeChoice()` this
      // answer just made. So going on would create `lingtai.db` and write the
      // machine's App into it, on the one machine every other command has just
      // been told to refuse: `entry.ts` dispatches these five commands because
      // each must run where there is no log and must never be the thing that
      // makes one. The choice is recorded — by absence, which is the whole of
      // recording it — and nothing after it can be done on this store yet.
      return refuse(
        world,
        `stopping here: the board is served from this process and its first screen is the App wizard, which ` +
          `appends GitHubAppCreated to this machine's log — on SQLite that would create ${join(home, "lingtai.db")} ` +
          `and put the App in a log no other command will read. The agent, the App and the board are the next ` +
          `lingtai init's, on a machine that names a Postgres URL. The choice above is kept`,
      );
    }
    if (!/^postgres(ql)?:\/\//.test(candidate)) {
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
      try {
        await serveBoard({ dir: builtBoardDir(), port, host });
      } catch (err) {
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
