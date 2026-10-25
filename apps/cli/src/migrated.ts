/**
 * Which commands `@effect/cli` owns (#616), and the router that decides it.
 *
 * No library imports, on purpose: `entry.ts` runs on import and a test cannot
 * load it, so the decision is here, where a unit test can. A command not named
 * in `MIGRATED_COMMANDS` is never shown to `@effect/cli` — it would add
 * `--version`, `--help` and `--wizard` to commands that have their own answer.
 */
export const MIGRATED_COMMANDS = ['version'] as const

/** `upgrade`, `rollback`, `uninstall` — answered by `install.ts` before `lingtai.ts` is imported. */
const INSTALL_ONLY = ['upgrade', 'rollback', 'uninstall'] as const

export type Route = 'effect' | 'init' | 'install' | 'lingtai'

export function routeOf(argv: readonly string[]): Route {
  const first = argv[0] ?? ''
  if ((MIGRATED_COMMANDS as readonly string[]).includes(first)) return 'effect'
  if (first === 'init') return 'init'
  if ((INSTALL_ONLY as readonly string[]).includes(first)) return 'install'
  return 'lingtai'
}
