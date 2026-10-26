/**
 * Which route an argv takes, and the router that decides it.
 *
 * No library imports beyond the definitions, on purpose: `entry.ts` runs on import and a test cannot
 * load it, so the decision is here, where a unit test can. A word that is not a command in
 * `commands.ts` is never shown to `@effect/cli` — it would add `--version`, `--help` and `--wizard`
 * to answers that are ours — so it is `unknown` and `entry.ts` says so itself.
 */
import { isCommand } from './commands.ts'

export type Route = 'effect' | 'help' | 'unknown'

export function routeOf(argv: readonly string[]): Route {
  const first = argv[0] ?? ''
  const helped = argv.some((a) => a === '--help' || a === '-h')
  // `version`'s help is `@effect/cli`'s (#617); every other command's is the definition's (0121 §6).
  if (first !== 'version' && helped) return 'help'
  if (isCommand(first)) return 'effect'
  // Help is a question, never an instruction (0121 §8): `--help` anywhere, as a whole
  // argument, is answered from the definitions before any command sees it.
  if (argv.length === 0 || ['help', '--help', '-h'].includes(first)) return 'help'
  return 'unknown'
}
