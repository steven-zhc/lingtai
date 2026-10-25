/**
 * The `@effect/cli` side of the entry (#616). Loaded by `entry.ts` with a
 * dynamic `import()` and only for a command in `MIGRATED_COMMANDS`, so every
 * other command pays nothing for it and is parsed exactly as before.
 */
import { Command, Options } from '@effect/cli'
import * as NodeContext from '@effect/platform-node/NodeContext'
import { coloured } from '@lingtai/env/colour'
import { Console, Effect } from 'effect'

import { applyNoColor, printJson, printJsonError, stripColour } from './output.ts'
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

/**
 * `@effect/cli` prints its own help and its own usage errors through `Console`,
 * so the two promises of 0121 are kept here: help is plain where colour is off,
 * and under `--json` a usage error is held back and becomes the one error document.
 */
function consoleFor(base: Console.Console, json: boolean, errors: string[]): Console.Console {
  const text = (stream: { isTTY?: boolean }, args: readonly unknown[]): string =>
    args.map((a) => (coloured(stream) ? String(a) : stripColour(String(a)))).join(' ')
  return {
    ...base,
    log: (...args) => Effect.sync(() => void process.stdout.write(`${text(process.stdout, args)}\n`)),
    error: (...args) =>
      Effect.sync(() => {
        if (json) errors.push(stripColour(args.map(String).join(' ')).trim())
        else process.stderr.write(`${text(process.stderr, args)}\n`)
      }),
  }
}

/** `argv` is the full `process.argv` shape; resolves to the exit code. */
export async function runCli(argv: readonly string[]): Promise<number> {
  const args = argv.slice(2)
  if (args.includes('--no-color')) applyNoColor()
  const json = args.includes('--json')
  const errors: string[] = []
  const code = await Effect.runPromise(
    Effect.flatMap(Effect.console, (base) => run(argv).pipe(Effect.withConsole(consoleFor(base, json, errors)))).pipe(
      Effect.provide(NodeContext.layer),
      Effect.as(0),
      Effect.catchAllCause(() => Effect.succeed(1)),
    ),
  )
  if (code !== 0 && json) {
    const command = args.find((a) => !a.startsWith('-')) ?? 'lingtai'
    return printJsonError(command, 'usage', errors.join('\n') || 'invalid usage')
  }
  return code
}
