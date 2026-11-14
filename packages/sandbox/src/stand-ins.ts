/**
 * The names srt plants in a worktree on Linux, each a `/dev/null` bind (experiment 017). `git add -A` inside
 * srt fails on them unless they are excluded. Under a *sandboxed* decision provisioning merges `standInExcludes`
 * into the mirror's `info/exclude` (#1152), which every worktree of the mirror reads, so:
 *
 * - an untracked root-level `/.vscode/…`, `/.idea/…`, `/.mcp.json` or `/.gitmodules` is not added in a sandboxed
 *   project, inside srt or out (the kept run's own `git add -A` included). Nested copies still are, and tracked
 *   files are unaffected;
 * - a project that later turns the sandbox off keeps the lines — nothing is written under another decision, and
 *   removing a line is a write — until its mirror is re-cloned.
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
