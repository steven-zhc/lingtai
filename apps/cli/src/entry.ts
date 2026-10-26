#!/usr/bin/env node
/**
 * `lingtai` — the entry, in front of `lingtai.ts`.
 *
 * **Some commands answer before the rest is imported** (#184, #186): `version`,
 * `upgrade`, `rollback`, `uninstall`, `init` and `add`, all of which `cli.ts` parses (#620, #625). `lingtai.ts`'s many commands
 * all assume a database is already configured, and read or write the log
 * close to where they start. Since #179, importing `@lingtai/event-store`
 * does not itself build a client — the barrel hands out a deferred view, and
 * the client opens at the first `append`, `read` or `readAll` — so what these
 * five avoid is not a throw at import time but calling into a log with
 * nothing configured yet: `version`/`upgrade`/`rollback`/`uninstall` touch no
 * log at all (`install.ts`), and `init` is what writes the store
 * `~/.lingtai/config.yml` names before it ever reads one (`init.ts`'s own
 * header, #394). So these are dispatched from here, and every other command
 * is `lingtai.ts`, unchanged.
 *
 * A dynamic `import()` and not a static one, since a static import is evaluated
 * before a line of this file runs; esbuild keeps it lazy in the CJS bundle.
 */
import { helpCommand } from './help.ts'
import { routeOf } from './migrated.ts'

const argv = process.argv.slice(2)

const route = routeOf(argv)

if (route === 'effect') {
  // A migrated command is parsed and helped by `@effect/cli` (#616); everything else falls through.
  void import('./cli.ts')
    .then(({ runCli }) => runCli(process.argv))
    .then((code) => {
      // `init` may have started the board in this process, and its listening
      // socket holds the event loop open past `process.exitCode` (#394 finding
      // 1): a refusal reached after that cannot rely on it. Every refusal of
      // init's is safe to `process.exit` on, and it is never reached on
      // success, which is what "the board keeps running in this terminal"
      // promises. Not the rule for every command — `doctor --json` may still
      // be writing to a pipe.
      if (code !== 0 && argv[0] === 'init') process.exit(code)
      process.exitCode = code
    })
} else if (route === 'help') {
  // From the definitions alone (0121 §8): no project, no log, no network.
  process.exitCode = helpCommand(argv)
} else {
  void import('./lingtai.ts')
}
