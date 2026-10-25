/**
 * The `@effect/cli` side of the entry (#616). Loaded by `entry.ts` with a
 * dynamic `import()` and only for a command in `MIGRATED_COMMANDS`, so every
 * other command pays nothing for it and is parsed exactly as before.
 */
import { Command, Options } from '@effect/cli'
import * as NodeContext from '@effect/platform-node/NodeContext'
import { Effect } from 'effect'

import { applyNoColor, printJson } from './output.ts'
import { versionFacts, versionLine } from './version.ts'

const json = Options.boolean('json')
const noColor = Options.boolean('no-color')

const version = Command.make('version', { json, noColor }, (args) =>
  Effect.sync(() => {
    if (args.noColor) applyNoColor()
    // The plain line is what `upgrade` parses from the new binary: no heading, no colour.
    if (args.json) printJson('version', versionFacts())
    else process.stdout.write(`${versionLine()}\n`)
  }),
)

const root = Command.make('lingtai').pipe(Command.withSubcommands([version]))

const run = Command.run(root, { name: 'lingtai', version: versionFacts().lingtai })

/** `argv` is the full `process.argv` shape; resolves to the exit code. */
export function runCli(argv: readonly string[]): Promise<number> {
  return Effect.runPromise(
    run(argv).pipe(
      Effect.provide(NodeContext.layer),
      Effect.as(0),
      Effect.catchAllCause(() => Effect.succeed(1)),
    ),
  )
}
