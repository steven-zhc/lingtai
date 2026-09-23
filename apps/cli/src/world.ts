/**
 * The live `World` the install commands run against — separate from `entry.ts`
 * so a test can run it, the way `upgrade-drain.ts` was.
 *
 * **Two of its answers turn on where this machine's log is**, and three used to
 * ask that by catching an exception from the Postgres getter (#213):
 *
 *     logConfigured: () => { try { return Boolean(databaseUrl()); } catch { return false; } }
 *
 * That is *is there a log* written as *does `databaseUrl()` throw*, which is
 * the same sentence only while every log is Postgres. #178 landed a store that
 * is a file, and nothing in the type system would have noticed the day the two
 * parted: a `catch` keeps compiling and starts lying. #213 made it
 * `logConfigured()`, a boolean that reads rather than throws — and #179 was
 * the day the two parted, so a boolean was no longer enough either. `logWhere`
 * is where the log **is** and `liveDrain` asks the lock; see both below
 * ([#214](https://github.com/steven-zhc/lingtai/issues/214)).
 *
 * The third was `conducting`, and separating the two questions is what showed
 * that it never belonged in this list: the lock it asks about is a file under
 * `~/.lingtai/locks/` (#193), so it is asked on a machine with no log at all.
 *
 * What is past this module — the lock, the drain proper — is `Live`, so a test
 * can watch the drain **not** being reached where no log is configured, and the
 * lock being asked anyway. That is the assertion the three `catch` blocks never
 * had.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
// Only the loader, which reads `.env.local` and connects to nothing.
import {
  dbVar,
  logConfigured,
  optional,
  postgresUrlIfSet,
  redactUrl,
  SQLITE_LOG,
  stateDir,
  storeChoice,
  type StoreChoice,
} from "@lingtai/env";
import { runningFrom, type AppFacts, type Drained, type LogLocation, type World } from "./install.ts";

/** Everything the live world reaches that a test must not: the log, and what is behind it. */
export interface Live {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** Who holds the conductor lock. Asked whether or not a log is configured — it is a file (#193). */
  holder: () => Promise<string | null>;
  /** The drain proper — the doctor gate, the request and the wait. Reached unless nothing conducts and no store is written. */
  drain: (reason: string, despiteDoctor: boolean) => Promise<Drained>;
}

/** The real one: `process.env`, the terminal, and the daemon behind a dynamic import. */
export function live(): Live {
  return {
    env: process.env,
    log: (line) => console.log(line),
    holder: async () => {
      // `@lingtai/daemon/lock` and not `@lingtai/daemon`: the lock is a file
      // under `~/.lingtai/locks/` (#193, 0052) and reads with nothing
      // configured. The package's index used to reach `@lingtai/event-store`,
      // whose process-wide client called `postgresUrl()` at import — the only
      // reason a machine with no log could not ask who conducts, and closed by
      // #179. The subpath stays: this asks about a file and should load a
      // file's worth of code.
      const lock = await import("@lingtai/daemon/lock");
      return lock.conductorLockHolder();
    },
    drain: drainWithTheLog,
  };
}

/**
 * `self` is the file the process was started from — `entry.ts`'s, which is what
 * an upgrade compares with the shim it would move. Passed in rather than read
 * here, because `import.meta.filename` in this module names this module.
 */
export function liveWorld(self: string, outside: Live = live()): World {
  return {
    env: outside.env,
    self,
    fetch: (input, init) => fetch(input, init),
    log: outside.log,
    ask: async (question) => {
      if (!process.stdin.isTTY) {
        outside.log("there is nobody at a terminal to ask — --yes answers for you, once you have read what it removes");
        return false;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question(question)).trim());
      } finally {
        rl.close();
      }
    },
    running: runningFrom,
    // **Asked whether or not a log is configured.** The conductor lock is a
    // file under `~/.lingtai/locks/` since #193, so a daemon running from a
    // checkout — whose `.env.local` names a log this copy has never heard of —
    // is named here rather than answered as a null. Gating this on the log was
    // true only while the lock was `pg_advisory_lock`, and what it would cost
    // is `install.ts` removing a live conductor's worktrees on `--nothing-conducts`.
    conducting: () => outside.holder(),
    drain: (reason, despiteDoctor) => liveDrain(reason, despiteDoctor, outside),
    app: liveApp,
    logWhere: () => logLocation(outside.env),
  };
}

