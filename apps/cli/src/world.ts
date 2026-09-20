/**
 * The live `World` the install commands run against — separate from `entry.ts`
 * so a test can run it, the way `upgrade-drain.ts` was.
 *
 * **Three of its answers turn on whether a log is configured**, and each of
 * them used to ask that by catching an exception from the Postgres getter
 * (#213):
 *
 *     logConfigured: () => { try { return Boolean(databaseUrl()); } catch { return false; } }
 *
 * That is *is there a log* written as *does `databaseUrl()` throw*, which is
 * the same sentence only while every log is Postgres. #178 landed a store that
 * is a file, and nothing in the type system would have noticed the day the two
 * parted: a `catch` keeps compiling and starts lying. They ask
 * `logConfigured()` now, which is a boolean and reads rather than throws.
 *
 * What is past this module — the lock, the drain proper — is `Live`, so a test
 * can watch those **not** being reached where no log is configured. That is the
 * assertion the three `catch` blocks never had.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
// Only the loader, which reads `.env.local` and connects to nothing.
import { logConfigured } from "@lingtai/env";
import { runningFrom, type AppFacts, type Drained, type World } from "./install.ts";

/** Everything the live world reaches that a test must not: the log, and what is behind it. */
export interface Live {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** Who holds the conductor lock. Asked only where a log is configured. */
  holder: () => Promise<string | null>;
  /** The drain proper — the doctor gate, the request and the wait. Reached only where a log is configured. */
  drain: (reason: string, despiteDoctor: boolean) => Promise<Drained>;
}

/** The real one: `process.env`, the terminal, and the daemon behind a dynamic import. */
export function live(): Live {
  return {
    env: process.env,
    log: (line) => console.log(line),
    holder: async () => {
      const daemon = await import("@lingtai/daemon");
      return daemon.conductorLockHolder();
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
    // The lock lives in the log, so there is nothing to ask where none is
    // configured — and a null here is *nothing conducts that this copy can see*,
    // which `install.ts` is careful not to read as *nothing conducts*.
    conducting: async () => (logConfigured(outside.env) ? outside.holder() : null),
    drain: (reason, despiteDoctor) => liveDrain(reason, despiteDoctor, outside),
    app: liveApp,
    logConfigured: () => logConfigured(outside.env),
  };
}

/**
 * `lingtai shutdown`'s drain, and `lingtai restart`'s wait on the lock, before
 * the shim moves (0042).
 *
 * With no log configured nothing conducts from this copy, so there is nothing
 * to drain and nothing behind the log is reached — the daemon is not imported,
 * the doctor is not run.
 */
export async function liveDrain(reason: string, despiteDoctor: boolean, outside: Live = live()): Promise<Drained> {
  if (!logConfigured(outside.env)) {
    outside.log("no log is configured here, so nothing conducts from it — nothing to drain");
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
