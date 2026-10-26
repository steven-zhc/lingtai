/**
 * The `@effect/cli` side of the entry (#616). Loaded by `entry.ts` with a
 * dynamic `import()` and only for a command in `MIGRATED_COMMANDS`, so every
 * other command pays nothing for it and is parsed exactly as before.
 */
import { Args, Command, Options } from '@effect/cli'
import * as NodeContext from '@effect/platform-node/NodeContext'
import { coloured } from '@lingtai/env/colour'
import { Console, Effect } from 'effect'

import type { BoardVerb } from './board.ts'
import { definitionOf } from './commands.ts'
import { applyNoColor, printJson, printJsonError, stripColour, symbol } from './output.ts'
import { refusal, renderVerdict, VERBS, verdictJson, type Answered } from './verdict.ts'
import { versionFacts, versionLine } from './version.ts'
import { addOptions, flagsOf, initOptions, valuelessFlag } from './wizard-options.ts'

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

/** A handler that could not produce its report: the error document under `--json`, the message otherwise. Returns the exit code. */
function failed(command: string, asJson: boolean, err: unknown): number {
  const message = (err as Error).message || String(err)
  if (asJson) return printJsonError(command, 'unavailable', message)
  console.error(message)
  if (process.env['LINGTAI_DEBUG']) console.error((err as Error).stack)
  else console.error('(LINGTAI_DEBUG=1 for the stack)')
  return 1
}

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
        handlerCode = failed('status', args.json, err)
      }
    }),
).pipe(Command.withDescription(definitionOf('status').task))

const doctor = Command.make('doctor', { json, noColor }, (args) =>
  Effect.promise(async () => {
    if (args.noColor) applyNoColor()
    try {
      // Loaded here, for the reason `status` gives.
      const { doctorReport, doctorJson, renderDoctor, tally } = await import('./doctor.ts')
      const { releaseCheck } = await import('./install.ts')
      const report = await doctorReport()
      // Here and not in `runDoctor`, which `lingtai restart` gates on: the one
      // outbound request this tool makes is asked by `doctor` and `upgrade` (#184),
      // and a restart is neither.
      report.results.push(await releaseCheck({ fetch, env: process.env, self: import.meta.filename }))
      Object.assign(report, tally(report.results))
      if (args.json) printJson('doctor', doctorJson(report))
      else for (const line of renderDoctor(report)) console.log(line)
      // Non-zero on any failure. `lingtai restart` runs the same report (0042) but
      // does not refuse on the same number: a failure marked `restartAnswers` exits
      // this 1 and lets a restart through — see `gatingFailures`. A deferred check
      // is not a failure; a missing one would be.
      handlerCode = report.failed === 0 ? 0 : 1
    } catch (err) {
      handlerCode = failed('doctor', args.json, err)
    }
  }),
).pipe(Command.withDescription(definitionOf('doctor').task))

/** A wizard that threw: the message, as the hand-rolled entry printed it, and exit 1. */
function wizardFailed(err: unknown): number {
  const error = err as Error
  console.error(error.message || String(err))
  if (process.env['LINGTAI_DEBUG']) console.error(error.stack)
  return 1
}

// Loaded in the handler and not at the top, for the reason `status` gives; `init` also
// loads the board's server module, which no other command needs.
const init = Command.make('init', initOptions, (args) =>
  Effect.promise(async () => {
    try {
      const { initCommand, liveInitWorld } = await import('./init.ts')
      handlerCode = await initCommand(flagsOf(args), liveInitWorld())
    } catch (err) {
      handlerCode = wizardFailed(err)
    }
  }),
).pipe(Command.withDescription(definitionOf('init').task))

const add = Command.make(
  'add',
  { repo: Args.text({ name: 'owner/repo' }).pipe(Args.optional), ...addOptions },
  ({ repo, ...options }) =>
    Effect.promise(async () => {
      try {
        const { addFlow, liveAddWorld } = await import('./add.ts')
        handlerCode = await addFlow(
          { positional: repo._tag === 'Some' ? repo.value : undefined, ...flagsOf(options) },
          liveAddWorld(),
        )
      } catch (err) {
        handlerCode = wizardFailed(err)
      }
    }),
).pipe(Command.withDescription(definitionOf('add').task))