/**
 * Where this machine's log is — and, before anything else, **whether a
 * `lingtai.db` is sitting in what the removal takes**
 * ([#214](https://github.com/steven-zhc/lingtai/issues/214)).
 *
 * **The file is asked on every machine, and no written choice excuses not
 * asking.** The first attempt at this asked it only where `storeChoice`
 * *refused*, on the argument that a refusal is not a promise no file is there
 * — which is true, and is equally true of a machine that chose Postgres. An
 * operator who ran `lingtai init`, chose SQLite, recorded a log, and then moved
 * to Postgres the way 0056 §3 documents — by *exporting*
 * `LINGTAI_DATABASE_URL`, which `storeChoice` takes before it ever opens
 * `config.yml` — is a chosen Postgres with the whole of the old log still in
 * `~/.lingtai/lingtai.db`. Asked the old way, `uninstall` `rmSync`'d that file
 * and then printed *the database LINGTAI_DATABASE_URL names is untouched*: the
 * only copy of every event recorded before the switch, deleted under a sentence
 * saying nothing under `~/.lingtai` held the log. 0055 §3 is why there is no
 * other copy — the Postgres log started empty rather than carrying it over.
 *
 * **And a path is not a file.** `lingtai init` writes `database.store: sqlite`
 * and stops; the log is created on first open, so the ordinary state of a
 * just-initialised machine is a chosen SQLite with nothing at the path. `file`
 * there would have `uninstall` telling somebody it was destroying every event
 * this machine recorded, and that they could not be recovered, about a file
 * that never existed — in the one command whose standard is that a sentence
 * about the log is true. So `file` means *a log is there*, `existsSync`
 * decides it, and only the **log that exists** is reported.
 *
 * `alsoElsewhere` carries the machine where both are true, because an uninstall
 * has two things to say there and one of them must not be the other's sentence.
 * `named` carries *which* database survives, for the reason `namedDatabase`
 * below gives: on one of the two machines with a log elsewhere, the removal
 * takes the file that named it.
 *
 * Reads and never throws, for the reason `logConfigured` was a boolean: the two
 * commands that call it, `uninstall` and `upgrade`, are the ones that repair a
 * broken install, and a half-written `config.yml` must not be what stops them
 * (#213). `storeChoice` is total and returns its refusals as data, and
 * `existsSync` answers false rather than throwing.
 */
export function logLocation(env: NodeJS.ProcessEnv): LogLocation {
  const choice = storeChoice(env);
  // Under a refusal, `logConfigured` under the name it always meant: *is
  // Postgres configured*. `two keys` and `no url` are machines that name a URL
  // and chose nothing, and a log somewhere else is still a log this removal
  // leaves standing.
  const elsewhere = "refused" in choice ? logConfigured(env) : choice.store === "postgres";
  // A chosen SQLite names its own file, so the two reads cannot drift apart;
  // everywhere else it is where one would be, or null for an environment that
  // names no machine.
  const file = !("refused" in choice) && choice.store === "sqlite" ? choice.path : sqliteLogIn(env);
  if (file !== null && existsSync(file)) return { kind: "file", path: file, alsoElsewhere: elsewhere };
  return elsewhere ? { kind: "elsewhere", named: namedDatabase(env, choice) } : { kind: "none" };
}

