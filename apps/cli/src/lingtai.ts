#!/usr/bin/env node
/**
 * `lingtai` — the entry point.
 *
 * Deliberately hand-rolled argument parsing. design.md §8 is a list of things
 * not being built until a specific failure demands them, and a dependency for
 * three subcommands is exactly the kind of thing it is warning about.
 *
 * Everything here loads `@lingtai/event-store`, which loads the environment from
 * the repository root — see `packages/event-store/src/env.ts`. Never read
 * `process.env` for a connection string directly.
 */

import { boardPort } from '@lingtai/env'
import { log } from '@lingtai/event-store'
import { createProjectionRunner, projectionLag } from '@lingtai/projector'

import { parseFlags } from './add.ts'
import { attach } from './attach.ts'
import { backlogCommand } from './backlog.ts'
import { boardCommand, builtBoardDir, parseBoardArgs } from './board.ts'
import { isCommand } from './commands.ts'
import { PROJECTIONS, daemonCommand, liveBoardWorld, serviceOptions } from './daemon.ts'
import { endReplay } from './end.ts'
import { envCommand } from './env.ts'
import { commandHelp, rootHelp } from './help.ts'
import { rebuildProjection } from './projection.ts'
import { run as runOnceCommand } from './run.ts'
import { serviceCommand } from './service.ts'
import { createSteps } from './steps.ts'
import { ticketClose, ticketEdit, ticketList, ticketNew } from './ticket.ts'
import { versionLine } from './version.ts'

async function projectionCommand(args: string[]): Promise<number> {
  const [sub, name] = args

  if (sub === 'lag') {
    const lags = await projectionLag()
    if (lags.length === 0) {
      console.log('no projection has a checkpoint yet')
      return 0
    }
    for (const l of lags) {
      console.log(`${l.name}\t${l.lastSeq}/${l.headSeq}\t${l.lag} behind\t${l.updatedAt?.toISOString() ?? 'never'}`)
    }
    return 0
  }

  if (sub === 'rebuild') {
    if (!name) {
      console.error('lingtai projection rebuild <name>')
      return 2
    }
    // Named, not discovered. A list whose only job was to let a projection be
    // written and silently left out of it — no table, no checkpoint, no failing
    // check — is what 0022 refused; `PROJECTIONS` is written out above, and a
    // projection missing from it is missing from `--help` too — `help.test.ts`
    // holds the names in `commands.ts` to it.
    const projection = PROJECTIONS.find((p) => p.name === name)
    if (!projection) {
      console.error(`unknown projection "${name}" — known: ${PROJECTIONS.map((p) => p.name).join(', ')}`)
      return 2
    }
    // Drop the table, reset the checkpoint, replay — which is what makes a
    // projection's shape free to change, a rebuild rather than a migration.
    // `rebuildProjection` refuses before any of that if the log predates
    // #445's payload reset (#451).
    return rebuildProjection({
      name,
      queries: log.queries,
      runnerFor: () => createProjectionRunner({ projection }),
    })
  }

  // Gone, and answered by name rather than by falling through to the usage.
  //
  // It was an alias for `lingtai daemon`, and that is exactly what made it
  // confusing: it read as a second way to follow the log, when it was only the
  // same one wearing another name. Two names for one process is how "why is
  // the board stale" gets a different answer depending on which name you
  // happened to learn. Since 0022 there is one behaviour everywhere — every
  // process that appends holds a projector while it runs.
  if (sub === 'run') {
    console.error(
      'lingtai projection run is gone — it was another name for lingtai daemon, which is the process that follows the projections. Use that.',
    )
    return 2
  }

  console.error(commandHelp('projection'))
  return 2
}