/** Where a wait-answering command's progress goes: stdout, or stderr so `--json` keeps stdout to its one document. */
function progressFor(asJson: boolean): (line: string) => void {
  return asJson ? (line) => console.error(line) : (line) => console.log(line)
}

/** Runs one of the `<verb>Verdict` functions and prints what it answered (#621). */
function answerWith(
  command: keyof typeof VERBS,
  args: { json: boolean; noColor: boolean },
  run: (progress: (line: string) => void) => Promise<Answered>,
) {
  return Effect.promise(() => printAnswer(command, args, run))
}

async function printAnswer(
  command: keyof typeof VERBS,
  args: { json: boolean; noColor: boolean },
  run: (progress: (line: string) => void) => Promise<Answered>,
): Promise<void> {
  if (args.noColor) applyNoColor()
  try {
    const answered = await run(progressFor(args.json))
    if (args.json) printJson(command, verdictJson(answered.verdict))
    else
      for (const line of renderVerdict(
        answered.verdict.outcome === 'accepted' ? VERBS[command].accepted : VERBS[command].refused,
        answered.verdict,
      ))
        console.log(line)
    handlerCode = answered.code
  } catch (err) {
    handlerCode = failed(command, args.json, err)
  }
}

const projectArg = Args.text({ name: 'project' })
const issueOption = Options.integer('issue')
const optionalText = (name: string) => Options.text(name).pipe(Options.optional)
const given = (o: { _tag: string; value?: string }): string | undefined => (o._tag === 'Some' ? o.value : undefined)
/** Everything after the project is the sentence, so an unquoted one still arrives whole. */
const sentenceArg = Args.text({ name: 'text' }).pipe(Args.repeated)

const approve = Command.make(
  'approve',
  {
    project: projectArg,
    issue: issueOption,
    note: optionalText('note'),
    reject: Options.boolean('reject'),
    json,
    noColor,
  },
  (args) =>
    answerWith('approve', args, async (progress) => {
      if (args.reject) {
        // Gone (#150): it revoked the approval and put the run straight back
        // into `awaiting-approval`, so the wait it seemed to end went on.
        return refusal(2, 'removed-flag', '--reject is gone: it asked the same question again and ended nothing.', {
          next: `lingtai requeue ${args.project} --issue ${args.issue}`,
        })
      }
      const { approveVerdict } = await import('./approve.ts')
      return approveVerdict({ project: args.project, issue: args.issue, note: given(args.note) }, progress)
    }),
).pipe(Command.withDescription(definitionOf('approve').task))

const requeue = Command.make(
  'requeue',
  {
    project: projectArg,
    issue: issueOption,
    note: optionalText('note'),
    intoBody: optionalText('into-body'),
    json,
    noColor,
  },
  (args) =>
    answerWith('requeue', args, async (progress) => {
      const { requeueVerdict } = await import('./requeue.ts')
      return requeueVerdict(
        {
          project: args.project,
          issue: args.issue,
          // `--note` left off and `--note` with nothing after it both mean `""` (#424).
          note: given(args.note) ?? '',
          ...(args.intoBody._tag === 'Some' ? { intoBody: args.intoBody.value } : {}),
        },
        progress,
      )
    }),
).pipe(Command.withDescription(definitionOf('requeue').task))

const grantFixRound = Command.make(
  'grant-fix-round',
  { project: projectArg, issue: issueOption, ifHead: optionalText('if-head'), json, noColor },
  (args) =>
    answerWith('grant-fix-round', args, async (progress) => {
      const { grantFixRoundVerdict } = await import('./grant-fix-round.ts')
      return grantFixRoundVerdict({ project: args.project, issue: args.issue, ifHead: given(args.ifHead) }, progress)
    }),
).pipe(Command.withDescription(definitionOf('grant-fix-round').task))

