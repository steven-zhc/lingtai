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
import { posix } from 'node:path'

import type { CleanAnswer, KeptRunAnswer, RestoreAnswer } from '@lingtai/actions'
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

/**
 * **Whether a `git status --porcelain` answer is a clean tree once the planted
 * env file is set aside** (`#468`, `#587`). A repository that does not ignore
 * `plantAt` shows `?? <plantAt>` after every pass, and a check that counted it
 * would reset, and record a note, on every clean review. Porcelain's own
 * format is two status characters, a space, then the path. **Only the untracked
 * line is set aside**: `A  <plantAt>` is a reviewer having staged it, which
 * the next fixer's commit would carry.
 */
export function onlyThePlantedFileIsDirty(porcelain: string, plantAt: string): boolean {
  return statusLines(porcelain).every((line) => line === `?? ${plantAt}`)
}

/**
 * `-z` answers are NUL-separated and never quote a path; the plain answer is
 * newline-separated, and git quotes a path with a space or a non-ASCII
 * character in it (`?? "private env"`), which no literal comparison matches.
 */
function statusLines(porcelain: string): string[] {
  return porcelain.split(porcelain.includes('\0') ? '\0' : '\n').filter((line) => line.trim() !== '')
}

const STATUS = ['status', '--porcelain', '-z', '--untracked-files=all']

/**
 * **Puts the worktree back at `onSha` after a review** (`#587`). Reads first
 * and acts only on a difference, so a review that changed nothing runs no
 * reset and records nothing; what it found is the sentence that goes to the
 * run log and the review's `evidence`. `-e /<plantAt>` spares the planted file
 * as `clean` does, and there is no `-x`: ignored files are not the reviewer's
 * to lose.
 */
export function restoreAfterReview(options: {
  git: GitHere
  plantAt: string
}): (onSha: string) => Promise<RestoreAnswer> {
  const { git } = options
  // Planting resolves the path, so `./.env.local` and `.env.local` are one file;
  // porcelain and `clean -e` only know the normalized spelling.
  const plantAt = posix.normalize(options.plantAt)
  return async (onSha) => {
    const head = await git(['rev-parse', 'HEAD'])
    if (Either.isLeft(head)) return { failed: `git rev-parse refused it: ${head.left.detail}` }
    // Per file, not per directory: plain porcelain collapses an untracked
    // directory to `?? private/`, which would never equal `?? private/.env.local`.
    const status = await git(STATUS)
    if (Either.isLeft(status)) return { failed: `git status refused it: ${status.left.detail}` }
    // The worktree is cut detached. A branch checked out in it is the
    // reviewer's doing, and `reset` would move that branch's tip.
    const symbolic = await git(['symbolic-ref', '-q', 'HEAD'])
    const branch = Either.isRight(symbolic) ? symbolic.right.trim() : ''
    const moved = head.right.trim() !== onSha || branch !== ''
    const dirty = !onlyThePlantedFileIsDirty(status.right, plantAt)
    if (!moved && !dirty) return { untouched: true }

    const paths = statusLines(status.right)
      .filter((line) => line !== `?? ${plantAt}`)
      .map((line) => line.slice(3))
    const shown = paths.slice(0, 10).join(', ') + (paths.length > 10 ? `, and ${paths.length - 10} more` : '')
    const found = [
      moved
        ? `HEAD was ${head.right.trim().slice(0, 7)}${branch === '' ? '' : ` on ${branch}`}, not ${onSha.slice(0, 7)}`
        : undefined,
      dirty ? `${paths.length} path${paths.length === 1 ? '' : 's'} changed (${shown})` : undefined,
    ].filter((part) => part !== undefined)

    // `--mixed`, then a checkout from the index, and not `--hard`: a reviewer
    // that committed the planted file leaves it tracked, and `--hard` would
    // delete it because `onSha` does not have it. Mixed moves `HEAD` and the
    // index and leaves the files, so the planted one survives; the checkout
    // puts every tracked file back, and the clean takes what `onSha` lacks.
    // Leave the branch where it is: detach first, so the reset moves only HEAD.
    // Detach where HEAD already is, with `update-ref --no-deref` and not a
    // checkout: `checkout --detach` refuses on unresolved merge conflicts, and
    // `--force` at `onSha` would rewrite the tree and delete a planted file the
    // reviewer committed on the branch, before anything could spare it. The
    // `reset` below clears the merge state.
    if (branch !== '') {
      const detached = await git(['update-ref', '--no-deref', 'HEAD', head.right.trim()])
      if (Either.isLeft(detached)) return { failed: `git update-ref refused it: ${detached.left.detail}` }
    }
    const reset = await git(['reset', '--mixed', onSha])
    if (Either.isLeft(reset)) return { failed: `git reset refused it: ${reset.left.detail}` }
    const checkout = await git(['checkout', '--', '.'])
    if (Either.isLeft(checkout)) return { failed: `git checkout refused it: ${checkout.left.detail}` }
    // `-ff`: a single `-f` skips a nested repository and exits 0.
    // `-e` takes a gitignore pattern, so a path with `[`, `*`, `?` or `\` in it
    // would name some other file, or none: escape it to the one literal path.
    const literal = plantAt.replace(/[\\*?[\] ]/g, '\\$&')
    const cleaned = await git(['clean', '-ffd', '-e', `/${literal}`])
    if (Either.isLeft(cleaned)) return { failed: `git clean refused it: ${cleaned.left.detail}` }
    // A command that exited 0 has not shown the tree is clean: ask again.
    const after = await git(STATUS)
    if (Either.isLeft(after)) return { failed: `git status refused it: ${after.left.detail}` }
    if (!onlyThePlantedFileIsDirty(after.right, plantAt)) {
      return {
        failed: `the worktree is still dirty after the restore: ${statusLines(after.right).slice(0, 10).join(', ')}`,
      }
    }
    return { restored: `the reviewer changed the worktree — ${found.join('; ')} — restored to ${onSha.slice(0, 7)}` }
  }
}
