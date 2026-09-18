#!/usr/bin/env node
/**
 * `lingtai` — the entry, in front of `lingtai.ts`.
 *
 * Install/init commands and migration help answer before the rest is imported
 * (#184, #186, #201). Everything `lingtai.ts` imports
 * loads `@lingtai/event-store`, whose client is built at module scope and throws
 * without a database URL — which a machine that has only just installed does
 * not have, one being uninstalled may no longer, and `init` is what gives it
 * one. Migration loads registration only once preview/apply is requested.
 * These are dispatched from here, and every other command is
 * `lingtai.ts`, unchanged.
 *
 * A dynamic `import()` and not a static one, since a static import is evaluated
 * before a line of this file runs; esbuild keeps it lazy in the CJS bundle.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
// Only the loader, which reads `.env.local` and connects to nothing.
import { databaseUrl } from "@lingtai/env";
import { INSTALL_COMMANDS, installCommand, runningFrom, type AppFacts, type Drained, type World } from "./install.ts";

const argv = process.argv.slice(2);

if (argv[0] === "migrate-runtime" || (argv[0] === "upgrade" && argv.includes("--migrate-runtime"))) {
  import("./migrate-runtime.ts")
    .then(({ migrateRuntimeCommand, liveMigrationWorld }) => migrateRuntimeCommand(
      argv.slice(1).filter((a) => a !== "--migrate-runtime"), liveMigrationWorld()))
    .then((code) => { process.exitCode = code; }, (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
    });
} else if (argv[0] === "init") {
  // Only once asked: `init.ts` loads the board's server module, and no other command here needs it.
  import("./init.ts")
    .then(({ initCommand, liveInitWorld }) => initCommand(argv.slice(1), liveInitWorld()))
    .then(
      (code) => {
        process.exitCode = code;
      },
      (err: unknown) => {
        const error = err as Error;
        console.error(error.message || String(err));
        if (process.env["LINGTAI_DEBUG"]) console.error(error.stack);
        process.exitCode = 1;
      },
    );
} else if ((INSTALL_COMMANDS as readonly string[]).includes(argv[0] ?? "")) {
  installCommand(argv, liveWorld()).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      const error = err as Error;
      console.error(error.message || String(err));
      if (process.env["LINGTAI_DEBUG"]) console.error(error.stack);
      process.exitCode = 1;
    },
  );
} else {
  void import("./lingtai.ts");
}

function liveWorld(): World {
  return {
    env: process.env,
    self: import.meta.filename,
    fetch: (input, init) => fetch(input, init),
    log: (line) => console.log(line),
    ask: async (question) => {
      if (!process.stdin.isTTY) {
        console.log("there is nobody at a terminal to ask — --yes answers for you, once you have read what it removes");
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
    conducting: async () => {
      try {
        databaseUrl();
      } catch {
        return null;
      }
      const daemon = await import("@lingtai/daemon");
      return daemon.conductorLockHolder();
    },
    drain: liveDrain,
    app: liveApp,
    logConfigured: () => {
      try {
        return Boolean(databaseUrl());
      } catch {
        return false;
      }
    },
  };
}

/**
 * `lingtai shutdown`'s drain, and `lingtai restart`'s wait on the lock, before
 * the shim moves (0042). Imported here, because it is the log.
 *
 * `lingtai restart` itself is not called: it refuses a start that has no
 * checkout to name a commit from, which every installed copy is, and it starts
 * a daemon in this terminal, which an upgrade has no business holding.
 */
async function liveDrain(reason: string, despiteDoctor: boolean): Promise<Drained> {
  try {
    databaseUrl();
  } catch {
    console.log("no log is configured here, so nothing conducts from it — nothing to drain");
    return { ok: true, after: async () => {} };
  }
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
