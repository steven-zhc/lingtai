#!/usr/bin/env node
/**
 * `lingtai` — the entry, in front of `lingtai.ts`.
 *
 * **Five commands answer before the rest is imported** (#184, #186): `version`,
 * `upgrade`, `rollback`, `uninstall` and `init`. Everything `lingtai.ts` imports
 * loads `@lingtai/event-store`, whose client is built at module scope and throws
 * without a database URL — which a machine that has only just installed does
 * not have, one being uninstalled may no longer, and `init` is what gives it
 * one. So these are dispatched from here, and every other command is
 * `lingtai.ts`, unchanged.
 *
 * A dynamic `import()` and not a static one, since a static import is evaluated
 * before a line of this file runs; esbuild keeps it lazy in the CJS bundle.
 */
import { INSTALL_COMMANDS, installCommand } from "./install.ts";
// Neither reaches the log: `world.ts` loads `@lingtai/env` and nothing else.
import { liveWorld } from "./world.ts";

const argv = process.argv.slice(2);

if (argv[0] === "init") {
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
  installCommand(argv, liveWorld(import.meta.filename)).then(
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