/**
 * How the surviving database can still be named **after `~/.lingtai` is gone**.
 *
 * `lingtai uninstall`'s last line used to say *the database
 * `LINGTAI_DATABASE_URL` names is untouched* on every machine with a log
 * somewhere else, and there are two of those. An operator who ran `lingtai
 * init` and typed a URL has it written in `~/.lingtai/config.yml` and nothing
 * exported — so the `rmSync` takes the only local record of which database
 * survived, and the one line meant to say which it was points at a variable
 * that was never set ([#214](https://github.com/steven-zhc/lingtai/issues/214)).
 *
 * So: the variable where the variable is really what names it, and where it is
 * not, the URL itself — **redacted**, because `redactUrl` is the one copy of
 * the rule that a printed URL never carries a password.
 *
 * The variable read is `optional(dbVar(…))` rather than `choice.where`: a
 * `config.yml` that `storeChoice` *refused* over can still have that variable
 * set beside it, and there the variable does name it.
 */
function namedDatabase(env: NodeJS.ProcessEnv, choice: StoreChoice): string {
  const name = dbVar("DATABASE_URL", env);
  if (optional(name, env) !== undefined) return `${name} names`;
  const url = "refused" in choice ? postgresUrlIfSet(env) : choice.store === "postgres" ? choice.url : undefined;
  // Not a third case: with no URL found anywhere, `elsewhere` above is false
  // and this is never asked. It is the sentence's old words, so that the
  // expression is total rather than `?`-ing a string into the line.
  return url === undefined ? `${name} names` : `at ${redactUrl(url)}`;
}

/**
 * Where a SQLite log would be **for the environment `storeChoice` was just
 * asked**, or null where that environment names no machine at all.
 *
 * The rule is `machineChoiceFile`'s, and it has to be the same one: looking for
 * a log in a directory the choice was never read from is a question about
 * somebody else's machine. This process's own environment is a machine, unless
 * this is a test run — the suite's environment must never reach the operator's
 * files — and an environment handed in is one only when it names its own
 * `LINGTAI_HOME`, so a test that hands in `{}` is answered without touching any
 * machine. Without that, `stateDir({})` falls back to `homedir()` and this
 * would report the operator's own log to a test that configured nothing.
 */
function sqliteLogIn(env: NodeJS.ProcessEnv): string | null {
  const machine =
    env === process.env ? !env["VITEST"] && !env["LINGTAI_TEST"] : Boolean(env["LINGTAI_HOME"]);
  return machine ? join(stateDir(env), SQLITE_LOG) : null;
}

/**
 * Whether this machine has a store at all: one it wrote down, or — under a
 * refusal, where nothing was written — a log evidently there anyway.
 *
 * The drain's half of the question `logLocation` answers for `uninstall`. It is
 * deliberately *wider* than `logLocation(env).kind !== "none"`: a machine that
 * wrote `store: sqlite` and has not opened the file yet is `none` there, having
 * no events to lose, and is a configured system here.
 */
function storeWritten(env: NodeJS.ProcessEnv): boolean {
  return !("refused" in storeChoice(env)) || logLocation(env).kind !== "none";
}

/**
 * `lingtai shutdown`'s drain, and `lingtai restart`'s wait on the lock, before
 * the shim moves (0042).
 *
 * **The question is whether anything conducts, and the lock answers it.** This
 * asked `logConfigured()` — *is Postgres configured* — which since #179 says
 * `false` about a machine that wrote `store: sqlite` **while a daemon is
 * conducting on it**: `lingtai upgrade` there reported a drain that never
 * happened and moved the shim under a live conductor
 * ([#214](https://github.com/steven-zhc/lingtai/issues/214)). 0042's rule is
 * that a refusal comes before the drain, because a refusal after the drain is a
 * system that is down; this was worse than a late refusal — no refusal, no
 * drain, and the shim moved anyway.
 *
 * The conductor lock is a file under `~/.lingtai/locks/` since #193, so it is
 * asked and answered with no database at all, which is exactly why `conducting`
 * on the `World` beside this one is already asked unconditionally.
 *
 * **A held lock is not the only reason to reach the drain**, so this is an
 * `and` and not a swap. `drainForUpgrade` runs the doctor gate, adopts a drain
 * this person left standing and withdraws it — all of which want a log even
 * where nothing holds the lock this second. So the drain is skipped only where
 * *both* are absent: nothing conducts, and this machine has written no store.
 * That is strictly narrower than what it skipped before.
 *
 * A lock that cannot be read throws rather than answering null
 * (`daemon/src/lock.ts`), and it throws out of here: a drain that quietly
 * decided *nothing conducts* because it could not read the file is the failure
 * this whole docstring is about.
 *
 * **The second half is `storeWritten` and not `logLocation`**, because the two
 * commands want opposite things from the same machine. `uninstall` asks what it
 * is about to destroy, and a chosen SQLite whose file has never been opened has
 * nothing there to destroy. This asks whether there is a system here at all,
 * and that machine has chosen a store: its doctor gate and a drain somebody
 * left standing are still its own.
 */