async function main(argv: string[]): Promise<number> {
  const [asked, ...rest] = argv
  // Narrowed to `commands.ts`, so the switch below is held to the definitions by
  // `satisfies never`: a command with no case, or a case with no definition, fails typecheck.
  if (!isCommand(asked)) {
    // `entry.ts` answers help, and an empty line, before this file is imported (#617);
    // here for a process started from this file, as a service's plist starts it.
    if (asked === undefined) {
      console.error(rootHelp())
      return 2
    }
    if (asked === 'help' || asked === '--help' || asked === '-h') {
      console.log(rootHelp())
      return 0
    }
    console.error(`unknown command "${asked}"\n\n${rootHelp()}`)
    return 2
  }
  const command = asked

  switch (command) {
    case 'run': {
      const { flags } = parseFlags(rest)
      const positional = rest.filter((a) => !a.startsWith('--') && a !== flags['issue'] && a !== flags['max'])
      const project = positional.find((p) => p !== '--once') ?? flags['project']
      if (!project) {
        console.error('lingtai run <project> [--issue <n>] [--max <n>] [--no-merge]')
        return 2
      }

      // `--once` with no `--issue` used to be the only mode. It now means the
      // same as `--max 1`: take the queue, but stop after one.
      const issue = 'issue' in flags ? Number(flags['issue']) : undefined
      if (issue !== undefined && !Number.isInteger(issue)) {
        console.error('--issue takes a number')
        return 2
      }
      const max = 'max' in flags ? Number(flags['max']) : 'once' in flags && issue === undefined ? 1 : undefined
      if (max !== undefined && (!Number.isInteger(max) || max < 1)) {
        console.error('--max takes a positive number')
        return 2
      }

      return runOnceCommand({
        project,
        ...(issue === undefined ? {} : { issue }),
        ...(max === undefined ? {} : { max }),
        // `--no-merge` is absence of merging, so the flag's presence is the
        merge: !('no-merge' in flags),
      })
    }
    case 'backlog':
      return backlogCommand(rest)
    case 'ticket': {
      const [verb, ...ticketRest] = rest
      const { positional, flags } = parseFlags(ticketRest)
      const project = flags['project']
      if (verb === 'list') {
        if (positional.length > 0) {
          console.error('lingtai ticket list [--all] [--project <p>]')
          return 2
        }
        return ticketList({ ...(project === undefined ? {} : { project }), all: 'all' in flags })
      }
      if (verb === 'close') {
        const issue = Number(positional[0])
        if (!positional[0] || !Number.isInteger(issue)) {
          console.error('lingtai ticket close <n> [--project <p>]')
          return 2
        }
        return ticketClose({ issue, ...(project === undefined ? {} : { project }) })
      }
      if (verb === 'new') {
        if (positional.length > 0) {
          console.error('lingtai ticket new [--project <p>]')
          return 2
        }
        return ticketNew(project === undefined ? {} : { project })
      }
      if (verb === 'edit') {
        const issue = Number(positional[0])
        if (!positional[0] || !Number.isInteger(issue)) {
          console.error('lingtai ticket edit <n> [--project <p>]')
          return 2
        }
        return ticketEdit({ issue, ...(project === undefined ? {} : { project }) })
      }
      console.error(
        'lingtai ticket list [--all] [--project <p>]\nlingtai ticket close <n> [--project <p>]\n' +
          'lingtai ticket new [--project <p>]\nlingtai ticket edit <n> [--project <p>]',
      )
      return 2
    }
    case 'attach': {
      const runId = parseFlags(rest).positional[0]
      if (!runId) {
        console.error('lingtai attach <runId>')
        return 2
      }
      // Ctrl-C detaches rather than killing the process, so the command gets to
      // say that the run is still going and where its log is. Nothing is being
      // stopped: this is a reader, and 0034's file does not know it has one.
      const detach = new AbortController()
      process.on('SIGINT', () => detach.abort())
      return attach({ runId, signal: detach.signal })
    }
    case 'board': {
      const parsed = parseBoardArgs(rest)
      if ('refused' in parsed) {
        console.error(parsed.refused)
        return 2
      }
      // `--port` is this run's; without it the machine file's, and without that
      // 17820 (#187). A file that does not parse is refused by name here rather
      // than serving on a port nobody chose.
      let port: number
      try {
        port = parsed.port ?? boardPort()
      } catch (err) {
        console.error((err as Error).message)
        return 1
      }
      return boardCommand({ ...parsed, port, dir: parsed.dir ?? builtBoardDir() }, liveBoardWorld())
    }
    // Positional throughout, and not through `parseFlags`: a value is an
    // argument here, and `KEY=--anything` is a legitimate one.
    case 'env':
      return envCommand(rest)
    case 'end': {
      const { positional, flags } = parseFlags(rest)
      // One subcommand, spelled out. `lingtai end` on its own would read like
      // an instruction to end something.
      if (positional[0] !== 'replay') {
        console.error('lingtai end replay [<project>] [--issue <n>]')
        return 2
      }
      const issue = 'issue' in flags ? Number(flags['issue']) : undefined
      if (issue !== undefined && !Number.isInteger(issue)) {
        console.error('--issue takes a number')
        return 2
      }
      return endReplay({
        ...(positional[1] === undefined ? {} : { project: positional[1] }),
        ...(issue === undefined ? {} : { issue }),
      })
    }
    // `start`, `daemon` and `service` keep working here though `entry.ts` routes them to
    // `@effect/cli` (#622): every installed LaunchAgent and systemd unit runs THIS file with
    // `daemon` (`launchdPlist`, `systemdUnit`, `DAEMON_JOB.argv` in `service.ts`), and
    // `integration/service.test.ts` runs `lingtai.ts service status` directly.
    case 'start':
    // **`daemon` still answers, and that is not indecision** (`#159`). An
    // installed LaunchAgent or systemd unit has `lingtai daemon` written into
    // its plist, and renaming a command must not stop a supervisor that is
    // already on disk. `start` is the name; this is the one it used to have.
    case 'daemon':
      return daemonCommand(parseFlags(rest).flags)
    case 'service': {
      const steps = createSteps(console.log)
      // A spinner started by the drain's wait must not outlive the command.
      return serviceCommand(rest, { ...serviceOptions(), steps }).finally(() => steps.end())
    }
    case 'projection':
      return projectionCommand(rest)
    // `entry.ts` answers this before the log is loaded; here for a process
    // started from this file, as a service's plist starts it.
    case 'version':
      console.log(versionLine())
      return 0
    // `init`, `add`, `status`, `doctor` and the commands that answer a wait are `@effect/cli`'s (#618, #619, #620, #621) and `entry.ts` routes
    // them there; they are named here only because the command list is exhaustive.
    case 'restart':
    case 'shutdown':
    case 'pause':
    case 'resume':
    case 'init':
    case 'add':
    case 'status':
    case 'doctor':
    case 'approve':
    case 'requeue':
    case 'grant-fix-round':
    case 'close':
    case 'answer':
    case 'ask':
    case 'now':
      console.error(`lingtai ${command} runs from the entry — pnpm lingtai ${command}, or the installed lingtai`)
      return 2
    // The same: `entry.ts` answers these before the log is loaded (`install.ts`).
    case 'upgrade':
    case 'rollback':
    case 'uninstall':
      console.error(
        `lingtai ${command} runs from the entry, before the log is loaded — pnpm lingtai ${command}, or the installed lingtai`,
      )
      return 2
    default:
      return command satisfies never
  }
}

/**
 * Every ending is a sentence, not a stack trace.
 *
 * The commands report their own refusals and return an exit code, but anything
 * that *throws* went straight to Node — which printed a stack, a file path and
 * a version banner over the one line that mattered. `lingtai add` against a
 * repository whose default branch has no recipe did exactly that, and the
 * README's claim that "every refusal names itself" was false for it.
 *
 * The stack is still there for the errors that are bugs rather than refusals;
 * it just has to be asked for.
 *
 * A promise and not a top-level `await`: `pnpm build` bundles this file to CJS
 * for a SEA (#183), and CJS has no top-level `await`.
 */
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    const error = err as Error
    console.error(error.message || String(err))
    if (process.env['LINGTAI_DEBUG']) console.error(error.stack)
    else console.error('\n(LINGTAI_DEBUG=1 for the stack)')
    process.exitCode = 1
  },
)
