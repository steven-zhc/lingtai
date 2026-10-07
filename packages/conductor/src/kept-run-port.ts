/**
 * **The git a `run:` at `implement` needs** — `kept-run-action.ts`'s `clean`
 * and `keep` — lifted out of `conduct.ts` for `file-port.ts`'s reason (`#303`):
 * a closure inside a two-thousand-line function is a place no test can reach,
 * and the two things `doc/design/390.md` warns about by name are both here.
 *
 * - **`clean` resets to the agent's own `HEAD`, never to the base.** The base
 *   is what the worktree was cut at; resetting there would throw away the
 *   agent's commit.
 * - **The planted env file is spared by both calls.** `provisionWorktree`
 *   writes it untracked and unignored, so `git clean` would delete it and
 *   `git add -A` would commit its secrets.
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
   * Stages everything but the planted env file and commits it, where there is
   * a difference from `HEAD`. `-A` is safe because `clean` ran first: nothing
   * is in the tree but what `HEAD` held and what the command just did to it.
   */
  const keep = async (name: string): Promise<KeptRunAnswer> => {
    const added = await git(['add', '-A', '--', '.', `:(exclude)${plantAt}`])
    if (Either.isLeft(added)) return { failed: `git add refused it: ${added.left.detail}` }
    // `--quiet` implies `--exit-code`: a right is *nothing staged*.
    const staged = await git(['diff', '--cached', '--quiet'])
    if (!Either.isLeft(staged)) return { nothing: true }
    const committed = await git(['commit', '-m', `chore(implement): ${name} for #${issue}`])
    if (Either.isLeft(committed)) return { failed: `git commit refused it: ${committed.left.detail}` }
    const head = await git(['rev-parse', 'HEAD'])
    if (Either.isLeft(head)) return { failed: `git rev-parse refused it: ${head.left.detail}` }
    await recordCompletion(head.right)
    return { committed: head.right }
  }

  return { clean, keep }
}
