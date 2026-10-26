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
import { isCommand } from './commands.ts'
import { rootHelp } from './help.ts'
import { versionLine } from './version.ts'

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
    // **Not in the entry group below, though `board` is `@effect/cli`'s (#623).**
    // `lingtai service` writes the board job as `node <root>/apps/cli/src/lingtai.ts
    // board start --no-open` (`BOARD_JOB.argv`, `service.ts` — the launchd plist and
    // the systemd `ExecStart`), and `keeper` refuses a plist that does not name this
    // file. A refusal here would exit every installed board job 2, and launchd
    // would respawn it every thirty seconds (#187). One parser, two doors.
    case 'board':
      return (await import('./cli.ts')).runCli(['node', 'lingtai', 'board', ...rest])
    // **`@effect/cli`'s too (#622), and answered here for the same reason as `board`.** Every
    // installed LaunchAgent and systemd unit runs THIS file with `daemon` (`DAEMON_JOB.argv`,
    // `launchdPlist`, `systemdUnit` in `service.ts`), and `integration/service.test.ts` runs
    // `lingtai.ts service status` directly. A refusal here would exit every installed daemon job 2.
    // `daemon` still answers (`#159`): an installed plist has it written in, and renaming a command
    // must not stop a supervisor that is already on disk. One parser, two doors.
    case 'start':
    case 'daemon':
    case 'service':
    case 'restart':
    case 'shutdown':
    case 'pause':
    case 'resume':
      return (await import('./cli.ts')).runCli(['node', 'lingtai', command, ...rest])
    // `entry.ts` answers this before the log is loaded; here for a process
    // started from this file, as a service's plist starts it.
    case 'version':
      console.log(versionLine())
      return 0
    // `init`, `add`, `status`, `doctor`, the commands that answer a wait, `run`, `attach`, `ticket`, `end` and `backlog`, and
    // `env` and `projection` are `@effect/cli`'s (#618, #619, #620, #621, #624, #625) and `entry.ts` routes
    // them there; they are named here only because the command list is exhaustive.
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
    case 'run':
    case 'attach':
    case 'ticket':
    case 'end':
    case 'backlog':
    case 'env':
    case 'projection':
      console.error(`lingtai ${command} runs from the entry — pnpm lingtai ${command}, or the installed lingtai`)
      return 2
    // The same: `cli.ts` answers these before the log is loaded (`install.ts`).
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