const close = Command.make(
  'close',
  { project: projectArg, issue: issueOption, text: sentenceArg, json, noColor },
  (args) =>
    answerWith('close', args, async (progress) => {
      const { closeVerdict } = await import('./close.ts')
      return closeVerdict({ project: args.project, issue: args.issue, reason: args.text.join(' ') }, progress)
    }),
).pipe(Command.withDescription(definitionOf('close').task))

const ask = Command.make('ask', { project: projectArg, issue: issueOption, text: sentenceArg, json, noColor }, (args) =>
  answerWith('ask', args, async (progress) => {
    const { askVerdict } = await import('./ask.ts')
    return askVerdict({ project: args.project, issue: args.issue, text: args.text.join(' ') }, progress)
  }),
).pipe(Command.withDescription(definitionOf('ask').task))

const answer = Command.make(
  'answer',
  { project: projectArg, issue: issueOption, text: sentenceArg, json, noColor },
  (args) =>
    answerWith('answer', args, async (progress) => {
      const { answerVerdict } = await import('./ask.ts')
      return answerVerdict({ project: args.project, issue: args.issue, text: args.text.join(' ') }, progress)
    }),
).pipe(Command.withDescription(definitionOf('answer').task))

const now = Command.make(
  'now',
  {
    project: projectArg,
    second: Args.text({ name: 'issue' }).pipe(Args.optional),
    issue: Options.integer('issue').pipe(Options.optional),
    json,
    noColor,
  },
  (args) =>
    answerWith('now', args, async () => {
      const issue = args.issue._tag === 'Some' ? args.issue.value : Number(given(args.second) ?? Number.NaN)
      if (!Number.isInteger(issue)) return refusal(2, 'usage', 'lingtai now <project> --issue <n>')
      const { nowVerdict } = await import('./now.ts')
      return nowVerdict(args.project, issue, `human:${process.env['USER'] ?? 'operator'}`)
    }),
).pipe(Command.withDescription(definitionOf('now').task))

/** What was typed after `board`: `port` and `dir` are null where nothing was, and the runner resolves them. */
export interface BoardRequest {
  verb: BoardVerb
  port: number | null
  dir: string | null
  open: boolean
  json: boolean
}

/** Runs one request and resolves to the exit code. A test hands `runCli` its own; the live one is below. */
export type BoardRunner = (request: BoardRequest) => Promise<number>

const BOARD_USAGE = 'lingtai board start|stop|restart|status [--port <n>] [--dir <path>] [--no-open]'

async function liveBoardRunner(request: BoardRequest): Promise<number> {
  const { boardCommand, builtBoardDir, boardStatusJson, readBoardStatus } = await import('./board.ts')
  const { liveBoardWorld } = await import('./board-world.ts')
  const { boardPort } = await import('@lingtai/env')
  // `--port` is this run's; without it the machine file's, and without that
  // 17820 (#187). A file that does not parse is refused by name here rather
  // than serving on a port nobody chose.
  let port: number
  try {
    port = request.port ?? boardPort()
  } catch (err) {
    return failed('board', request.json, err)
  }
  const world = liveBoardWorld()
  if (request.verb === 'status' && request.json) {
    printJson('board status', boardStatusJson(await readBoardStatus({ port }, world)))
    return 0
  }
  return boardCommand({ verb: request.verb, port, dir: request.dir ?? builtBoardDir(), open: request.open }, world)
}

let boardRunner: BoardRunner = liveBoardRunner

const portOption = Options.integer('port').pipe(Options.optional)
const dirOption = Options.text('dir').pipe(Options.optional)
const noOpen = Options.boolean('no-open')

/** Checked here and not by the parser, which reads `--port 99999` as an integer: the sentence has always been this one. */
function boardHandler(verb: BoardVerb) {
  return (args: {
    port: { _tag: string; value?: number }
    dir?: { _tag: string; value?: string }
    noOpen?: boolean
    json?: boolean
    noColor?: boolean
  }) =>
    Effect.promise(async () => {
      if (args.noColor) applyNoColor()
      const asJson = args.json === true
      const port = args.port._tag === 'Some' ? args.port.value! : null
      if (port !== null && (port <= 0 || port > 65535)) {
        const sentence = `${BOARD_USAGE} — --port takes a port number`
        if (asJson) printJsonError('board', 'usage', sentence)
        else console.error(sentence)
        handlerCode = 2
        return
      }
      try {
        handlerCode = await boardRunner({
          verb,
          port,
          dir: args.dir?._tag === 'Some' ? args.dir.value! : null,
          open: !args.noOpen,
          json: asJson,
        })
      } catch (err) {
        handlerCode = failed('board', asJson, err)
      }
    })
}

