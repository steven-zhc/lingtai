import { join } from 'node:path'

/**
 * The stand-in exclusions srt needs (#1152) live in a file of their own beside the mirror's `info/exclude`,
 * never in it. `info/exclude` is read by every worktree of the mirror, so a name written there is policy for
 * every pass and every command, kept run included — an unsandboxed pass would silently lose `.vscode/…` from
 * `git add -A`. This file is read only by a command that is told to (`excludeEnv`), so the policy stays with
 * the command that needs it. Its content is a constant, so writing it again never changes what another pass sees.
 */
export const SANDBOX_EXCLUDE_FILE = 'lingtai-sandbox-exclude'

export const sandboxExcludePath = (mirror: string): string => join(mirror, 'info', SANDBOX_EXCLUDE_FILE)

/** The file's text for `names`: each once, in order. */
export function excludeFileText(names: readonly string[]): string {
  const unique = [...new Set(names)]
  return unique.length === 0 ? '' : `${unique.join('\n')}\n`
}

/** The environment that points git, for one command, at that file (`core.excludesFile`), keeping any config already passed. */
export function excludeEnv(mirror: string, env: Readonly<Record<string, string>>): Record<string, string> {
  const n = Number.parseInt(env['GIT_CONFIG_COUNT'] ?? '0', 10)
  const at = Number.isFinite(n) && n > 0 ? n : 0
  return {
    ...env,
    GIT_CONFIG_COUNT: String(at + 1),
    [`GIT_CONFIG_KEY_${at}`]: 'core.excludesFile',
    [`GIT_CONFIG_VALUE_${at}`]: sandboxExcludePath(mirror),
  }
}
