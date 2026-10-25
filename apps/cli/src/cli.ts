/**
 * The `@effect/cli` side of the entry (#616). Loaded by `entry.ts` with a
 * dynamic `import()` and only for a command in `MIGRATED_COMMANDS`, so every
 * other command pays nothing for it and is parsed exactly as before.
 */
import { Args, Command, Options } from '@effect/cli'
import * as NodeContext from '@effect/platform-node/NodeContext'
import { coloured } from '@lingtai/env/colour'
import { Console, Effect } from 'effect'

import { definitionOf } from './commands.ts'
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
).pipe(Command.withDescription(definitionOf('version').task))

/** What a handler sets when it fails on its own: `runCli` resolves to it, as the exit code. */
let handlerCode = 0

const status = Command.make(
  'status',
  { project: Args.text({ name: 'project' }).pipe(Args.optional), all: Options.boolean('all'), json, noColor },
  (args) =>
    Effect.promise(async () => {
      if (args.noColor) applyNoColor()
      // Loaded here and not at the top: `lingtai version` is what `upgrade` spawns, and it must not
      // pay for the conductor, the projector and the store (`entry.ts`).
      try {
        const { readStatus, renderStatus, statusJson } = await import('./status.ts')
        const project = args.project._tag === 'Some' ? args.project.value : undefined
        const report = await readStatus({ project, all: args.all })
        if (args.json) printJson('status', statusJson(report))
        else
          for (const line of renderStatus(report, { all: args.all, columns: process.stdout.columns })) console.log(line)
      } catch (err) {
        const message = (err as Error).message || String(err)
        if (args.json) handlerCode = printJsonError('status', 'unavailable', message)
        else {
          console.error(message)
          if (process.env['LINGTAI_DEBUG']) console.error((err as Error).stack)
          else console.error('(LINGTAI_DEBUG=1 for the stack)')
          handlerCode = 1
        }
      }
    }),
).pipe(Command.withDescription(definitionOf('status').task))

const root = Command.make('lingtai').pipe(Command.withSubcommands([version, status]))

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

/** `--json`, or `--json=true` and the other spellings of true `@effect/cli` accepts for a boolean. */
function jsonOn(arg: string): boolean {
  if (arg === '--json') return true
  if (!arg.startsWith('--json=')) return false
  return ['true', 'yes', 'y', 'on', '1'].includes(arg.slice('--json='.length).toLowerCase())
}

/** `argv` is the full `process.argv` shape; resolves to the exit code. */
export async function runCli(argv: readonly string[]): Promise<number> {
  const args = argv.slice(2)
  if (args.includes('--no-color')) applyNoColor()
  const json = args.some(jsonOn)
  const errors: string[] = []
  handlerCode = 0
  const code = await Effect.runPromise(
    Effect.flatMap(Effect.console, (base) => run(argv).pipe(Effect.withConsole(consoleFor(base, json, errors)))).pipe(
      Effect.provide(NodeContext.layer),
      Effect.map(() => handlerCode),
      Effect.catchAllCause(() => Effect.succeed(1)),
    ),
  )
  // A handler that failed on its own has already said so; `usage` is for what did not parse.
  if (code !== 0 && json && handlerCode === 0) {
    const command = args.find((a) => !a.startsWith('-')) ?? 'lingtai'
    return printJsonError(command, 'usage', errors.join('\n') || 'invalid usage')
  }
  return code
}
