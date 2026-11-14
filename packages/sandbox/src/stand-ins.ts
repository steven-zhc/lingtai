/**
 * The names srt plants in a worktree on Linux, each a `/dev/null` bind (experiment 017). `git add -A` inside
 * srt fails on them unless git is told to exclude them. Provisioning writes nothing (#1152): each wrapped
 * command gets a file of its own beside the mirror's `info/exclude` (`makeRunSandbox`), and is pointed at it
 * through its environment (`excludeEnv`). A caller that wraps without that preparation fails on them.
 */
export const SRT_STAND_INS: readonly string[] = [
  '.bashrc',
  '.bash_profile',
  '.gitconfig',
  '.gitmodules',
  '.idea',
  '.mcp.json',
  '.profile',
  '.ripgreprc',
  '.vscode',
  '.zprofile',
  '.zshrc',
]

/** The exclude lines for them: anchored to the repository root, so a nested `.vscode/` is still added. */
export const standInExcludes: readonly string[] = SRT_STAND_INS.map((name) => `/${name}`)