const startOptions = { port: portOption, dir: dirOption, noOpen, noColor }
const boardStart = Command.make('start', startOptions, boardHandler('start'))
const boardRestart = Command.make('restart', startOptions, boardHandler('restart'))
const boardStop = Command.make('stop', { port: portOption, noColor }, boardHandler('stop'))
const boardStatus = Command.make('status', { port: portOption, json, noColor }, boardHandler('status'))

// The parent is `start` too: `lingtai board` and `lingtai board --port <n> --no-open` are what the
// wizard's last line, the release test and the service's job have always run.
const board = Command.make('board', startOptions, boardHandler('start')).pipe(
  Command.withDescription(definitionOf('board').task),
  Command.withSubcommands([boardStart, boardStop, boardRestart, boardStatus]),
)

const root = Command.make('lingtai').pipe(
  Command.withSubcommands([
    version,
    status,
    doctor,
    init,
    add,
    approve,
    requeue,
    grantFixRound,
    close,
    ask,
    answer,
    now,
    board,
  ]),
)

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

/**
 * What `--name` is followed by: `undefined` when the flag is absent, `null` when it
 * has nothing after it (the end of the line, or another flag), else the text.
 */
function flagValue(args: readonly string[], name: string): string | null | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3)
    if (arg === `--${name}`) {
      const next = args[i + 1]
      return next === undefined || next.startsWith('--') ? null : next
    }
  }
  return undefined
}

/** The sentences a flag with no value has always been refused with, and exit 2 (#621). */
const TAKES: Record<string, { flag: string; sentence: string; trimmed: boolean }[]> = {
  requeue: [{ flag: 'into-body', sentence: '--into-body takes text', trimmed: true }],
  'grant-fix-round': [{ flag: 'if-head', sentence: '--if-head takes the displayed commit SHA', trimmed: false }],
}

/** `--note` with nothing after it means what leaving it off means, `""` (#424), so it is dropped before parsing. */
function withoutBareNote(args: readonly string[]): string[] {
  return args.filter((arg, i) => arg !== '--note' || !(args[i + 1] === undefined || args[i + 1]!.startsWith('--')))
}

/** `argv` is the full `process.argv` shape; resolves to the exit code. */
export async function runCli(argv: readonly string[], deps: { board?: BoardRunner } = {}): Promise<number> {
  const args = argv.slice(2)
  boardRunner = deps.board ?? liveBoardRunner
  if (args[0] === 'board' && args[1] === 'shutdown') {
    const sentence =
      'lingtai board shutdown does not exist — shutdown means finish the pass in flight, and waits as long as the ' +
      'wall limit for it. A board has no pass to finish: pnpm lingtai board stop, which returns at once'
    if (args.some(jsonOn)) printJsonError('board', 'usage', sentence)
    else console.error(`${symbol.fail()} ${sentence}`)
    return 2
  }
  for (const { flag, sentence, trimmed } of TAKES[args[0] ?? ''] ?? []) {
    const value = flagValue(args.slice(1), flag)
    if (value !== undefined && !(trimmed ? value?.trim() : value)) {
      if (args.some(jsonOn)) printJsonError(args[0]!, 'usage', sentence)
      else console.error(sentence)
      return 2
    }
  }
  if (args[0] === 'approve' || args[0] === 'requeue') {
    argv = [...argv.slice(0, 2), ...withoutBareNote(args)]
  }
  if (args.includes('--no-color')) applyNoColor()
  const json = args.some(jsonOn)
  if (args[0] === 'init' || args[0] === 'add') {
    const valueless = valuelessFlag(args.slice(1))
    if (valueless !== null) {
      console.error(`lingtai ${args[0]}: --${valueless} takes a value`)
      return 1
    }
  }
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
