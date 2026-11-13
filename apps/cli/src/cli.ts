import * as NodeServices from '@effect/platform-node/NodeServices'
import { coloured, paint } from '@lingtai/env/colour'
import type { SnapshotWriter } from '@lingtai/event-store/snapshot-writer'
import { Console, Effect } from 'effect'
/**
 * The `@effect/cli` side of the entry (#616). Loaded by `entry.ts` with a
 * dynamic `import()` and only for a command named in `commands.ts`, so a word
 * that is not one pays nothing for it. It is the only parser (#626).
 */
import { Argument, CliOutput, Command, Flag } from 'effect/cli'

import type { BoardVerb } from './board.ts'
import { definitionOf, PROJECTION_NAMES, startIsVerbose } from './commands.ts'
import { USAGE as ENV_USAGE } from './env-usage.ts'
import { CommandExit, exitWith, failed, lift, orFailed, orWizardFailed, printedBy, wizardFailed } from './exit.ts'
import { commandHelp } from './help.ts'
import { applyNoColor, heading, printJson, printJsonError, stripColour, symbol } from './output.ts'
import { parseRestartArgs, type RestartArgs } from './restart.ts'
import { createSteps } from './steps.ts'
import { refusal, renderVerdict, VERBS, verdictJson, type Answered } from './verdict.ts'
import { versionFacts, versionLine } from './version.ts'
import { addOptions, flagsOf, initOptions, valuelessFlag } from './wizard-options.ts'

const json = Flag.Boolean('json').pipe(Flag.withDefault(false))
const noColor = Flag.Boolean('no-color').pipe(Flag.withDefault(false))

const version = Command.make('version', { json, noColor }, (args) =>
  Effect.sync(() => {
    if (args.noColor) applyNoColor()
    // The plain line is what `upgrade` parses from the new binary: no heading, no colour.
    if (args.json) printJson('version', versionFacts())
    else process.stdout.write(`${versionLine()}\n`)
  }),
).pipe(Command.withDescription(definitionOf('version').task))

const status = Command.make(
  'status',
  {
    project: Argument.String('project').pipe(Argument.optional),
    all: Flag.Boolean('all').pipe(Flag.withDefault(false)),
    json,
    noColor,
  },
  (args) =>
    Effect.gen(function* () {
      if (args.noColor) applyNoColor()
      // Loaded here and not at the top: `lingtai version` is what `upgrade` spawns, and it must not
      // pay for the conductor, the projector and the store (`entry.ts`).
      const { readStatus, renderStatus, statusJson } = yield* lift(() => import('./status.ts'))
      const project = args.project._tag === 'Some' ? args.project.value : undefined
      const report = yield* lift(() => readStatus({ project, all: args.all }))
      if (args.json) printJson('status', statusJson(report))
      else
        for (const line of renderStatus(report, { all: args.all, columns: process.stdout.columns })) console.log(line)
    }).pipe(orFailed('status', args.json)),
).pipe(Command.withDescription(definitionOf('status').task))

const eventsCommand = Command.make(
  'events',
  { name: Argument.String('name').pipe(Argument.optional), json, noColor },
  (args) =>
    Effect.gen(function* () {
      if (args.noColor) applyNoColor()
      // Loaded here, for the reason `status` gives: no other command parses the manifest.
      const { events, eventsJson, findEvent, renderEvent, renderEvents } = yield* lift(
        () => import('./events.ts'),
      ).pipe(
        // No `try` here today: a failed import is a defect, which `runCli` ends as 1.
        Effect.orDie,
      )
      if (args.name._tag === 'None') {
        if (args.json) printJson('events', eventsJson(events))
        else for (const line of renderEvents(events, { columns: process.stdout.columns })) console.log(line)
        return
      }
      const found = findEvent(events, args.name.value)
      if (found === undefined) {
        const message = `no event named ${args.name.value} — lingtai events lists them`
        if (args.json) return yield* exitWith(printJsonError('events', 'unknown-event', message))
        console.error(`${symbol.fail()} ${message}`)
        return yield* exitWith(1)
      } else if (args.json) printJson('events', eventsJson(events, found))
      else for (const line of renderEvent(found)) console.log(line)
    }),
).pipe(Command.withDescription(definitionOf('events').task))

const doctor = Command.make(
  'doctor',
  { json, noColor, verbose: Flag.Boolean('verbose').pipe(Flag.withDefault(false)) },
  (args) =>
    Effect.gen(function* () {
      if (args.noColor) applyNoColor()
      // Loaded here, for the reason `status` gives.
      const { doctorReportEffect, doctorJson, renderDoctor, tally } = yield* lift(() => import('./doctor.ts'))
      const { releaseCheck } = yield* lift(() => import('./install.ts'))
      const { doctorProgress } = yield* lift(() => import('./steps.ts'))
      const progress = doctorProgress({ stdout: process.stdout, stderr: process.stderr, json: args.json })
      const report = yield* Effect.gen(function* () {
        const report = yield* doctorReportEffect({ onProgress: progress.onProgress })
        // Here and not in `runDoctor`, which `lingtai restart` gates on: the one
        // outbound request this tool makes is asked by `doctor` and `upgrade` (#184),
        // and a restart is neither. Timed here, since `runDoctor` never sees it.
        progress.onProgress({ label: 'releases', phase: 'start', done: report.results.length })
        const t0 = performance.now()
        const row = yield* releaseCheck({ fetch, env: process.env, self: import.meta.filename })
        report.results.push({ ...row, ms: Math.round(performance.now() - t0) })
        Object.assign(report, tally(report.results))
        return report
      }).pipe(Effect.ensuring(Effect.sync(() => progress.clear())))
      if (args.json) printJson('doctor', doctorJson(report))
      else for (const line of renderDoctor(report, { verbose: args.verbose })) console.log(line)
      // Non-zero on any failure. `lingtai restart` runs the same report (0042) but
      // does not refuse on the same number: a failure marked `restartAnswers` exits
      // this 1 and lets a restart through — see `gatingFailures`. A deferred check
      // is not a failure; a missing one would be.
      yield* exitWith(report.failed === 0 ? 0 : 1)
    }).pipe(orFailed('doctor', args.json)),
).pipe(Command.withDescription(definitionOf('doctor').task))

