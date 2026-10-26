/**
 * Which commands `@effect/cli` owns (#616), and the router that decides it.
 *
 * No library imports, on purpose: `entry.ts` runs on import and a test cannot
 * load it, so the decision is here, where a unit test can. A command not named
 * in `MIGRATED_COMMANDS` is never shown to `@effect/cli` — it would add
 * `--version`, `--help` and `--wizard` to commands that have their own answer.
 */
export const MIGRATED_COMMANDS = [
  'version',
  'status',
  'doctor',
  'init',
  'add',
  'approve',
  'requeue',
  'grant-fix-round',
  'close',
  'answer',
  'ask',
  'now',
  'board',
  'run',
  'attach',
  'ticket',
  'end',
  'backlog',
  'env',
  'projection',
  'upgrade',
  'rollback',
  'uninstall',
  'start',
  'daemon',
  'service',
  'restart',
  'shutdown',
  'pause',
  'resume',
] as const

export type Route = 'effect' | 'help' | 'lingtai'

export function routeOf(argv: readonly string[]): Route {
  const first = argv[0] ?? ''
  const helped = argv.some((a) => a === '--help' || a === '-h')
  // `version`'s help is `@effect/cli`'s (#617); every other migrated command's is the definition's (0121 §6).
  if (first !== 'version' && helped) return 'help'
  if ((MIGRATED_COMMANDS as readonly string[]).includes(first)) return 'effect'
  // Help is a question, never an instruction (0121 §8): `--help` anywhere, as a whole
  // argument, is answered from the definitions before any command sees it.
  if (argv.length === 0 || ['help', '--help', '-h'].includes(first) || argv.some((a) => a === '--help' || a === '-h'))
    return 'help'
  return 'lingtai'
}
