/**
 * Which route an argv takes, and the router that decides it.
 *
 * No library imports beyond the definitions, on purpose: `entry.ts` runs on import and a test cannot
 * load it, so the decision is here, where a unit test can. A word that is not a command in
 * `commands.ts` is never shown to `@effect/cli` — it would add `--version`, `--help` and `--wizard`
 * to answers that are ours — so it is `unknown` and `entry.ts` says so itself.
 */
import { isCommand } from './commands.ts'

export type Route = 'effect' | 'help' | 'retired' | 'unknown'

/**
 * Verbs that were renamed (#1269). They are not commands — never in `commands.ts`, so never in the help,
 * the generated docs or `@effect/cli` — and the router sends them to a refusal that names the new verb.
 */
export const RETIRED: Readonly<Record<string, string>> = {
  'grant-fix-round': 'fix-refusal',
  rerun: 'redo-step',
  requeue: 'start-new-attempt',
}

/** The new verb for a retired one, or undefined for any other word. */
export function retiredVerb(word: string): string | undefined {
  return Object.hasOwn(RETIRED, word) ? RETIRED[word] : undefined
}

/**
 * `lingtai --version <more>` is `lingtai version <more>` (#740): the first word only, so the line is
 * `version`'s own and `@effect/cli` never owns the root. `-v` is not answered.
 */
export function versionFlagAsCommand(argv: readonly string[]): string[] {
  return argv[0] === '--version' ? ['version', ...argv.slice(1)] : [...argv]
}

export function routeOf(argv: readonly string[]): Route {
  const first = argv[0] ?? ''
  // Before `--help`: a retired verb has no help to give, only the name that replaced it.
  if (retiredVerb(first) !== undefined) return 'retired'
  const helped = argv.some((a) => a === '--help' || a === '-h')
  // `version`'s help is `@effect/cli`'s (#617); every other command's is the definition's (0121 §6).
  if (first !== 'version' && helped) return 'help'
  if (isCommand(first)) return 'effect'
  // Help is a question, never an instruction (0121 §8): `--help` anywhere, as a whole
  // argument, is answered from the definitions before any command sees it.
  if (argv.length === 0 || ['help', '--help', '-h'].includes(first)) return 'help'
  return 'unknown'
}
