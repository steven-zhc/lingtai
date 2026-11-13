/**
 * The names srt plants in a worktree on Linux, each a `/dev/null` bind (experiment 017). `git add -A` inside
 * srt fails on them unless the mirror's `info/exclude` names them; the conductor writes them there, anchored
 * to the root, under a *sandboxed* decision only (#1152).
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
