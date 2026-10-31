/**
 * The `@effect/cli` side of the entry (#616). Loaded by `entry.ts` with a
 * dynamic `import()` and only for a command named in `commands.ts`, so a word
 * that is not one pays nothing for it. It is the only parser (#626).
 */
import { Args, Command, Options } from '@effect/cli'
import * as NodeContext from '@effect/platform-node/NodeContext'
import { coloured, paint } from '@lingtai/env/colour'
import { Console, Effect } from 'effect'

import type { BoardVerb } from './board.ts'
import { definitionOf, PROJECTION_NAMES, startIsVerbose } from './commands.ts'
import { USAGE as ENV_USAGE } from './env-usage.ts'
import { commandHelp } from './help.ts'
import { applyNoColor, heading, printJson, printJsonError, stripColour, symbol } from './output.ts'
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

const eventsCommand = Command.make(
  'events',
  { name: Args.text({ name: 'name' }).pipe(Args.optional), json, noColor },
  (args) =>
    Effect.promise(async () => {
      if (args.noColor) applyNoColor()
      // Loaded here, for the reason `status` gives: no other command parses the manifest.
      const { events, eventsJson, findEvent, renderEvent, renderEvents } = await import('./events.ts')
      if (args.name._tag === 'None') {
        if (args.json) printJson('events', eventsJson(events))
        else for (const line of renderEvents(events, { columns: process.stdout.columns })) console.log(line)
        return
      }
      const found = findEvent(events, args.name.value)
      if (found === undefined) {
        const message = `no event named ${args.name.value} — lingtai events lists them`
        if (args.json) handlerCode = printJsonError('events', 'unknown-event', message)
        else {
          console.error(`${symbol.fail()} ${message}`)
          handlerCode = 1
        }
      } else if (args.json) printJson('events', eventsJson(events, found))
      else for (const line of renderEvent(found)) console.log(line)
    }),
).pipe(Command.withDescription(definitionOf('events').task))

