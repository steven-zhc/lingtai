/**
 * The `@effect/cli` side of the entry (#616). Loaded by `entry.ts` with a
 * dynamic `import()` and only for a command in `MIGRATED_COMMANDS`, so every
 * other command pays nothing for it and is parsed exactly as before.
 */
import { Args, Command, Options } from '@effect/cli'
import * as NodeContext from '@effect/platform-node/NodeContext'
import { coloured, paint } from '@lingtai/env/colour'
import { Console, Effect } from 'effect'

import { definitionOf } from './commands.ts'
import { applyNoColor, printJson, printJsonError, stripColour, symbol } from './output.ts'
import { parseRestartArgs, type RestartArgs } from './restart.ts'
import { createSteps } from './steps.ts'
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

// ------------------------------------------------------- the daemon commands --
//
// (#622) `start`, `daemon`, `service`, `restart`, `shutdown`, `pause` and `resume`. Their code
// lives in `daemon.ts`, which has no side effects at import: `lingtai.ts` runs `main` when it
// is loaded, and the supervisor's plist still runs that file with `daemon`.

/** Every handler here ends the same way: a thrown error is a sentence and exit 1. */
function daemonHandler(args: { noColor: boolean }, run: () => Promise<number>) {
  return Effect.promise(async () => {
    if (args.noColor) applyNoColor()
    try {
      handlerCode = await run()
    } catch (err) {
      handlerCode = wizardFailed(err)
    }
  })
}

const startFlags = { noConduct: Options.boolean('no-conduct'), noMerge: Options.boolean('no-merge'), noColor }

function startCommand(name: 'start' | 'daemon') {
  return Command.make(name, startFlags, (args) =>
    daemonHandler(args, async () => {
      const { daemonCommand } = await import('./daemon.ts')
      const flags: Record<string, string> = {
        ...(args.noConduct ? { 'no-conduct': '' } : {}),
        ...(args.noMerge ? { 'no-merge': '' } : {}),
      }
      // Said when the lock is won; a daemon that did not start has said why, and says nothing more.
      // `another daemon holds the lock — nothing to do` stays a quiet line, not a failure (0121 §1).
      return daemonCommand(flags, null, name === 'start' ? () => console.log(`${symbol.pass()} started`) : null)
    }),
  ).pipe(Command.withDescription(definitionOf(name).task))
}

const whyArg = Args.text({ name: 'why' }).pipe(Args.repeated)
const reasonOption = optionalText('reason')

const pause = Command.make('pause', { why: whyArg, reason: reasonOption, noColor }, (args) =>
  daemonHandler(args, async () => {
    const { controlCommand } = await import('./daemon.ts')
    return controlCommand('pause', { reason: given(args.reason) ?? args.why.join(' ') })
  }),
).pipe(Command.withDescription(definitionOf('pause').task))

const resume = Command.make('resume', { noColor }, (args) =>
  daemonHandler(args, async () => {
    const { controlCommand } = await import('./daemon.ts')
    return controlCommand('resume', {})
  }),
).pipe(Command.withDescription(definitionOf('resume').task))

const shutdown = Command.make(
  'shutdown',
  { why: whyArg, reason: reasonOption, force: Options.boolean('force'), timeout: optionalText('timeout'), noColor },
  (args) =>
    daemonHandler(args, async () => {
      const { controlCommand } = await import('./daemon.ts')
      return controlCommand('shutdown', {
        reason: given(args.reason) ?? args.why.join(' '),
        ...(args.timeout._tag === 'Some' ? { timeout: args.timeout.value } : {}),
        force: args.force,
      })
    }),
).pipe(Command.withDescription(definitionOf('shutdown').task))

/**
 * `lingtai restart`'s line, as `parseRestartArgs` read it (`runCli` reads it before `@effect/cli`
 * does, for the reason that function gives: a boolean must never consume the next word, or
 * `--dirty picking up #88` records `dirty: "picking"`). The flags are declared below for help and
 * for usage errors; the value that is acted on is this one.
 */
let restartArgs: RestartArgs | null = null

const restart = Command.make(
  'restart',
  {
    why: whyArg,
    reason: reasonOption,
    dirty: Options.boolean('dirty'),
    despiteDoctor: Options.boolean('despite-doctor'),
    force: Options.boolean('force'),
    timeout: optionalText('timeout'),
    noConduct: Options.boolean('no-conduct'),
    noMerge: Options.boolean('no-merge'),
    noColor,
  },
  (args) =>
    daemonHandler(args, async () => {
      const { restartCommand } = await import('./daemon.ts')
      return restartCommand(restartArgs!, createSteps(console.log))
    }),
).pipe(Command.withDescription(definitionOf('restart').task))