// Loaded in the handler and not at the top, for the reason `status` gives; `init` also
// loads the board's server module, which no other command needs.
const init = Command.make('init', initOptions, (args) =>
  Effect.gen(function* () {
    const { initCommand, liveInitWorld } = yield* lift(() => import('./init.ts'))
    yield* exitWith(yield* lift(() => initCommand(flagsOf(args), liveInitWorld())))
  }).pipe(orWizardFailed()),
).pipe(Command.withDescription(definitionOf('init').task))

const add = Command.make(
  'add',
  { repo: Argument.String('owner/repo').pipe(Argument.optional), ...addOptions },
  ({ repo, ...options }) =>
    Effect.gen(function* () {
      const { addFlow, liveAddWorld } = yield* lift(() => import('./add.ts'))
      yield* exitWith(
        yield* lift(() =>
          addFlow({ positional: repo._tag === 'Some' ? repo.value : undefined, ...flagsOf(options) }, liveAddWorld()),
        ),
      )
    }).pipe(orWizardFailed()),
).pipe(Command.withDescription(definitionOf('add').task))

/** Where a wait-answering command's progress goes: stdout, or stderr so `--json` keeps stdout to its one document. */
function progressFor(asJson: boolean): (line: string) => void {
  return asJson ? (line) => console.error(line) : (line) => console.log(line)
}

/** Runs one of the `<verb>Verdict` functions and prints what it answered (#621). */
function answerWith(
  command: keyof typeof VERBS,
  args: { json: boolean; noColor: boolean },
  run: (progress: (line: string) => void) => Effect.Effect<Answered, unknown>,
) {
  return Effect.gen(function* () {
    if (args.noColor) applyNoColor()
    const answered = yield* run(progressFor(args.json))
    if (args.json) printJson(command, verdictJson(answered.verdict))
    else
      for (const line of renderVerdict(
        answered.verdict.outcome === 'accepted' ? VERBS[command].accepted : VERBS[command].refused,
        answered.verdict,
      ))
        console.log(line)
    yield* exitWith(answered.code)
  }).pipe(orFailed(command, args.json))
}

const projectArg = Argument.String('project')

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
  return Flag.Int(flag)
}
const optionalText = (name: string) => Flag.String(name).pipe(Flag.optional)
const given = (o: { _tag: string; value?: string }): string | undefined => (o._tag === 'Some' ? o.value : undefined)
/** Everything after the project is the sentence, so an unquoted one still arrives whole. */
const sentenceArg = Argument.String('text').pipe(Argument.variadic())