const doctor = Command.make('doctor', { json, noColor, verbose: Options.boolean('verbose') }, (args) =>
  Effect.promise(async () => {
    if (args.noColor) applyNoColor()
    try {
      // Loaded here, for the reason `status` gives.
      const { doctorReport, doctorJson, renderDoctor, tally } = await import('./doctor.ts')
      const { releaseCheck } = await import('./install.ts')
      const { doctorProgress } = await import('./steps.ts')
      const progress = doctorProgress({ stdout: process.stdout, stderr: process.stderr, json: args.json })
      let report
      try {
        report = await doctorReport({ onProgress: progress.onProgress })
        // Here and not in `runDoctor`, which `lingtai restart` gates on: the one
        // outbound request this tool makes is asked by `doctor` and `upgrade` (#184),
        // and a restart is neither. Timed here, since `runDoctor` never sees it.
        progress.onProgress({ label: 'releases', phase: 'start', done: report.results.length })
        const t0 = performance.now()
        const row = await releaseCheck({ fetch, env: process.env, self: import.meta.filename })
        report.results.push({ ...row, ms: Math.round(performance.now() - t0) })
        Object.assign(report, tally(report.results))
      } finally {
        progress.clear()
      }
      if (args.json) printJson('doctor', doctorJson(report))
      else for (const line of renderDoctor(report, { verbose: args.verbose })) console.log(line)
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

/**
 * Every integer flag, by the first word of argv: the one list the declarations and the pre-parse refusal both
 * read (#770). `@effect/cli` would answer a value that is not a number in its own words and name no flag.
 */
export const INTEGER_FLAGS = {
  approve: ['issue'],
  requeue: ['issue'],
  'grant-fix-round': ['issue'],
  ask: ['issue'],
  answer: ['issue'],
  close: ['issue'],
  now: ['issue'],
  run: ['issue', 'max'],
  end: ['issue'],
  board: ['port'],
} as const satisfies Record<string, readonly string[]>

const INTEGER_NOUN: Record<string, string> = { issue: 'an issue number', max: 'a number', port: 'a port number' }

/** The only way to declare an integer option, so a flag missing from `INTEGER_FLAGS` does not compile. */
function integerOption<C extends keyof typeof INTEGER_FLAGS>(command: C, flag: (typeof INTEGER_FLAGS)[C][number]) {
  void command
  return Options.integer(flag)
}
const optionalText = (name: string) => Options.text(name).pipe(Options.optional)
const given = (o: { _tag: string; value?: string }): string | undefined => (o._tag === 'Some' ? o.value : undefined)
/** Everything after the project is the sentence, so an unquoted one still arrives whole. */
const sentenceArg = Args.text({ name: 'text' }).pipe(Args.repeated)

const approve = Command.make(
  'approve',
  {
    project: projectArg,
    issue: integerOption('approve', 'issue'),
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
    issue: integerOption('requeue', 'issue'),
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
  {
    project: projectArg,
    issue: integerOption('grant-fix-round', 'issue'),
    ifHead: optionalText('if-head'),
    json,
    noColor,
  },
  (args) =>
    answerWith('grant-fix-round', args, async (progress) => {
      const { grantFixRoundVerdict } = await import('./grant-fix-round.ts')
      return grantFixRoundVerdict({ project: args.project, issue: args.issue, ifHead: given(args.ifHead) }, progress)
    }),
).pipe(Command.withDescription(definitionOf('grant-fix-round').task))

const close = Command.make(
  'close',
  { project: projectArg, issue: integerOption('close', 'issue'), text: sentenceArg, json, noColor },
  (args) =>
    answerWith('close', args, async (progress) => {
      const { closeVerdict } = await import('./close.ts')
      return closeVerdict({ project: args.project, issue: args.issue, reason: args.text.join(' ') }, progress)
    }),
).pipe(Command.withDescription(definitionOf('close').task))

const ask = Command.make(
  'ask',
  { project: projectArg, issue: integerOption('ask', 'issue'), text: sentenceArg, json, noColor },
  (args) =>
    answerWith('ask', args, async (progress) => {
      const { askVerdict } = await import('./ask.ts')
      return askVerdict({ project: args.project, issue: args.issue, text: args.text.join(' ') }, progress)
    }),
).pipe(Command.withDescription(definitionOf('ask').task))

const answer = Command.make(
  'answer',
  { project: projectArg, issue: integerOption('answer', 'issue'), text: sentenceArg, json, noColor },
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
    issue: integerOption('now', 'issue').pipe(Options.optional),
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

const portOption = integerOption('board', 'port').pipe(Options.optional)
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

// ---- run, attach, ticket, end, backlog (#624) --------------------------------------------
// `ask` is above and was #621's. Each of these loads its module in the handler, for the
// reason `status` gives, and hands the parsed request to a runner a test can replace.

/** What was typed after `run`; `merge` is false under `--no-merge`. */
export interface RunRequest {
  project: string
  issue?: number
  max?: number
  merge: boolean
}
export interface AttachRequest {
  runId: string
}
export interface EndRequest {
  project?: string
  issue?: number
}
export interface TicketRequest {
  verb: 'list' | 'close' | 'new' | 'edit'
  project?: string
  /** `close` and `edit`: the number, already checked to be an integer. */
  issue?: number
  all?: boolean
  json?: boolean
}
export type BacklogRequest =
  | { verb: 'list'; project?: string; all: boolean; json: boolean }
  | { verb: 'accept'; positional: string[]; kind?: string; unheld: boolean }
  | { verb: 'decline'; positional: string[]; reason?: string }

export type EnvRequest =
  | { verb: 'list'; project: string; json: boolean }
  | { verb: 'set'; project: string; argument: string }
  | { verb: 'unset'; project: string; name: string }
export type ProjectionRequest = { verb: 'lag'; json: boolean } | { verb: 'rebuild'; name: string }
export interface UpgradeRequest {
  despiteDoctor: boolean
}
export interface RollbackRequest {
  version?: string
}
export interface UninstallRequest {
  yes: boolean
  nothingConducts: boolean
}

export interface Runners {
  run: (request: RunRequest) => Promise<number>
  attach: (request: AttachRequest) => Promise<number>
  end: (request: EndRequest) => Promise<number>
  ticket: (request: TicketRequest) => Promise<number>
  backlog: (request: BacklogRequest) => Promise<number>
  env: (request: EnvRequest) => Promise<number>
  projection: (request: ProjectionRequest) => Promise<number>
  upgrade: (request: UpgradeRequest) => Promise<number>
  rollback: (request: RollbackRequest) => Promise<number>
  uninstall: (request: UninstallRequest) => Promise<number>
}

const liveRunners: Runners = {
  async run(request) {
    const { run: runPass } = await import('./run.ts')
    return runPass(request)
  },
  async attach(request) {
    const { attach } = await import('./attach.ts')
    // Ctrl-C detaches rather than killing the process, so the command gets to
    // say that the run is still going and where its log is. Nothing is being
    // stopped: this is a reader, and 0034's file does not know it has one.
    const detach = new AbortController()
    process.on('SIGINT', () => detach.abort())
    return attach({ runId: request.runId, signal: detach.signal })
  },
  async end(request) {
    const { endReplay } = await import('./end.ts')
    return endReplay(request)
  },
  async ticket(request) {
    const { ticketClose, ticketEdit, ticketList, ticketNew } = await import('./ticket.ts')
    const project = request.project === undefined ? {} : { project: request.project }
    switch (request.verb) {
      case 'list':
        return ticketList({
          ...project,
          all: request.all === true,
          json: request.json === true,
          columns: process.stdout.columns,
        })
      case 'close':
        return ticketClose({ ...project, issue: request.issue! })
      case 'new':
        return ticketNew(project)
      case 'edit':
        return ticketEdit({ ...project, issue: request.issue! })
    }
  },
  async backlog(request) {
    const backlog = await import('./backlog.ts')
    if (request.verb === 'list') {
      try {
        const listing = await backlog.readBacklogListing({ project: request.project, all: request.all })
        if (request.json) printJson('backlog', backlog.backlogJson(listing))
        else for (const line of backlog.renderBacklog(listing)) console.log(line)
        return 0
      } catch (err) {
        return failed('backlog', request.json, err)
      }
    }
    const [project, key, ...extra] = request.positional
    if (!project || !key) {
      console.log(backlog.BACKLOG_USAGE)
      return 2
    }
    return backlog.decideFinding(
      request.verb === 'accept'
        ? { verb: 'accept', project, key, extra, kind: request.kind, unheld: request.unheld }
        : { verb: 'decline', project, key, extra, reason: request.reason },
    )
  },
  async env(request) {
    const { envList, envSet, envUnset } = await import('./env.ts')
    switch (request.verb) {
      case 'list':
        return envList({ project: request.project, json: request.json, columns: process.stdout.columns })
      case 'set':
        return envSet(request)
      case 'unset':
        return envUnset(request)
    }
  },
  async projection(request) {
    const projection = await import('./projection.ts')
    if (request.verb === 'lag') {
      try {
        const { projectionLag } = await import('@lingtai/projector')
        const lags = await projectionLag()
        if (request.json) printJson('projection lag', projection.projectionLagJson(lags))
        else
          for (const line of projection.renderProjectionLag(lags, { columns: process.stdout.columns }))
            console.log(line)
        return 0
      } catch (err) {
        return failed('projection lag', request.json, err)
      }
    }
    const { log } = await import('@lingtai/event-store')
    const { createProjectionRunner } = await import('@lingtai/projector')
    const chosen = projection.PROJECTIONS.find((p) => p.name === request.name)!
    // Drop the table, reset the checkpoint, replay — which is what makes a
    // projection's shape free to change, a rebuild rather than a migration.
    // `rebuildProjection` refuses before any of that if the log predates
    // #445's payload reset (#451).
    return projection.rebuildProjection({
      name: request.name,
      queries: log.queries,
      runnerFor: () => createProjectionRunner({ projection: chosen }),
    })
  },
  // `upgrade` is spawned-from and `version` is what it spawns, so none of these three
  // is imported at the top; `self` is the file this process started from (`install.ts`).
  async upgrade(request) {
    const { upgrade } = await import('./install.ts')
    const { liveWorld } = await import('./world.ts')
    return upgrade(request, liveWorld(import.meta.filename))
  },
  async rollback(request) {
    const { rollback } = await import('./install.ts')
    const { liveWorld } = await import('./world.ts')
    return rollback(request, liveWorld(import.meta.filename))
  },
  async uninstall(request) {
    const { uninstall } = await import('./install.ts')
    const { liveWorld } = await import('./world.ts')
    return uninstall(request, liveWorld(import.meta.filename))
  },
}

let runners: Runners = liveRunners

/** A runner that threw: the message and exit 1, as `lingtai.ts` ended every command that threw. */
async function guarded(command: string, work: () => Promise<number>, asJson = false): Promise<void> {
  try {
    handlerCode = await work()
  } catch (err) {
    handlerCode = failed(command, asJson, err)
  }
}

const givenNumber = (o: { _tag: string; value?: number }): number | undefined =>
  o._tag === 'Some' ? o.value : undefined

const RUN_USAGE = 'lingtai run <project> [--issue <n>] [--max <n>] [--no-merge]'

const runCommand = Command.make(
  'run',
  {
    project: Args.text({ name: 'project' }).pipe(Args.optional),
    projectFlag: optionalText('project'),
    issue: integerOption('run', 'issue').pipe(Options.optional),
    max: integerOption('run', 'max').pipe(Options.optional),
    once: Options.boolean('once'),
    noMerge: Options.boolean('no-merge'),
    noColor,
  },
  (args) =>
    Effect.promise(async () => {
      if (args.noColor) applyNoColor()
      const project = given(args.project) ?? given(args.projectFlag)
      if (!project) {
        console.error(RUN_USAGE)
        handlerCode = 2
        return
      }
      const issue = givenNumber(args.issue)
      // `--once` with no `--issue` used to be the only mode. It now means the
      // same as `--max 1`: take the queue, but stop after one.
      const max = givenNumber(args.max) ?? (args.once && issue === undefined ? 1 : undefined)
      if (max !== undefined && max < 1) {
        console.error('--max takes a positive number')
        handlerCode = 2
        return
      }
      console.log(heading(`run ${project}`))
      await guarded('run', () =>
        runners.run({
          project,
          ...(issue === undefined ? {} : { issue }),
          ...(max === undefined ? {} : { max }),
          // `--no-merge` is absence of merging, so the flag's presence is the
          merge: !args.noMerge,
        }),
      )
    }),
).pipe(Command.withDescription(definitionOf('run').task))

const attachCommand = Command.make(
  'attach',
  { runId: Args.text({ name: 'runId' }).pipe(Args.optional), noColor },
  (args) =>
    Effect.promise(async () => {
      if (args.noColor) applyNoColor()
      const runId = given(args.runId)
      if (!runId) {
        console.error('lingtai attach <runId>')
        handlerCode = 2
        return
      }
      await guarded('attach', () => runners.attach({ runId }))
    }),
).pipe(Command.withDescription(definitionOf('attach').task))

const END_USAGE = 'lingtai end replay [<project>] [--issue <n>]'

const endReplay = Command.make(
  'replay',
  {
    project: Args.text({ name: 'project' }).pipe(Args.optional),
    issue: integerOption('end', 'issue').pipe(Options.optional),
    noColor,
  },
  (args) =>
    Effect.promise(async () => {
      if (args.noColor) applyNoColor()
      const project = given(args.project)
      const issue = givenNumber(args.issue)
      await guarded('end', () =>
        runners.end({ ...(project === undefined ? {} : { project }), ...(issue === undefined ? {} : { issue }) }),
      )
    }),
)

// One subcommand, spelled out. `lingtai end` on its own would read like an instruction to end something.
const endCommand = Command.make('end', {}, () =>
  Effect.sync(() => {
    console.error(END_USAGE)
    handlerCode = 2
  }),
).pipe(Command.withDescription(definitionOf('end').task), Command.withSubcommands([endReplay]))

const TICKET_USAGE =
  'lingtai ticket list [--all] [--project <p>]\nlingtai ticket close <n> [--project <p>]\n' +
  'lingtai ticket new [--project <p>]\nlingtai ticket edit <n> [--project <p>]'

const projectOption = optionalText('project')

/** `close` and `edit` take a number as the argument, checked here so the sentence and exit 2 are the ones they always had. */
function ticketNumbered(verb: 'close' | 'edit') {
  return Command.make(
    verb,
    { number: Args.text({ name: 'n' }).pipe(Args.optional), project: projectOption, noColor },
    (args) =>
      Effect.promise(async () => {
        if (args.noColor) applyNoColor()
        const issue = Number(given(args.number))
        if (!given(args.number) || !Number.isInteger(issue)) {
          console.error(`lingtai ticket ${verb} <n> [--project <p>]`)
          handlerCode = 2
          return
        }
        const project = given(args.project)
        await guarded('ticket', () => runners.ticket({ verb, issue, ...(project === undefined ? {} : { project }) }))
      }),
  )
}

const ticketList = Command.make(
  'list',
  { all: Options.boolean('all'), project: projectOption, json, noColor },
  (args) =>
    Effect.promise(async () => {
      if (args.noColor) applyNoColor()
      const project = given(args.project)
      await guarded(
        'ticket list',
        () =>
          runners.ticket({
            verb: 'list',
            all: args.all,
            json: args.json,
            ...(project === undefined ? {} : { project }),
          }),
        args.json,
      )
    }),
)

const ticketNew = Command.make('new', { project: projectOption, noColor }, (args) =>
  Effect.promise(async () => {
    if (args.noColor) applyNoColor()
    const project = given(args.project)
    await guarded('ticket', () => runners.ticket({ verb: 'new', ...(project === undefined ? {} : { project }) }))
  }),
)

const ticketCommand = Command.make('ticket', {}, () =>
  Effect.sync(() => {
    console.error(TICKET_USAGE)
    handlerCode = 2
  }),
).pipe(
  Command.withDescription(definitionOf('ticket').task),
  Command.withSubcommands([ticketList, ticketNew, ticketNumbered('close'), ticketNumbered('edit')]),
)

const rest = Args.text({ name: 'arg' }).pipe(Args.repeated)

const reportCommand = Command.make(
  'report',
  {
    window: optionalText('window'),
    from: optionalText('from'),
    to: optionalText('to'),
    kind: optionalText('kind'),
    project: optionalText('project'),
    json,
    noColor,
  },
  (args) =>
    Effect.promise(async () => {
      if (args.noColor) applyNoColor()
      // Loaded here, for the reason `status` gives: the conductor and the store are not for `lingtai version`.
      await guarded(
        'report',
        async () => {
          const { runReport } = await import('./report.ts')
          return runReport({
            window: given(args.window),
            from: given(args.from),
            to: given(args.to),
            kind: given(args.kind),
            project: given(args.project),
            json: args.json,
          })
        },
        args.json,
      )
    }),
).pipe(Command.withDescription(definitionOf('report').task))

const backlogList = Command.make(
  'list',
  { project: Args.text({ name: 'project' }).pipe(Args.optional), all: Options.boolean('all'), json, noColor },
  (args) =>
    Effect.promise(async () => {
      if (args.noColor) applyNoColor()
      const project = given(args.project)
      await guarded('backlog', () =>
        runners.backlog({
          verb: 'list',
          all: args.all,
          json: args.json,
          ...(project === undefined ? {} : { project }),
        }),
      )
    }),
)

const backlogAccept = Command.make(
  'accept',
  { positional: rest, kind: optionalText('kind'), unheld: Options.boolean('unheld'), noColor },
  (args) =>
    Effect.promise(async () => {
      if (args.noColor) applyNoColor()
      const kind = given(args.kind)
      await guarded('backlog', () =>
        runners.backlog({
          verb: 'accept',
          positional: [...args.positional],
          unheld: args.unheld,
          ...(kind === undefined ? {} : { kind }),
        }),
      )
    }),
)

const backlogDecline = Command.make('decline', { positional: rest, reason: optionalText('reason'), noColor }, (args) =>
  Effect.promise(async () => {
    if (args.noColor) applyNoColor()
    const reason = given(args.reason)
    await guarded('backlog', () =>
      runners.backlog({
        verb: 'decline',
        positional: [...args.positional],
        ...(reason === undefined ? {} : { reason }),
      }),
    )
  }),
)

// `lingtai backlog [<project>] [--all]` is the listing: `runCli` writes `list` in front of anything that is not
// a verb, so the parent has no positional of its own to share with them.
const backlogCommand = Command.make('backlog', {}, () =>
  Effect.promise(async () => {
    const { BACKLOG_USAGE } = await import('./backlog.ts')
    console.log(BACKLOG_USAGE)
  }),
).pipe(
  Command.withDescription(definitionOf('backlog').task),
  Command.withSubcommands([backlogList, backlogAccept, backlogDecline]),
)

// ---- env, projection, upgrade, rollback, uninstall (#625) --------------------------------

const envProject = Args.text({ name: 'project' }).pipe(Args.optional)

/** `env` is the parent of three verbs and answers none itself: its usage, exit 2, as a missing verb always was. */
function envUsage(json = false, command = 'env'): void {
  // Under --json the failure is the error document on stdout, as everywhere else (0121 §5).
  if (json) printJsonError(command, 'usage', ENV_USAGE)
  else console.error(ENV_USAGE)
  handlerCode = 2
}

const envList = Command.make('list', { project: envProject, json, noColor }, (args) =>
  Effect.promise(async () => {
    if (args.noColor) applyNoColor()
    const project = given(args.project)
    if (!project) return envUsage(args.json, 'env list')
    await guarded('env list', () => runners.env({ verb: 'list', project, json: args.json }), args.json)
  }),
)

// `KEY=VALUE` is one token that starts with a letter, so `Args.text` takes it whole — a value of
// `--x` or one with its own `=` reaches the runner as typed (the first `=` splits it, in `env.ts`).
const envSet = Command.make(
  'set',
  { project: envProject, argument: Args.text({ name: 'KEY[=VALUE]' }).pipe(Args.optional), noColor },
  (args) =>
    Effect.promise(async () => {
      if (args.noColor) applyNoColor()
      const project = given(args.project)
      const argument = given(args.argument)
      if (!project || !argument) return envUsage()
      await guarded('env set', () => runners.env({ verb: 'set', project, argument }))
    }),
)

const envUnset = Command.make(
  'unset',
  { project: envProject, name: Args.text({ name: 'KEY' }).pipe(Args.optional), noColor },
  (args) =>
    Effect.promise(async () => {
      if (args.noColor) applyNoColor()
      const project = given(args.project)
      const name = given(args.name)
      if (!project || !name) return envUsage()
      await guarded('env unset', () => runners.env({ verb: 'unset', project, name }))
    }),
)

const envCommand = Command.make('env', {}, () => Effect.sync(envUsage)).pipe(
  Command.withDescription(definitionOf('env').task),
  Command.withSubcommands([envList, envSet, envUnset]),
)

const projectionLag = Command.make('lag', { json, noColor }, (args) =>
  Effect.promise(async () => {
    if (args.noColor) applyNoColor()
    await guarded('projection lag', () => runners.projection({ verb: 'lag', json: args.json }), args.json)
  }),
)

const projectionRebuild = Command.make(
  'rebuild',
  { name: Args.text({ name: 'name' }).pipe(Args.optional), noColor },
  (args) =>
    Effect.promise(async () => {
      if (args.noColor) applyNoColor()
      const name = given(args.name)
      if (!name) {
        console.error('lingtai projection rebuild <name>')
        handlerCode = 2
        return
      }
      // Named, not discovered (0022): `PROJECTIONS` in `projection.ts` is the list, and
      // `help.test.ts` holds the names in `commands.ts` to it.
      if (!(PROJECTION_NAMES as readonly string[]).includes(name)) {
        console.error(`${symbol.fail()} unknown projection "${name}" — known: ${PROJECTION_NAMES.join(', ')}`)
        handlerCode = 2
        return
      }
      await guarded('projection rebuild', () => runners.projection({ verb: 'rebuild', name }))
    }),
)

const projectionCommand = Command.make('projection', {}, () =>
  Effect.sync(() => {
    console.error(commandHelp('projection'))
    handlerCode = 2
  }),
).pipe(
  Command.withDescription(definitionOf('projection').task),
  Command.withSubcommands([projectionLag, projectionRebuild]),
)

const upgradeCommand = Command.make('upgrade', { despiteDoctor: Options.boolean('despite-doctor'), noColor }, (args) =>
  Effect.promise(async () => {
    if (args.noColor) applyNoColor()
    await guarded('upgrade', () => runners.upgrade({ despiteDoctor: args.despiteDoctor }))
  }),
).pipe(Command.withDescription(definitionOf('upgrade').task))

const rollbackCommand = Command.make(
  'rollback',
  { version: Args.text({ name: 'version' }).pipe(Args.optional), noColor },
  (args) =>
    Effect.promise(async () => {
      if (args.noColor) applyNoColor()
      const version = given(args.version)
      // The parser takes `--x` as a version; it was never one, and the sentence it was refused with stands.
      if (version?.startsWith('--')) {
        console.error(`${symbol.fail()} lingtai rollback [<version>]`)
        handlerCode = 2
        return
      }
      await guarded('rollback', () => runners.rollback(version === undefined ? {} : { version }))
    }),
).pipe(Command.withDescription(definitionOf('rollback').task))

const uninstallCommand = Command.make(
  'uninstall',
  { yes: Options.boolean('yes'), nothingConducts: Options.boolean('nothing-conducts'), noColor },
  (args) =>
    Effect.promise(async () => {
      if (args.noColor) applyNoColor()
      await guarded('uninstall', () => runners.uninstall({ yes: args.yes, nothingConducts: args.nothingConducts }))
    }),
).pipe(Command.withDescription(definitionOf('uninstall').task))

// ------------------------------------------------------- the daemon commands --
//
// (#622) `start`, `daemon`, `service`, `restart`, `shutdown`, `pause` and `resume`. Their code
// lives in `daemon.ts`, which has no side effects at import: `lingtai.ts` runs `main` when it
// is loaded, and the supervisor's plist still runs that file with `daemon`.

/** Every handler here ends the same way: a thrown error is a sentence and exit 1. */
function daemonHandler(args: { noColor: boolean }, run: () => Promise<number>, jsonCommand?: string) {
  return Effect.promise(async () => {
    if (args.noColor) applyNoColor()
    try {
      handlerCode = await run()
    } catch (err) {
      // A script reading `--json` gets the error document on stdout, not an empty string.
      handlerCode =
        jsonCommand === undefined
          ? wizardFailed(err)
          : printJsonError(jsonCommand, 'failed', err instanceof Error ? err.message : String(err))
    }
  })
}

const startFlags = {
  noConduct: Options.boolean('no-conduct'),
  noMerge: Options.boolean('no-merge'),
  verbose: Options.boolean('verbose'),
  noColor,
}

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
      return daemonCommand(
        flags,
        null,
        name === 'start' ? () => console.log(`${symbol.pass()} started`) : null,
        startIsVerbose(name, args.verbose),
      )
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
      let boardHad = false // ...and a board process, or no board job or build, so the board's start was not made either
      let code: number
      try {
        code = await serviceCommand([verb, ...(why.length > 0 ? [why.join(' ')] : [])], {
          ...serviceOptions(),
          steps,
          unconfirmed: (job) => {
            if (job === 'conductor') unconfirmed = true
            else boardHad = true
          },
        })
      } finally {
        // A throw (EACCES on the service file, say) must not leave the spinner animating.
        steps.end()
      }
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
  daemonHandler(
    args,
    async () => {
      const { serviceOptions } = await import('./daemon.ts')
      const { serviceCommand } = await import('./service.ts')
      return serviceCommand(['status'], { ...serviceOptions(), json: args.json })
    },
    args.json ? 'service status' : undefined,
  ),
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

export const root = Command.make('lingtai').pipe(
  Command.withSubcommands([
    version,
    status,
    eventsCommand,
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
    runCommand,
    attachCommand,
    ticketCommand,
    endCommand,
    backlogCommand,
    reportCommand,
    envCommand,
    projectionCommand,
    upgradeCommand,
    rollbackCommand,
    uninstallCommand,
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
  'grant-fix-round': [
    { flag: 'if-head', sentence: '--if-head takes the commit SHA, full or at least 7 characters', trimmed: false },
  ],
}

/** The sentence refusing an integer flag whose value is not a whole number, in any form it arrives in, else undefined (#770). */
function integerRefusal(args: readonly string[]): string | undefined {
  const flags: readonly string[] = (INTEGER_FLAGS as Record<string, readonly string[]>)[args[0] ?? ''] ?? []
  const terminator = args.indexOf('--')
  const rest = args.slice(1, terminator === -1 ? undefined : terminator)
  for (const flag of flags) {
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!
      let value: string | null
      if (arg.startsWith(`--${flag}=`)) value = arg.slice(flag.length + 3)
      else if (arg === `--${flag}`) {
        const next = rest[i + 1]
        value = next === undefined || next.startsWith('--') ? null : next
      } else continue
      if (value !== null && /^\d+$/.test(value)) continue
      const takes = `--${flag} takes ${INTEGER_NOUN[flag]}`
      return value === null ? takes : `${takes}, not '${value}'`
    }
  }
  return undefined
}

/** `--note` with nothing after it means what leaving it off means, `""` (#424), so it is dropped before parsing. */
function withoutBareNote(args: readonly string[]): string[] {
  return args.filter((arg, i) => arg !== '--note' || !(args[i + 1] === undefined || args[i + 1]!.startsWith('--')))
}

/**
 * `--reason style only` is one reason (#137): the words after it, up to the next flag, become one argument,
 * because the parser takes one word and would leave the rest as keys. A `--reason` with nothing after it is
 * dropped, and the verb refuses it by name.
 */
function withReasonFolded(args: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg !== '--reason') {
      out.push(arg)
      continue
    }
    const words: string[] = []
    while (i + 1 < args.length && !args[i + 1]!.startsWith('--')) words.push(args[++i]!)
    if (words.length > 0) out.push(arg, words.join(' '))
  }
  return out
}

/** `backlog [<project>] [--all]` is `backlog list …`, so the verbs and the listing do not share a first position. */
function withBacklogVerb(args: readonly string[]): string[] {
  return ['accept', 'decline', 'help'].includes(args[1] ?? '') ? [...args] : ['backlog', 'list', ...args.slice(1)]
}

/** `argv` is the full `process.argv` shape; resolves to the exit code. */
export async function runCli(
  argv: readonly string[],
  deps: { board?: BoardRunner } & Partial<Runners> = {},
): Promise<number> {
  let args = argv.slice(2)
  boardRunner = deps.board ?? liveBoardRunner
  runners = { ...liveRunners, ...deps }
  if (args[0] === 'backlog') {
    if (args[1] === 'help') {
      console.log((await import('./backlog.ts')).BACKLOG_USAGE)
      return 0
    }
    args = withBacklogVerb(args[1] === 'decline' ? ['backlog', ...withReasonFolded(args.slice(1))] : args)
    argv = [...argv.slice(0, 2), ...args]
  }
  if (args[0] === 'board' && args[1] === 'shutdown') {
    const sentence =
      'lingtai board shutdown does not exist — shutdown means finish the pass in flight, and waits as long as the ' +
      'wall limit for it. A board has no pass to finish: pnpm lingtai board stop, which returns at once'
    if (args.some(jsonOn)) printJsonError('board', 'usage', sentence)
    else console.error(`${symbol.fail()} ${sentence}`)
    return 2
  }
  if (args[0] === 'projection' && args[1] === 'run') {
    // Gone, and answered by name rather than by a usage error. It was another name for
    // `lingtai daemon`, and two names for one process is how "why is the board stale" gets a
    // different answer depending on which name you happened to learn (0022).
    if (args.includes('--no-color')) applyNoColor()
    const sentence =
      'lingtai projection run is gone — it was another name for lingtai daemon, which is the process that follows the projections. Use that.'
    if (args.some(jsonOn)) printJsonError('projection', 'usage', sentence)
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
  const refusal = integerRefusal(args)
  if (refusal !== undefined) {
    if (args.some(jsonOn)) printJsonError(args[0]!, 'usage', refusal)
    else console.error(refusal)
    return 2
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
      return 2
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
