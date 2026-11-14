import { join } from 'node:path'

/**
 * The stand-in exclusions srt needs (#1152) live in a file **of their own for each wrapped command**, beside the
 * mirror's `info/exclude`, never in it and never shared between commands. `info/exclude` is read by every worktree
 * of the mirror, so a name written there is policy for every pass; and a file shared by two running commands
 * cannot be rewritten without a reader seeing it half-written. Each command gets a new file, written whole before
 * the command starts and removed after, so nothing a running command reads is ever rewritten. It carries the
 * global ignore rules *that command's own environment* would have resolved, since pointing a command at it
 * replaces them.
 */
export const SANDBOX_EXCLUDE_FILE = 'lingtai-sandbox-exclude'

export const sandboxExcludePath = (mirror: string, id: string): string =>
  join(mirror, 'info', `${SANDBOX_EXCLUDE_FILE}-${id}`)

/**
 * The file's text for `names`: each once, in order, then `inherited` — the global ignore file the command would
 * have read, because `core.excludesFile` replaces rather than adds, and a rule the project configured (`.env.local`)
 * must still hold. Names come first so a negation in the inherited rules is still the later, winning line.
 */
export function excludeFileText(names: readonly string[], inheritedRaw = ''): string {
  // Git skips a UTF-8 BOM only at the very start of an ignore file; behind our names it would stick to the first pattern.
  const inherited = inheritedRaw.startsWith('\uFEFF') ? inheritedRaw.slice(1) : inheritedRaw
  const unique = [...new Set(names)]
  const head = unique.length === 0 ? '' : `${unique.join('\n')}\n`
  if (inherited.trim() === '') return head
  return `${head}${inherited.endsWith('\n') ? inherited : `${inherited}\n`}`
}

/** The config file that sets `core.excludesFile` to `excludeFile`, for `excludeEnv` to include. */
export const excludeConfigText = (excludeFile: string): string =>
  `[core]\n\texcludesFile = "${excludeFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`

/**
 * The environment that points git at `configFile` (which sets `core.excludesFile`), keeping any config already
 * passed — **for the worktree's own repository alone**. The command's descendants include other repositories
 * (a submodule, a clone), and `/.vscode` is anchored to *their* root: a bare `core.excludesFile` would silently
 * drop their `settings.json` from `git add -A`. So it is an `includeIf.gitdir:` on exactly this worktree's git
 * directory (no trailing slash, so no `**`: a submodule's directory under it does not match).
 */
export function excludeEnv(
  configFile: string,
  gitdir: string,
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  const n = Number.parseInt(env['GIT_CONFIG_COUNT'] ?? '0', 10)
  const at = Number.isFinite(n) && n > 0 ? n : 0
  return {
    ...env,
    GIT_CONFIG_COUNT: String(at + 1),
    [`GIT_CONFIG_KEY_${at}`]: `includeIf.gitdir:${gitdir}.path`,
    [`GIT_CONFIG_VALUE_${at}`]: configFile,
  }
}