export async function liveDrain(reason: string, despiteDoctor: boolean, outside: Live = live()): Promise<Drained> {
  const holder = await outside.holder();
  if (holder === null && !storeWritten(outside.env)) {
    outside.log("nothing holds the conductor lock and this machine has written no store — nothing to drain");
    return { ok: true, after: async () => {} };
  }
  return outside.drain(reason, despiteDoctor);
}

/**
 * The drain once there is a log to drain from. Imported here, because it is the log.
 *
 * `lingtai restart` itself is not called: it refuses a start that has no
 * checkout to name a commit from, which every installed copy is, and it starts
 * a daemon in this terminal, which an upgrade has no business holding.
 */
async function drainWithTheLog(reason: string, despiteDoctor: boolean): Promise<Drained> {
  const daemon = await import("@lingtai/daemon");
  const { doctorReport } = await import("./doctor.ts");
  const { formatFailures, gatingFailures, waitForTheLock } = await import("./restart.ts");
  const by = `human:${process.env["USER"] ?? "operator"}`;

  const { drainForUpgrade } = await import("./upgrade-drain.ts");
  return drainForUpgrade({
    by,
    reason,
    despiteDoctor,
    doctor: async () => {
      const report = await doctorReport();
      const failed = gatingFailures(report.results);
      console.log(formatFailures(report.results, failed));
      return failed;
    },
    holder: () => daemon.conductorLockHolder(),
    control: () => daemon.readControl(),
    request: (who, why) => daemon.requestShutdownUnlessStanding(who, why),
    withdraw: (who, version, why) => daemon.withdrawShutdown(who, version, why),
    inFlight: async () => daemon.describeInFlight(await daemon.inFlight().catch(() => [])),
    wait: () =>
      waitForTheLock("draining", null, (line) => console.log(line), {
        ctrlC:
          "ctrl-c stops waiting, leaves the drain standing and the shim where it is — lingtai upgrade again asks for it afresh, and lingtai resume lifts it.",
      }),
    log: (line) => console.log(line),
  });
}

/** The App this machine is configured with, as GitHub reports it — null where none is. */
async function liveApp(): Promise<AppFacts | null> {
  const env = await import("@lingtai/env");
  if (!env.hasGitHubApp()) return null;
  const credentials = env.githubApp();
  const github = await import("@lingtai/github");
  const reader = github.createAppReader({ appId: credentials.appId, privateKey: credentials.privateKey });
  const app = await reader.request<{ slug: string; owner: { login: string; type: string } }>("GET", "/app", "app");
  const installations = await github.appInstallations(reader);
  let repositories = 0;
  for (const installation of installations) {
    repositories += (await github.installationRepositories(reader, installation.id)).length;
  }
  return {
    slug: app.slug,
    owner: app.owner.login,
    organisation: app.owner.type === "Organization",
    installations: installations.length,
    repositories,
    key: credentials.keySource.startsWith("LINGTAI_")
      ? { variable: credentials.keySource, files: env.envFiles().filter((file) => envFileSets(file, credentials.keySource)) }
      : { path: env.resolvePath(credentials.keySource) },
  };
}

/** Whether an env file names `variable` — so an uninstall can say whether removing the file removed the key. */
function envFileSets(file: string, variable: string): boolean {
  try {
    // dotenv's own shape, `NAME=value` with an optional `export`, and not empty.
    return new RegExp(`^\\s*(export\\s+)?${variable}\\s*=\\s*[^\\s#]`, "m").test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}
