/**
 * **The git a `run:` at `implement` needs** — `kept-run-action.ts`'s `clean`
 * and `keep` — lifted out of `conduct.ts` for `file-port.ts`'s reason (`#303`):
 * a closure inside a two-thousand-line function is a place no test can reach,
 * and the two things `doc/design/390.md` warns about by name are both here.
 *
 * - **`clean` resets to the agent's own `HEAD`, never to the base.** The base
 *   is what the worktree was cut at; resetting there would throw away the
 *   agent's commit.
 * - **The planted env file is spared by both calls, but not the same way.**
 *   Whether a repository's own `.gitignore` covers that path is the
 *   repository's choice, not something either call can assume (`#470`):
 *   `clean -fd` is told the path by name so it is never swept away with an
 *   untracked directory, and `keep` stages everything and then unstages the
 *   path afterward, which works whether or not the path was ignored to begin
 *   with.
 *
 * `clean` is two git calls, in order, and neither reads the tree before acting
 * on it: `reset --hard HEAD` drops every tracked change, and `clean -fd` removes
 * what was left untracked. Nothing is compared against a baseline taken
 * earlier. An earlier round of this ticket tried that, and a command's rewrite
 * of a file the agent had left dirty survived both calls. `implement`'s own
 * contract already settles it: an uncommitted change does not survive the pass
 * (`prompts/ticket.md`).
 *
 * **`-e /<plantAt>`, not a `:(exclude)` pathspec, on the clean.** A pathspec
 * still lets `git clean -fd` remove an untracked directory whole, with the
 * planted file inside it; `-e` with a leading `/` names exactly the one path.
 */
import type { CleanAnswer, KeptRunAnswer } from '@lingtai/actions'
import { Either } from 'effect'

/** A git command in the worktree, the shape `conduct.ts`'s `gitAsked` already has. */
export type GitHere = (args: string[]) => Promise<Either.Either<string, { readonly detail: string }>>

export interface KeptRunPortOptions {
  git: GitHere
  /** `recipe.env.plantAt` — the one path neither call may touch. */
  plantAt: string
  /** The ticket's ref, for the commit message. */
  issue: string
  /**
   * Records the new head the way the agent's own commit is recorded — the diff
   * and `RunProposedCompletion` — so the log agrees with the head (`#390`).
   */
  recordCompletion: (head: string) => Promise<void>
}

/**
 * **Stages everything, then unstages the planted env file** (`#470`) —
 * never a `:(exclude)` pathspec on the `add`. `git add -A -- . ':(exclude)
 * <path>'` exits 1 whenever `<path>` is itself covered by `.gitignore`, even
 * though it staged everything else, so a repository that ignores the planted
 * file could never be kept. `git reset -q -- <path>` unstages it
 * unconditionally afterward instead — ignored or not, staged by an earlier
 * `add` or not — which never fails on either ground.
 */
export async function stageEverythingExceptPlanted(
  git: GitHere,
  plantAt: string,
): Promise<{ ok: true } | { failed: string }> {
  const added = await git(['add', '-A'])
  if (Either.isLeft(added)) return { failed: `git add refused it: ${added.left.detail}` }
  const unstaged = await git(['reset', '-q', '--', plantAt])
  if (Either.isLeft(unstaged)) return { failed: `git reset refused it: ${unstaged.left.detail}` }
  return { ok: true }
}

/**
 * The WIP commit `conduct.ts`'s `keepUncommittedWork` makes of a stopped
 * run's dirty tree (`#468`, `#470`) — lifted out so an integration test can
 * drive it against a real repository, which is the only way to see
 * `stageEverythingExceptPlanted`'s own trap. The identity is explicit because
 * nothing else configures one in this worktree, and signing is off for the
 * same reason `--no-verify` is: a failed hook or a missing key must not cost
 * this one commit. `conduct.ts` keeps the parent `rev-parse`, `wipParent`,
 * and the run-log notes around this call — only the staging and the commit
 * move here.
 */
export async function commitWipExceptPlanted(
  git: GitHere,
  plantAt: string,
  message: string,
): Promise<{ ok: true } | { failed: string }> {
  const staged = await stageEverythingExceptPlanted(git, plantAt)
  if ('failed' in staged) return staged
  const committed = await git([
    '-c',
    'user.name=Lingtai',
    '-c',
    'user.email=lingtai@users.noreply.github.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--no-verify',
    '-m',
    message,
  ])
  if (Either.isLeft(committed)) return { failed: `git commit refused it: ${committed.left.detail}` }
  return { ok: true }
}

export function keptRunPort(options: KeptRunPortOptions): {
  clean: () => Promise<CleanAnswer>
  keep: (name: string) => Promise<KeptRunAnswer>
} {
  const { git, plantAt, issue, recordCompletion } = options

  const clean = async (): Promise<CleanAnswer> => {
    const reset = await git(['reset', '--hard', 'HEAD'])
    if (Either.isLeft(reset)) return { failed: `git reset refused it: ${reset.left.detail}` }
    const cleaned = await git(['clean', '-fd', '-e', `/${plantAt}`])
    if (Either.isLeft(cleaned)) return { failed: `git clean refused it: ${cleaned.left.detail}` }
    return { ok: true }
  }

  /**
   * Stages everything, unstages the planted env file, and commits what is
   * left, where there is a difference from `HEAD`. `-A` is safe because
   * `clean` ran first: nothing is in the tree but what `HEAD` held and what
   * the command just did to it.
   */
  const keep = async (name: string): Promise<KeptRunAnswer> => {
    const staged = await stageEverythingExceptPlanted(git, plantAt)
    if ('failed' in staged) return staged
    // `--quiet` implies `--exit-code`: a right is *nothing staged*.
    const diffed = await git(['diff', '--cached', '--quiet'])
    if (!Either.isLeft(diffed)) return { nothing: true }
    const committed = await git(['commit', '-m', `chore(implement): ${name} for #${issue}`])
    if (Either.isLeft(committed)) return { failed: `git commit refused it: ${committed.left.detail}` }
    const head = await git(['rev-parse', 'HEAD'])
    if (Either.isLeft(head)) return { failed: `git rev-parse refused it: ${head.left.detail}` }
    await recordCompletion(head.right)
    return { committed: head.right }
  }

  return { clean, keep }
}