const approve = Command.make(
  'approve',
  {
    project: projectArg,
    issue: integerOption('approve', 'issue'),
    note: optionalText('note'),
    reject: Flag.Boolean('reject').pipe(Flag.withDefault(false)),
    json,
    noColor,
  },
  (args) =>
    answerWith('approve', args, (progress) =>
      Effect.gen(function* () {
        if (args.reject) {
          // Gone (#150): it revoked the approval and put the run straight back
          // into `awaiting-approval`, so the wait it seemed to end went on.
          return refusal(2, 'removed-flag', '--reject is gone: it asked the same question again and ended nothing.', {
            next: `lingtai requeue ${args.project} --issue ${args.issue}`,
          })
        }
        const { approveVerdict } = yield* lift(() => import('./approve.ts'))
        return yield* approveVerdict({ project: args.project, issue: args.issue, note: given(args.note) }, progress)
      }),
    ),
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
    answerWith('requeue', args, (progress) =>
      Effect.gen(function* () {
        const { requeueVerdict } = yield* lift(() => import('./requeue.ts'))
        return yield* requeueVerdict(
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
    ),
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
    answerWith('grant-fix-round', args, (progress) =>
      Effect.gen(function* () {
        const { grantFixRoundVerdict } = yield* lift(() => import('./grant-fix-round.ts'))
        return yield* grantFixRoundVerdict(
          { project: args.project, issue: args.issue, ifHead: given(args.ifHead) },
          progress,
        )
      }),
    ),
).pipe(Command.withDescription(definitionOf('grant-fix-round').task))

const close = Command.make(
  'close',
  { project: projectArg, issue: integerOption('close', 'issue'), text: sentenceArg, json, noColor },
  (args) =>
    answerWith('close', args, (progress) =>
      Effect.gen(function* () {
        const { closeVerdict } = yield* lift(() => import('./close.ts'))
        return yield* closeVerdict({ project: args.project, issue: args.issue, reason: args.text.join(' ') }, progress)
      }),
    ),
).pipe(Command.withDescription(definitionOf('close').task))

const ask = Command.make(
  'ask',
  { project: projectArg, issue: integerOption('ask', 'issue'), text: sentenceArg, json, noColor },
  (args) =>
    answerWith('ask', args, (progress) =>
      Effect.gen(function* () {
        const { askVerdict } = yield* lift(() => import('./ask.ts'))
        return yield* askVerdict({ project: args.project, issue: args.issue, text: args.text.join(' ') }, progress)
      }),
    ),
).pipe(Command.withDescription(definitionOf('ask').task))

const answer = Command.make(
  'answer',
  { project: projectArg, issue: integerOption('answer', 'issue'), text: sentenceArg, json, noColor },
  (args) =>
    answerWith('answer', args, (progress) =>
      Effect.gen(function* () {
        const { answerVerdict } = yield* lift(() => import('./ask.ts'))
        return yield* answerVerdict({ project: args.project, issue: args.issue, text: args.text.join(' ') }, progress)
      }),
    ),
).pipe(Command.withDescription(definitionOf('answer').task))

const now = Command.make(
  'now',
  {
    project: projectArg,
    second: Argument.String('issue').pipe(Argument.optional),
    issue: integerOption('now', 'issue').pipe(Flag.optional),
    json,
    noColor,
  },
  (args) =>
    answerWith('now', args, () =>
      Effect.gen(function* () {
        const issue = args.issue._tag === 'Some' ? args.issue.value : Number(given(args.second) ?? Number.NaN)
        if (!Number.isInteger(issue)) return refusal(2, 'usage', 'lingtai now <project> --issue <n>')
        const { nowVerdict } = yield* lift(() => import('./now.ts'))
        return yield* nowVerdict(args.project, issue, `human:${process.env['USER'] ?? 'operator'}`)
      }),
    ),
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
export type BoardRunner = (request: BoardRequest) => Effect.Effect<number, unknown>

const BOARD_USAGE = 'lingtai board start|stop|restart|status [--port <n>] [--dir <path>] [--no-open]'

function liveBoardRunner(request: BoardRequest): Effect.Effect<number, unknown> {
  return Effect.gen(function* () {
    const { boardCommand, builtBoardDir, boardStatusJson, readBoardStatus } = yield* lift(() => import('./board.ts'))
    const { liveBoardWorld } = yield* lift(() => import('./board-world.ts'))
    const { boardHost, boardPort } = yield* lift(() => import('@lingtai/env'))
    // `--port` is this run's; without it the machine file's, and without that
    // 17820 (#187). A file that does not parse is refused by name here rather
    // than serving on a port nobody chose.
    const where = yield* Effect.try({
      try: () => ({ port: request.port ?? boardPort(), host: boardHost() }),
      catch: (e) => e,
    }).pipe(Effect.result)
    if (where._tag === 'Failure') return failed('board', request.json, where.failure)
    const { port, host } = where.success
    const world = liveBoardWorld(host)
    if (request.verb === 'status' && request.json) {
      printJson('board status', boardStatusJson(yield* readBoardStatus({ port }, world)))
      return 0
    }
    return yield* boardCommand(
      { verb: request.verb, port, dir: request.dir ?? builtBoardDir(), open: request.open },
      world,
    )
  })
}

let boardRunner: BoardRunner = liveBoardRunner

const portOption = integerOption('board', 'port').pipe(Flag.optional)
const dirOption = Flag.String('dir').pipe(Flag.optional)
const noOpen = Flag.Boolean('no-open').pipe(Flag.withDefault(false))

/** Checked here and not by the parser, which reads `--port 99999` as an integer: the sentence has always been this one. */
function boardHandler(verb: BoardVerb) {
  return (args: {
    port: { _tag: string; value?: number }
    dir?: { _tag: string; value?: string }
    noOpen?: boolean
    json?: boolean
    noColor?: boolean
  }) =>
    Effect.gen(function* () {
      if (args.noColor) applyNoColor()
      const asJson = args.json === true
      const port = args.port._tag === 'Some' ? args.port.value! : null
      if (port !== null && (port <= 0 || port > 65535)) {
        const sentence = `${BOARD_USAGE} — --port takes a port number`
        if (asJson) printJsonError('board', 'usage', sentence)
        else console.error(sentence)
        return yield* exitWith(2)
      }
      const code = yield* boardRunner({
        verb,
        port,
        dir: args.dir?._tag === 'Some' ? args.dir.value! : null,
        open: !args.noOpen,
        json: asJson,
      })
      yield* exitWith(code)
    }).pipe(orFailed('board', args.json === true))
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
  /** `new`: the flag form — no editor. `labels` is the raw comma-separated value, and `body` may be `-` for stdin. */
  title?: string
  labels?: string
  body?: string
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
  run: (request: RunRequest) => Effect.Effect<number, unknown>
  attach: (request: AttachRequest) => Effect.Effect<number, unknown>
  end: (request: EndRequest) => Effect.Effect<number, unknown>
  ticket: (request: TicketRequest) => Effect.Effect<number, unknown>
  backlog: (request: BacklogRequest) => Effect.Effect<number, unknown>
  env: (request: EnvRequest) => Effect.Effect<number, unknown>
  projection: (request: ProjectionRequest) => Effect.Effect<number, unknown>
  upgrade: (request: UpgradeRequest) => Effect.Effect<number, unknown>
  rollback: (request: RollbackRequest) => Effect.Effect<number, unknown>
  uninstall: (request: UninstallRequest) => Effect.Effect<number, unknown>
}

const liveRunners: Runners = {
  run: (request) =>
    Effect.gen(function* () {
      const { run: runAttempt } = yield* lift(() => import('./run.ts'))
      return yield* lift(() => runAttempt(request))
    }),
  attach: (request) =>
    Effect.gen(function* () {
      const { attach } = yield* lift(() => import('./attach.ts'))
      // Ctrl-C detaches rather than killing the process, so the command gets to
      // say that the run is still going and where its log is. Nothing is being
      // stopped: this is a reader, and 0034's file does not know it has one.
      const detach = yield* Effect.sync(() => {
        const controller = new AbortController()
        process.on('SIGINT', () => controller.abort())
        return controller
      })
      return yield* lift(() => attach({ runId: request.runId, signal: detach.signal }))
    }),
  end: (request) =>
    Effect.gen(function* () {
      const { endReplay } = yield* lift(() => import('./end.ts'))
      return yield* lift(() => endReplay(request))
    }),
  ticket: (request) =>
    Effect.gen(function* () {
      const { ticketClose, ticketEdit, ticketList, ticketNew } = yield* lift(() => import('./ticket.ts'))
      const project = request.project === undefined ? {} : { project: request.project }
      switch (request.verb) {
        case 'list':
          return yield* lift(() =>
            ticketList({
              ...project,
              all: request.all === true,
              json: request.json === true,
              columns: process.stdout.columns,
            }),
          )
        case 'close':
          return yield* lift(() => ticketClose({ ...project, issue: request.issue! }))
        case 'new':
          return yield* lift(() =>
            ticketNew({
              ...project,
              ...(request.title === undefined ? {} : { title: request.title }),
              ...(request.labels === undefined ? {} : { label: request.labels }),
              ...(request.body === undefined ? {} : { body: request.body }),
            }),
          )
        case 'edit':
          return yield* lift(() => ticketEdit({ ...project, issue: request.issue! }))
      }
    }),
  backlog: (request) =>
    Effect.gen(function* () {
      const backlog = yield* lift(() => import('./backlog.ts'))
      if (request.verb === 'list') {
        return yield* Effect.gen(function* () {
          const listing = yield* lift(() => backlog.readBacklogListing({ project: request.project, all: request.all }))
          if (request.json) printJson('backlog', backlog.backlogJson(listing))
          else for (const line of backlog.renderBacklog(listing)) console.log(line)
          return 0
        }).pipe(orFailed('backlog', request.json))
      }
      const [project, key, ...extra] = request.positional
      if (!project || !key) {
        console.log(backlog.BACKLOG_USAGE)
        return 2
      }
      return yield* lift(() =>
        backlog.decideFinding(
          request.verb === 'accept'
            ? { verb: 'accept', project, key, extra, kind: request.kind, unheld: request.unheld }
            : { verb: 'decline', project, key, extra, reason: request.reason },
        ),
      )
    }),
  env: (request) =>
    Effect.gen(function* () {
      const { envList, envSet, envUnset } = yield* lift(() => import('./env.ts'))
      switch (request.verb) {
        case 'list':
          return yield* envList({ project: request.project, json: request.json, columns: process.stdout.columns })
        case 'set':
          return yield* envSet(request)
        case 'unset':
          return yield* envUnset(request)
      }
    }),
  projection: (request) =>
    Effect.gen(function* () {
      const projection = yield* lift(() => import('./projection.ts'))
      if (request.verb === 'lag') {
        return yield* Effect.gen(function* () {
          const { projectionLagEffect } = yield* lift(() => import('@lingtai/projector'))
          const lags = yield* projectionLagEffect()
          if (request.json) printJson('projection lag', projection.projectionLagJson(lags))
          else
            for (const line of projection.renderProjectionLag(lags, { columns: process.stdout.columns }))
              console.log(line)
          return 0
        }).pipe(orFailed('projection lag', request.json))
      }
      const { log } = yield* lift(() => import('@lingtai/event-store'))
      const { createProjectionRunner } = yield* lift(() => import('@lingtai/projector'))
      const chosen = projection.PROJECTIONS.find((p) => p.name === request.name)!
      // Drop the table, reset the checkpoint, replay — which is what makes a
      // projection's shape free to change, a rebuild rather than a migration.
      // `rebuildProjection` refuses before any of that if the log predates
      // #445's payload reset (#451). The conductor lock is taken first and for
      // the whole replay (0100 §13): a rebuild is a writer, and the lock holder
      // is the only one.
      return yield* lift(() =>
        projection.rebuildUnderLock({
          name: request.name,
          queries: log.queries,
          runnerFor: () => createProjectionRunner({ projection: chosen }),
        }),
      )
    }),
  // `upgrade` is spawned-from and `version` is what it spawns, so none of these three
  // is imported at the top; `self` is the file this process started from (`install.ts`).
  upgrade: (request) =>
    Effect.gen(function* () {
      const { upgrade } = yield* lift(() => import('./install.ts'))
      const { liveWorld } = yield* lift(() => import('./world.ts'))
      return yield* upgrade(request, liveWorld(import.meta.filename))
    }),
  rollback: (request) =>
    Effect.gen(function* () {
      const { rollback } = yield* lift(() => import('./install.ts'))
      const { liveWorld } = yield* lift(() => import('./world.ts'))
      return yield* Effect.sync(() => rollback(request, liveWorld(import.meta.filename)))
    }),
  uninstall: (request) =>
    Effect.gen(function* () {
      const { uninstall } = yield* lift(() => import('./install.ts'))
      const { liveWorld } = yield* lift(() => import('./world.ts'))
      return yield* uninstall(request, liveWorld(import.meta.filename))
    }),
}

let runners: Runners = liveRunners

/** A runner's report, then its code: a runner that failed was printed by `orFailed` around the handler, and ends 1. */
const ranWith = (work: Effect.Effect<number, unknown>): Effect.Effect<void, unknown> => Effect.flatMap(work, exitWith)

/** A refusal: the sentence, then exit 2. */
const refuse = (sentence: string): Effect.Effect<never, CommandExit> =>
  Effect.suspend(() => {
    console.error(sentence)
    return exitWith(2) as Effect.Effect<never, CommandExit>
  })

const givenNumber = (o: { _tag: string; value?: number }): number | undefined =>
  o._tag === 'Some' ? o.value : undefined

const RUN_USAGE = 'lingtai run <project> [--issue <n>] [--max <n>] [--no-merge]'

const runCommand = Command.make(
  'run',
  {
    project: Argument.String('project').pipe(Argument.optional),
    projectFlag: optionalText('project'),
    issue: integerOption('run', 'issue').pipe(Flag.optional),
    max: integerOption('run', 'max').pipe(Flag.optional),
    once: Flag.Boolean('once').pipe(Flag.withDefault(false)),
    noMerge: Flag.Boolean('no-merge').pipe(Flag.withDefault(false)),
    noColor,
  },
  (args) =>
    Effect.gen(function* () {
      if (args.noColor) applyNoColor()
      const project = given(args.project) ?? given(args.projectFlag)
      if (!project) return yield* refuse(RUN_USAGE)
      const issue = givenNumber(args.issue)
      // `--once` with no `--issue` used to be the only mode. It now means the
      // same as `--max 1`: take the queue, but stop after one.
      const max = givenNumber(args.max) ?? (args.once && issue === undefined ? 1 : undefined)
      if (max !== undefined && max < 1) return yield* refuse('--max takes a positive number')
      console.log(heading(`run ${project}`))
      yield* ranWith(
        runners.run({
          project,
          ...(issue === undefined ? {} : { issue }),
          ...(max === undefined ? {} : { max }),
          // `--no-merge` is absence of merging, so the flag's presence is the
          merge: !args.noMerge,
        }),
      )
    }).pipe(orFailed('run', false)),
).pipe(Command.withDescription(definitionOf('run').task))

const attachCommand = Command.make(
  'attach',
  { runId: Argument.String('runId').pipe(Argument.optional), noColor },
  (args) =>
    Effect.gen(function* () {
      if (args.noColor) applyNoColor()
      const runId = given(args.runId)
      if (!runId) return yield* refuse('lingtai attach <runId>')
      yield* ranWith(runners.attach({ runId }))
    }).pipe(orFailed('attach', false)),
).pipe(Command.withDescription(definitionOf('attach').task))

const END_USAGE = 'lingtai end replay [<project>] [--issue <n>]'

const endReplay = Command.make(
  'replay',
  {
    project: Argument.String('project').pipe(Argument.optional),
    issue: integerOption('end', 'issue').pipe(Flag.optional),
    noColor,
  },
  (args) =>
    Effect.gen(function* () {
      if (args.noColor) applyNoColor()
      const project = given(args.project)
      const issue = givenNumber(args.issue)
      yield* ranWith(
        runners.end({ ...(project === undefined ? {} : { project }), ...(issue === undefined ? {} : { issue }) }),
      )
    }).pipe(orFailed('end', false)),
)

// One subcommand, spelled out. `lingtai end` on its own would read like an instruction to end something.
const endCommand = Command.make('end', {}, () => refuse(END_USAGE)).pipe(
  Command.withDescription(definitionOf('end').task),
  Command.withSubcommands([endReplay]),
)

const TICKET_USAGE =
  'lingtai ticket list [--all] [--project <p>]\nlingtai ticket close <n> [--project <p>]\n' +
  'lingtai ticket new [--project <p>]\nlingtai ticket edit <n> [--project <p>]'

const projectOption = optionalText('project')

/** `close` and `edit` take a number as the argument, checked here so the sentence and exit 2 are the ones they always had. */
function ticketNumbered(verb: 'close' | 'edit') {
  return Command.make(
    verb,
    { number: Argument.String('n').pipe(Argument.optional), project: projectOption, noColor },
    (args) =>
      Effect.gen(function* () {
        if (args.noColor) applyNoColor()
        const issue = Number(given(args.number))
        if (!given(args.number) || !Number.isInteger(issue))
          return yield* refuse(`lingtai ticket ${verb} <n> [--project <p>]`)
        const project = given(args.project)
        yield* ranWith(runners.ticket({ verb, issue, ...(project === undefined ? {} : { project }) }))
      }).pipe(orFailed('ticket', false)),
  )
}

const ticketList = Command.make(
  'list',
  { all: Flag.Boolean('all').pipe(Flag.withDefault(false)), project: projectOption, json, noColor },
  (args) =>
    Effect.gen(function* () {
      if (args.noColor) applyNoColor()
      const project = given(args.project)
      yield* ranWith(
        runners.ticket({
          verb: 'list',
          all: args.all,
          json: args.json,
          ...(project === undefined ? {} : { project }),
        }),
      )
    }).pipe(orFailed('ticket list', args.json)),
)

const ticketNew = Command.make(
  'new',
  {
    project: projectOption,
    title: optionalText('title'),
    label: optionalText('label'),
    body: optionalText('body'),
    noColor,
  },
  (args) =>
    Effect.gen(function* () {
      if (args.noColor) applyNoColor()
      const project = given(args.project)
      const title = given(args.title)
      const labels = given(args.label)
      const body = given(args.body)
      yield* ranWith(
        runners.ticket({
          verb: 'new',
          ...(project === undefined ? {} : { project }),
          ...(title === undefined ? {} : { title }),
          ...(labels === undefined ? {} : { labels }),
          ...(body === undefined ? {} : { body }),
        }),
      )
    }).pipe(orFailed('ticket', false)),
)

const ticketCommand = Command.make('ticket', {}, () => refuse(TICKET_USAGE)).pipe(
  Command.withDescription(definitionOf('ticket').task),
  Command.withSubcommands([ticketList, ticketNew, ticketNumbered('close'), ticketNumbered('edit')]),
)

const rest = Argument.String('arg').pipe(Argument.variadic())

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
    Effect.gen(function* () {
      if (args.noColor) applyNoColor()
      // Loaded here, for the reason `status` gives: the conductor and the store are not for `lingtai version`.
      const { runReport } = yield* lift(() => import('./report.ts'))
      const code = yield* runReport({
        window: given(args.window),
        from: given(args.from),
        to: given(args.to),
        kind: given(args.kind),
        project: given(args.project),
        json: args.json,
      })
      yield* exitWith(code)
    }).pipe(orFailed('report', args.json)),
).pipe(Command.withDescription(definitionOf('report').task))

const backlogList = Command.make(
  'list',
  {
    project: Argument.String('project').pipe(Argument.optional),
    all: Flag.Boolean('all').pipe(Flag.withDefault(false)),
    json,
    noColor,
  },
  (args) =>
    Effect.gen(function* () {
      if (args.noColor) applyNoColor()
      const project = given(args.project)
      yield* ranWith(
        runners.backlog({
          verb: 'list',
          all: args.all,
          json: args.json,
          ...(project === undefined ? {} : { project }),
        }),
      )
    }).pipe(orFailed('backlog', false)),
)

const backlogAccept = Command.make(
  'accept',
  {
    positional: rest,
    kind: optionalText('kind'),
    unheld: Flag.Boolean('unheld').pipe(Flag.withDefault(false)),
    noColor,
  },
  (args) =>
    Effect.gen(function* () {
      if (args.noColor) applyNoColor()
      const kind = given(args.kind)
      yield* ranWith(
        runners.backlog({
          verb: 'accept',
          positional: [...args.positional],
          unheld: args.unheld,
          ...(kind === undefined ? {} : { kind }),
        }),
      )
    }).pipe(orFailed('backlog', false)),
)

const backlogDecline = Command.make('decline', { positional: rest, reason: optionalText('reason'), noColor }, (args) =>
  Effect.gen(function* () {
    if (args.noColor) applyNoColor()
    const reason = given(args.reason)
    yield* ranWith(
      runners.backlog({
        verb: 'decline',
        positional: [...args.positional],
        ...(reason === undefined ? {} : { reason }),
      }),
    )
  }).pipe(orFailed('backlog', false)),
)

// `lingtai backlog [<project>] [--all]` is the listing: `runCli` writes `list` in front of anything that is not
// a verb, so the parent has no positional of its own to share with them.
const backlogCommand = Command.make('backlog', {}, () =>
  Effect.gen(function* () {
    // No `try` here today: a failed import is a defect, which `runCli` ends as 1.
    const { BACKLOG_USAGE } = yield* lift(() => import('./backlog.ts')).pipe(Effect.orDie)
    console.log(BACKLOG_USAGE)
  }),
).pipe(
  Command.withDescription(definitionOf('backlog').task),
  Command.withSubcommands([backlogList, backlogAccept, backlogDecline]),
)

// ---- env, projection, upgrade, rollback, uninstall (#625) --------------------------------

const envProject = Argument.String('project').pipe(Argument.optional)

/** `env` is the parent of three verbs and answers none itself: its usage, exit 2, as a missing verb always was. */
function envUsage(json = false, command = 'env'): Effect.Effect<never, CommandExit> {
  return Effect.suspend(() => {
    // Under --json the failure is the error document on stdout, as everywhere else (0121 §5).
    if (json) printJsonError(command, 'usage', ENV_USAGE)
    else console.error(ENV_USAGE)
    return exitWith(2) as Effect.Effect<never, CommandExit>
  })
}

const envList = Command.make('list', { project: envProject, json, noColor }, (args) =>
  Effect.gen(function* () {
    if (args.noColor) applyNoColor()
    const project = given(args.project)
    if (!project) return yield* envUsage(args.json, 'env list')
    yield* ranWith(runners.env({ verb: 'list', project, json: args.json }))
  }).pipe(orFailed('env list', args.json)),
)

// `KEY=VALUE` is one token that starts with a letter, so `Args.text` takes it whole — a value of
// `--x` or one with its own `=` reaches the runner as typed (the first `=` splits it, in `env.ts`).
const envSet = Command.make(
  'set',
  { project: envProject, argument: Argument.String('KEY[=VALUE]').pipe(Argument.optional), noColor },
  (args) =>
    Effect.gen(function* () {
      if (args.noColor) applyNoColor()
      const project = given(args.project)
      const argument = given(args.argument)
      if (!project || !argument) return yield* envUsage()
      yield* ranWith(runners.env({ verb: 'set', project, argument }))
    }).pipe(orFailed('env set', false)),
)

const envUnset = Command.make(
  'unset',
  { project: envProject, name: Argument.String('KEY').pipe(Argument.optional), noColor },
  (args) =>
    Effect.gen(function* () {
      if (args.noColor) applyNoColor()
      const project = given(args.project)
      const name = given(args.name)
      if (!project || !name) return yield* envUsage()
      yield* ranWith(runners.env({ verb: 'unset', project, name }))
    }).pipe(orFailed('env unset', false)),
)

// `() =>`: the handler is handed the parsed args, which `envUsage` would read as `json`.
const envCommand = Command.make('env', {}, () => envUsage()).pipe(
  Command.withDescription(definitionOf('env').task),
  Command.withSubcommands([envList, envSet, envUnset]),
)

const projectionLag = Command.make('lag', { json, noColor }, (args) =>
  Effect.gen(function* () {
    if (args.noColor) applyNoColor()
    yield* ranWith(runners.projection({ verb: 'lag', json: args.json }))
  }).pipe(orFailed('projection lag', args.json)),
)

const projectionRebuild = Command.make(
  'rebuild',
  { name: Argument.String('name').pipe(Argument.optional), noColor },
  (args) =>
    Effect.gen(function* () {
      if (args.noColor) applyNoColor()
      const name = given(args.name)
      if (!name) return yield* refuse('lingtai projection rebuild <name>')
      // Named, not discovered (0022): `PROJECTIONS` in `projection.ts` is the list, and
      // `help.test.ts` holds the names in `commands.ts` to it.
      if (!(PROJECTION_NAMES as readonly string[]).includes(name))
        return yield* refuse(`${symbol.fail()} unknown projection "${name}" — known: ${PROJECTION_NAMES.join(', ')}`)
      yield* ranWith(runners.projection({ verb: 'rebuild', name }))
    }).pipe(orFailed('projection rebuild', false)),
)

const projectionCommand = Command.make('projection', {}, () => refuse(commandHelp('projection'))).pipe(
  Command.withDescription(definitionOf('projection').task),
  Command.withSubcommands([projectionLag, projectionRebuild]),
)

const upgradeCommand = Command.make(
  'upgrade',
  { despiteDoctor: Flag.Boolean('despite-doctor').pipe(Flag.withDefault(false)), noColor },
  (args) =>
    Effect.gen(function* () {
      if (args.noColor) applyNoColor()
      yield* ranWith(runners.upgrade({ despiteDoctor: args.despiteDoctor }))
    }).pipe(orFailed('upgrade', false)),
).pipe(Command.withDescription(definitionOf('upgrade').task))

const rollbackCommand = Command.make(
  'rollback',
  { version: Argument.String('version').pipe(Argument.optional), noColor },
  (args) =>
    Effect.gen(function* () {
      if (args.noColor) applyNoColor()
      const version = given(args.version)
      yield* ranWith(runners.rollback(version === undefined ? {} : { version }))
    }).pipe(orFailed('rollback', false)),
).pipe(Command.withDescription(definitionOf('rollback').task))

const uninstallCommand = Command.make(
  'uninstall',
  {
    yes: Flag.Boolean('yes').pipe(Flag.withDefault(false)),
    nothingConducts: Flag.Boolean('nothing-conducts').pipe(Flag.withDefault(false)),
    noColor,
  },
  (args) =>
    Effect.gen(function* () {
      if (args.noColor) applyNoColor()
      yield* ranWith(runners.uninstall({ yes: args.yes, nothingConducts: args.nothingConducts }))
    }).pipe(orFailed('uninstall', false)),
).pipe(Command.withDescription(definitionOf('uninstall').task))

// ------------------------------------------------------- the daemon commands --
//
// (#622) `start`, `daemon`, `service`, `restart`, `shutdown`, `pause` and `resume`. Their code
// lives in `daemon.ts`, which has no side effects at import: `lingtai.ts` runs `main` when it
// is loaded, and the supervisor's plist still runs that file with `daemon`.

/** Every handler here ends the same way: a thrown error is a sentence and exit 1. */
function daemonHandler(
  args: { noColor: boolean },
  run: () => Effect.Effect<number, unknown>,
  jsonCommand?: string,
): Effect.Effect<void, CommandExit> {
  return Effect.gen(function* () {
    if (args.noColor) applyNoColor()
    yield* Effect.flatMap(run(), exitWith)
  }).pipe(
    // A script reading `--json` gets the error document on stdout, not an empty string.
    printedBy((err) =>
      jsonCommand === undefined
        ? wizardFailed(err)
        : printJsonError(jsonCommand, 'failed', err instanceof Error ? err.message : String(err)),
    ),
  )
}

const startFlags = {
  noConduct: Flag.Boolean('no-conduct').pipe(Flag.withDefault(false)),
  noMerge: Flag.Boolean('no-merge').pipe(Flag.withDefault(false)),
  verbose: Flag.Boolean('verbose').pipe(Flag.withDefault(false)),
  noColor,
}

/**
 * One snapshot writer for as long as the daemon runs (0124 §5), acquired in the CLI's own
 * Effect and closed when the command returns. The imports stay dynamic like every heavy one here.
 */
function withDaemonWriter(
  run: (writer: Pick<SnapshotWriter, 'offer'>) => Effect.Effect<void, CommandExit>,
): Effect.Effect<void, CommandExit> {
  return Effect.scoped(
    Effect.gen(function* () {
      const { log } = yield* Effect.promise(() => import('@lingtai/event-store'))
      const { makeSnapshotWriter } = yield* Effect.promise(() => import('@lingtai/event-store/snapshot-writer'))
      const writer = yield* makeSnapshotWriter(log.snapshots, (line) => console.error(line))
      yield* run(writer)
    }),
  )
}

function startCommand(name: 'start' | 'daemon') {
  return Command.make(name, startFlags, (args) =>
    withDaemonWriter((writer) =>
      daemonHandler(args, () =>
        Effect.gen(function* () {
          const { daemonCommand } = yield* lift(() => import('./daemon.ts'))
          const flags: Record<string, string> = {
            ...(args.noConduct ? { 'no-conduct': '' } : {}),
            ...(args.noMerge ? { 'no-merge': '' } : {}),
          }
          // Said when the lock is won; a daemon that did not start has said why, and says nothing more.
          // `another daemon holds the lock — nothing to do` stays a quiet line, not a failure (0121 §1).
          return yield* lift(() =>
            daemonCommand(
              flags,
              null,
              name === 'start' ? () => console.log(`${symbol.pass()} started`) : null,
              startIsVerbose(name, args.verbose),
              writer,
            ),
          )
        }),
      ),
    ),
  ).pipe(Command.withDescription(definitionOf(name).task))
}

const whyArg = Argument.String('why').pipe(Argument.variadic())
const reasonOption = optionalText('reason')

const optionalProject = Argument.String('project').pipe(Argument.optional)

const pause = Command.make('pause', { project: optionalProject, noColor }, (args) =>
  daemonHandler(args, () =>
    Effect.gen(function* () {
      const { controlCommand } = yield* lift(() => import('./daemon.ts'))
      return yield* controlCommand('pause', { project: given(args.project) })
    }),
  ),
).pipe(Command.withDescription(definitionOf('pause').task))

const resume = Command.make('resume', { project: optionalProject, noColor }, (args) =>
  daemonHandler(args, () =>
    Effect.gen(function* () {
      const { controlCommand } = yield* lift(() => import('./daemon.ts'))
      return yield* controlCommand('resume', { project: given(args.project) })
    }),
  ),
).pipe(Command.withDescription(definitionOf('resume').task))

const ceilingRaiseCommand = Command.make(
  'raise',
  { usd: Argument.String('usd').pipe(Argument.optional), noColor },
  (args) =>
    daemonHandler(args, () =>
      Effect.gen(function* () {
        const raise = yield* lift(() => import('./ceiling-raise.ts'))
        const toUsd = raise.parseUsd(given(args.usd))
        if (toUsd === undefined) {
          console.error('lingtai ceiling raise <usd> — <usd> is a positive number of dollars')
          return 2
        }
        return yield* raise.ceilingRaise({
          toUsd,
          by: `human:${process.env['USER'] ?? 'operator'}`,
          log: (line) => console.log(line),
        })
      }),
    ),
)

const ceilingCommand = Command.make('ceiling', {}, () =>
  Effect.suspend(() => {
    console.error(commandHelp('ceiling'))
    return exitWith(2)
  }),
).pipe(Command.withDescription(definitionOf('ceiling').task), Command.withSubcommands([ceilingRaiseCommand]))
const accountLift = Command.make(
  'lift',
  { runtime: Argument.String('runtime').pipe(Argument.optional), noColor },
  (args) =>
    daemonHandler(args, () =>
      Effect.gen(function* () {
        const { liftAccount } = yield* lift(() => import('./account-lift.ts'))
        return yield* liftAccount(given(args.runtime), `human:${process.env['USER'] ?? 'operator'}`)
      }).pipe(
        // Its own sentence: the message alone, never `wizardFailed`'s stack under LINGTAI_DEBUG.
        printedBy((err) => {
          console.error(err instanceof Error ? err.message : String(err))
          return 1
        }),
      ),
    ),
)

const accountCommand = Command.make('account', {}, () =>
  Effect.suspend(() => {
    console.error(commandHelp('account'))
    return exitWith(2)
  }),
).pipe(Command.withDescription(definitionOf('account').task), Command.withSubcommands([accountLift]))

const shutdown = Command.make(
  'shutdown',
  {
    why: whyArg,
    reason: reasonOption,
    force: Flag.Boolean('force').pipe(Flag.withDefault(false)),
    timeout: optionalText('timeout'),
    noColor,
  },
  (args) =>
    daemonHandler(args, () =>
      Effect.gen(function* () {
        const { controlCommand } = yield* lift(() => import('./daemon.ts'))
        return yield* controlCommand('shutdown', {
          reason: given(args.reason) ?? args.why.join(' '),
          ...(args.timeout._tag === 'Some' ? { timeout: args.timeout.value } : {}),
          force: args.force,
        })
      }),
    ),
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
    dirty: Flag.Boolean('dirty').pipe(Flag.withDefault(false)),
    despiteDoctor: Flag.Boolean('despite-doctor').pipe(Flag.withDefault(false)),
    force: Flag.Boolean('force').pipe(Flag.withDefault(false)),
    timeout: optionalText('timeout'),
    noConduct: Flag.Boolean('no-conduct').pipe(Flag.withDefault(false)),
    noMerge: Flag.Boolean('no-merge').pipe(Flag.withDefault(false)),
    noColor,
  },
  (args) =>
    withDaemonWriter((writer) =>
      daemonHandler(args, () =>
        Effect.gen(function* () {
          const { restartCommand } = yield* lift(() => import('./daemon.ts'))
          return yield* restartCommand(restartArgs!, createSteps(console.log), writer)
        }),
      ),
    ),
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
  return Command.make(verb, withWhy ? { why: whyArg, noColor } : { noColor }, (parsed) => {
    const args = parsed as { why?: readonly string[]; noColor: boolean }
    return daemonHandler(args, () =>
      Effect.gen(function* () {
        const { serviceOptions } = yield* lift(() => import('./daemon.ts'))
        const { serviceCommand, SHUTDOWN_BOARD_ONLY, START_BOARD_ONLY } = yield* lift(() => import('./service.ts'))
        const why = args.why ? [...args.why] : []
        const steps = createSteps(console.log)
        // `serviceCommand` begins the phases it has (draining, starting); these two have none of their own.
        if (verb === 'install') steps.begin('writing')
        if (verb === 'uninstall') steps.begin('removing')
        let unconfirmed = false // the supervisor already had a conductor process
        let boardHad = false // ...and a board process, or no board job or build, so the board's start was not made either
        const code = yield* serviceCommand([verb, ...(why.length > 0 ? [why.join(' ')] : [])], {
          ...serviceOptions(),
          steps,
          unconfirmed: (job) => {
            if (job === 'conductor') unconfirmed = true
            else boardHad = true
          },
        }).pipe(
          // A throw (EACCES on the service file, say) must not leave the spinner animating.
          Effect.ensuring(Effect.sync(() => steps.end())),
        )
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
    )
  }).pipe(Command.withDescription(`${verb} the daemon and the board jobs`))
}

const serviceStatus = Command.make('status', { json, noColor }, (args) =>
  daemonHandler(
    args,
    () =>
      Effect.gen(function* () {
        const { serviceOptions } = yield* lift(() => import('./daemon.ts'))
        const { serviceCommand } = yield* lift(() => import('./service.ts'))
        return yield* serviceCommand(['status'], { ...serviceOptions(), json: args.json })
      }),
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
    accountCommand,
    pause,
    resume,
    ceilingCommand,
  ]),
)

const run = Command.runWith(root, { version: versionFacts().lingtai })

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
    log: (...args) => void process.stdout.write(`${text(process.stdout, args)}\n`),
    error: (...args) => {
      if (json) errors.push(stripColour(args.map(String).join(' ')).trim())
      else process.stderr.write(`${text(process.stderr, args)}\n`)
    },
  }
}

/**
 * A usage error is the error and nothing else, as it was on `@effect/cli`: the
 * default presenter prints the command's whole help before it, which under
 * `--json` would put a page of text on stdout beside the one error document.
 * Help asked for and `--version` are presented as the default does.
 */
const USAGE_ERRORS_ONLY: CliOutput.Presenter = {
  present: (event) =>
    event._tag === 'InvalidInvocation'
      ? // The sentence alone: the formatter heads it `ERROR` and indents it, which
        // is noise on a terminal and two lines of layout inside `--json`'s message.
        Console.error(event.errors.map((error) => error.message).join('\n'))
      : CliOutput.defaultPresenter.present(event),
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
      'lingtai board shutdown does not exist — shutdown means finish the attempt in flight, and waits as long as the ' +
      'wall limit for it. A board has no attempt to finish: pnpm lingtai board stop, which returns at once'
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
      "lingtai service stop is gone — it was the supervisor's signal, which kills an attempt in flight 20 seconds in.",
    )
    console.error('pnpm lingtai service shutdown "why" drains through the log, waits for the attempt, then unloads.')
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
  let handlerExited = false
  const code = await Effect.runPromise(
    run(argv.slice(2)).pipe(
      Effect.provide(CliOutput.layerPresenter(USAGE_ERRORS_ONLY)),
      Effect.provideService(Console.Console, consoleFor(globalThis.console, json, errors)),
      Effect.provide(NodeServices.layer),
      Effect.as(0),
      Effect.catchTag('CommandExit', (e) => {
        handlerExited = true
        return Effect.succeed(e.code)
      }),
      Effect.catchCause(() => Effect.succeed(1)),
    ),
  )
  // A handler that failed on its own has already said so; `usage` is for what did not parse.
  if (code !== 0 && json && !handlerExited) {
    const command = args.find((a) => !a.startsWith('-')) ?? 'lingtai'
    return printJsonError(command, 'usage', errors.join('\n') || 'invalid usage')
  }
  return code
}