/** The `service` verbs, with their closing line (#622): `✓ <done>` on 0, `✗ not <verb>` otherwise. */
const SERVICE_DONE = {
  install: 'installed',
  start: 'started',
  shutdown: 'shut down',
  restart: 'restarted',
  uninstall: 'uninstalled',
} as const

function serviceVerb(verb: keyof typeof SERVICE_DONE) {
  const withWhy = verb === 'shutdown' || verb === 'restart'
  return Command.make(verb, { why: withWhy ? whyArg : Args.none, noColor }, (args) =>
    daemonHandler(args, async () => {
      const { serviceOptions } = await import('./daemon.ts')
      const { serviceCommand, SHUTDOWN_BOARD_ONLY, START_BOARD_ONLY } = await import('./service.ts')
      const why = Array.isArray(args.why) ? (args.why as string[]) : []
      const steps = createSteps(console.log)
      // `serviceCommand` begins the phases it has (draining, starting); these two have none of their own.
      if (verb === 'install') steps.begin('writing')
      if (verb === 'uninstall') steps.begin('removing')
      let unconfirmed = false // the supervisor already had a conductor process
      let boardHad = false // ...and a board process, so the board's start was not made either
      const code = await serviceCommand([verb, ...(why.length > 0 ? [why.join(' ')] : [])], {
        ...serviceOptions(),
        steps,
        unconfirmed: (job) => {
          if (job === 'conductor') unconfirmed = true
          else boardHad = true
        },
      })
      steps.end()
      if (unconfirmed && code === START_BOARD_ONLY)
        console.log(
          `${symbol.fail()} ${verb} — the supervisor already had a conductor process, so it was not confirmed, and the board did not start`,
        )
      else if (code === 0 && unconfirmed && !boardHad)
        console.log(
          paint.muted(
            `${verb}: the supervisor already had a conductor process, so it was not started or confirmed — the board was started`,
          ),
        )
      else if (code === 0 && unconfirmed)
        console.log(paint.muted(`${verb}: the supervisor already had a process, so nothing was started or confirmed`))
      else if (code === 0) console.log(`${symbol.pass()} ${SERVICE_DONE[verb]}`)
      else if (code === SHUTDOWN_BOARD_ONLY || code === START_BOARD_ONLY)
        console.log(`${symbol.fail()} ${verb} — the conductor did, the board did not`)
      else console.log(`${symbol.fail()} not ${verb === 'shutdown' ? 'shut down' : SERVICE_DONE[verb]}`)
      return code
    }),
  ).pipe(Command.withDescription(`${verb} the daemon and the board jobs`))
}

const serviceStatus = Command.make('status', { json, noColor }, (args) =>
  daemonHandler(args, async () => {
    const { serviceOptions } = await import('./daemon.ts')
    const { serviceCommand } = await import('./service.ts')
    return serviceCommand(['status'], { ...serviceOptions(), json: args.json })
  }),
).pipe(Command.withDescription('each job on its own: the supervisor, and whether it answers'))

const service = Command.make('service').pipe(
  Command.withDescription(definitionOf('service').task),
  Command.withSubcommands([
    serviceVerb('install'),
    serviceVerb('start'),
    serviceVerb('shutdown'),
    serviceVerb('restart'),
    serviceStatus,
    serviceVerb('uninstall'),
  ]),
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
    startCommand('start'),
    startCommand('daemon'),
    service,
    restart,
    shutdown,
    pause,
    resume,
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
export async function runCli(argv: readonly string[]): Promise<number> {
  const args = argv.slice(2)
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
  if (args[0] === 'service' && args[1] === 'stop') {
    // Gone rather than kept as an alias. It sent the supervisor's signal, and
    // launchd SIGKILLed the drain that began twenty seconds in (#174).
    console.error(
      "lingtai service stop is gone — it was the supervisor's signal, which kills a pass in flight 20 seconds in.",
    )
    console.error('pnpm lingtai service shutdown "why" drains through the log, waits for the pass, then unloads.')
    return 2
  }
  restartArgs = null
  if (args[0] === 'restart') {
    // Read first, and by the function that has always read this line: its refusals — `--anyway`,
    // `--timeout`, a flag this command does not have — are sentences with exit code 2.
    const parsed = parseRestartArgs(args.slice(1).filter((a) => a !== '--no-color'))
    if (!parsed.ok) {
      console.error(parsed.message)
      return 2
    }
    restartArgs = parsed.args
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
