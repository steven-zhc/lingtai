#!/usr/bin/env node
/**
 * `lingtai` — the entry, in front of `lingtai.ts`.
 *
 * **Five commands answer before the rest is imported** (#184, #186): `version`,
 * `upgrade`, `rollback`, `uninstall` and `init`. `lingtai.ts`'s many commands
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
import { installCommand } from './install.ts'
import { routeOf } from './migrated.ts'
// Neither reaches the log: `world.ts` loads `@lingtai/env` and nothing else.
import { liveWorld } from './world.ts'

const argv = process.argv.slice(2)

const route = routeOf(argv)

if (route === 'effect') {
  // A migrated command is parsed and helped by `@effect/cli` (#616); everything else falls through.
  void import('./cli.ts')
    .then(({ runCli }) => runCli(process.argv))
    .then((code) => {
      process.exitCode = code
    })
} else if (route === 'help') {
  // From the definitions alone (0121 §8): no project, no log, no network.
  process.exitCode = helpCommand(argv)
} else if (route === 'init') {
  // Only once asked: `init.ts` loads the board's server module, and no other command here needs it.
  import('./init.ts')
    .then(({ initCommand, liveInitWorld }) => initCommand(argv.slice(1), liveInitWorld()))
    .then(
      (code) => {
        // A refusal reached after `initCommand` has started serving the board
        // in this process cannot rely on `process.exitCode` alone: the
        // board's listening socket holds the event loop open past it (#394
        // finding 1). Before #394, every refusal preceded the board, so a
        // non-zero code never raced a bound socket; `process.exit` is safe on
        // every one of those same paths too, and is never reached on success,
        // which is what "the board keeps running in this terminal" promises.
        if (code === 0) process.exitCode = code
        else process.exit(code)
      },
      (err: unknown) => {
        const error = err as Error
        console.error(error.message || String(err))
        if (process.env['LINGTAI_DEBUG']) console.error(error.stack)
        process.exit(1)
      },
    )
} else if (route === 'install') {
  installCommand(argv, liveWorld(import.meta.filename)).then(
    (code) => {
      process.exitCode = code
    },
    (err: unknown) => {
      const error = err as Error
      console.error(error.message || String(err))
      if (process.env['LINGTAI_DEBUG']) console.error(error.stack)
      process.exitCode = 1
    },
  )
} else {
  void import('./lingtai.ts')
}
