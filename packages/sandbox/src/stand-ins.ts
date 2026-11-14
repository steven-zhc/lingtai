/**
 * The names srt plants in a worktree on Linux, each a `/dev/null` bind (experiment 017). `git add -A` inside
 * srt fails on them unless git is told to exclude them. Under a *sandboxed* decision only (#1152) provisioning
 * writes them, anchored to the root, into a side file beside the mirror's `info/exclude`, and each wrapped
 * command is pointed at it through its environment (`excludeEnv`): a caller that omits that fails on them.
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
