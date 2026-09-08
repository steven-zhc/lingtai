/**
 * `lingtai env` — put a value where a project can find it, and say what is there.
 *
 * `~/.lingtai/env/<project>.env` is where a project's values live
 * ([0021](../../../doc/decisions/0021-the-recipe-decides-the-environment.md)),
 * and `doctor` has always named the file. Naming it left four things to get
 * right for one key and one value — the directory exists, the filename, dotenv
 * syntax, `chmod 600` — and the failure of each was the same: a project that
 * silently keeps refusing (`#62`).
 *
 * Two rules shape what is here, and both are about what a terminal remembers.
 *
 * **`list` prints names and their layer, never values**, the same rule
 * `doctor` keeps: a command that echoes a secret is a command someone runs
 * during a screen share.
 *
 * **`set` with no value reads stdin, unechoed**, which is the case worth
 * having — it keeps a connection string out of shell history, which is where
 * the last copy of a credential usually ends up.
 *
 * There is deliberately no `--from-file`. Copying an application's `.env`
 * wholesale is exactly how a `PROD_DATABASE_URL` reaches an agent; a value at a
 * time is the point, not an inconvenience to be optimised away.
 */
import {
  type ProjectEnvListing,
  projectEnvNames,
  setProjectEnv,
  unsetProjectEnv,
} from "@lingtai/agent-env";

const USAGE = `lingtai env set <project> KEY=VALUE   write or replace one value
lingtai env set <project> KEY         read the value from stdin, unechoed
lingtai env list <project>            names and where each came from
lingtai env unset <project> KEY       remove one`;

/**
 * Names, layers, and no values — asserted by a test, because this is the
 * function a screen share is pointed at.
 */
export function formatEnvList(listing: ProjectEnvListing): string {
  const deferred = new Set(listing.deferred);
  if (listing.names.length === 0) {
    return `no names — nothing in ${listing.file}, and the machine's own file offers none`;
  }

  const width = Math.max(...listing.names.map((n) => n.name.length));
  const lines = listing.names.map((n) => {
    const where = deferred.has(n.name)
      ? 'project file — asks for a secret source (a "!" value), which is not built yet'
      : n.layer;
    return `  ${n.name.padEnd(width)}  ${where}`;
  });
  return [`${listing.file} · ${listing.names.length} name(s), values never shown`, ...lines].join("\n");
}

/**
 * A value from stdin with nothing echoed and nothing kept.
 *
 * On a terminal the tty is put in raw mode so the characters never reach the
 * screen; off one — a pipe, a heredoc, CI — the whole of stdin is the value,
 * minus the newline the shell adds. Both are the same promise: the value is
 * never a word in a command line, so it is never in shell history.
 */
async function readValueFromStdin(name: string): Promise<string> {
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    stdin.setEncoding("utf8");
    let data = "";
    for await (const chunk of stdin) data += chunk as string;
    return data.replace(/\r?\n$/, "");
  }

  process.stderr.write(`value for ${name} (not echoed): `);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    const done = (finish: () => void) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      finish();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        // Enter, or EOT: that is the value.
        if (ch === "\n" || ch === "\r" || ch === "\u0004") return done(() => resolve(buffer));
        // Ctrl-C has to stay Ctrl-C — raw mode means nobody else will deliver it.
        if (ch === "\u0003") return done(() => reject(new Error("cancelled — nothing was written")));
        if (ch === "\u007f" || ch === "\b") {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += ch;
      }
    };
    stdin.on("data", onData);
  });
}

export async function envCommand(args: string[]): Promise<number> {
  const [sub, project, ...rest] = args;

  if (!sub || !project) {
    console.error(USAGE);
    return 2;
  }

  if (sub === "list") {
    console.log(formatEnvList(await projectEnvNames({ project })));
    return 0;
  }

  if (sub === "set") {
    const argument = rest[0];
    if (!argument) {
      console.error(USAGE);
      return 2;
    }
    // The first `=` and no other: a value may hold as many as it likes, and
    // splitting on all of them is how a base64 secret loses its padding.
    const eq = argument.indexOf("=");
    const name = eq === -1 ? argument : argument.slice(0, eq);
    const value = eq === -1 ? await readValueFromStdin(name) : argument.slice(eq + 1);

    const { file, created, replaced } = await setProjectEnv({ project, name, value });
    console.log(`${name} ${replaced ? "replaced in" : "written to"} ${file}${created ? " (created, 0600)" : ""}`);
    return 0;
  }

  if (sub === "unset") {
    const name = rest[0];
    if (!name) {
      console.error(USAGE);
      return 2;
    }
    const { file, removed } = await unsetProjectEnv({ project, name });
    console.log(removed ? `${name} removed from ${file}` : `${name} was not set in ${file}`);
    // Non-zero for a name that was not there: "I removed it" and "there was
    // nothing to remove" are different answers, and the second is the one you
    // want to hear about when you have spelled the name wrong.
    return removed ? 0 : 1;
  }

  console.error(USAGE);
  return 2;
}
