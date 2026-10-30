#!/usr/bin/env node
/**
 * `lingtai` — the entry, and the one door to the one parser, `cli.ts` (`@effect/cli`).
 *
 * **Some commands answer before the rest is imported** (#184, #186): `version`,
 * `upgrade`, `rollback`, `uninstall`, `init` and `add` touch no log, or write the store
 * before they read one, so `cli.ts` is imported lazily and a database nothing has
 * configured yet is never called into by importing it.
 *
 * A dynamic `import()` and not a static one, since a static import is evaluated
 * before a line of this file runs; esbuild keeps it lazy in the CJS bundle.
 */
import { finish } from './ending.ts'
import { helpCommand, unknownCommand } from './help.ts'
import { routeOf, versionFlagAsCommand } from './migrated.ts'

const argv = versionFlagAsCommand(process.argv.slice(2))

const route = routeOf(argv)

if (route === 'effect') {
  void import('./cli.ts')
    .then(async ({ runCli }) => {
      // Already imported by `cli.ts`, so this loads nothing new; dynamic so
      // that help and unknown commands never touch the store.
      const { closeProcessLog } = await import('@lingtai/event-store')
      return finish(
        () => runCli([...process.argv.slice(0, 2), ...argv]),
        closeProcessLog,
        (code) => {
          // The close gave up with its socket still open, which would hold the
          // process past the budget; leave once what is already written is out.
          process.exitCode = code
          process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
        },
      )
    })
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
    .catch(reportEnding)
} else if (route === 'help') {
  // From the definitions alone (0121 §8): no project, no log, no network.
  process.exitCode = helpCommand(argv)
} else {
  process.exitCode = unknownCommand(argv[0]!)
}

/**
 * Every ending is a sentence, not a stack trace.
 *
 * The commands report their own refusals and return an exit code, but anything
 * that *throws* went straight to Node — which printed a stack, a file path and
 * a version banner over the one line that mattered.
 *
 * The stack is still there for the errors that are bugs rather than refusals;
 * it just has to be asked for.
 *
 * A promise and not a top-level `await`: `pnpm build` bundles this file to CJS
 * for a SEA (#183), and CJS has no top-level `await`.
 */
function reportEnding(err: unknown): void {
  const error = err as Error
  console.error(error.message || String(err))
  if (process.env['LINGTAI_DEBUG']) console.error(error.stack)
  else console.error('\n(LINGTAI_DEBUG=1 for the stack)')
  process.exitCode = 1
}
