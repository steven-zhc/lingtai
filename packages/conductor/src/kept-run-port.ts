import type { KeptRunActionDeps, KeptRunAnswer } from '@lingtai/actions'
/**
 * **The `run` at `implement`'s port into git** — the commit `createKeptRunAction`
 * is handed, lifted out into its own module for `file-port.ts`'s reason: so a
 * test can hold it ([0066](../../../doc/decisions-archive/0066-a-large-answer-is-a-locator-on-the-log.md)
 * §4, `#303`, `#390`).
 *
 * ## What it does, and in which order
 *
 * `keep` follows `conduct.ts`'s own `keep` at `design` (`filePlugin`'s, in
 * `packages/recipe/src/recipe.ts:571`'s words, *"`file:` keeps what the action
 * before it made"*) — stage, then ask whether anything is staged, then commit
 * only where there is a difference, then ask git where `HEAD` landed:
 *
 * - `git add -A`, excluding the planted env file by pathspec — a formatter can
 *   touch any file, so unlike `design`'s `keep`, which stages one path, this
 *   stages everything *but* one.
 * - `git diff --cached --quiet`. A clean answer means nothing changed, so
 *   `keep` returns `{ clean: true }` and commits nothing.
 * - `git commit`, naming the action in the message. A refusal here is
 *   `{ notKept }`, in words a person reads.
 * - `git rev-parse HEAD`, and `recordCompletion` is called with it — the same
 *   `RunProducedDiff` and `RunProposedCompletion` the agent's own commit gets,
 *   so `stepsOn` in `@lingtai/domain` keeps reading every verdict after this
 *   one off the run's own stream rather than filtering them out.
 *
 * ## Why the planted env file is excluded, and why `restore` runs no `git clean`
 *
 * `provisionWorktree` plants a `.env.local`-shaped file under `recipe.env.plantAt`
 * (`packages/repo/src/worktree.ts`), mode `0600`, and nothing adds it to
 * `.git/info/exclude`. A `git add -A` with no exclusion would commit it the
 * moment a managed repository's own `.gitignore` does not cover it, and the merge
 * lane would land the secrets it carries. The same fact is why `restore` is
 * `git reset --hard HEAD` and never `git clean`: a `clean` would delete that
 * same untracked file whenever it is not `.gitignore`d, on every run whose
 * command failed.
 *
 * ## What it is allowed to know, and what it is not
 *
 * It knows its own plugin's shape — a command's changes, committed or not — and
 * nothing about the command itself: `keep` and `restore` take no argument that
 * says what ran or why. That is `createKeptRunAction`'s to decide; this module
 * only does the git.
 */
import { Either } from 'effect'

/** A git command in the worktree, exactly the shape `conduct.ts`'s own `gitAsked` already is. */
export type GitHere = (args: string[]) => Promise<Either.Either<string, { readonly detail: string }>>

export interface KeptRunPortOptions {
  git: GitHere
  /**
   * `recipe.env.plantAt` — the one path `git add -A` must never stage, so the
   * planted credentials never reach a commit this port makes.
   */
  plantAt: string
  /** The ticket's ref, for the commit message — `FileActionDeps.issue`'s own closure. */
  issue: () => Promise<{ readonly ref: string }>
  /**
   * Records the new head exactly as the agent's own dispatch does —
   * `recordDiff` and `RunProposedCompletion`, so every verdict after this one
   * is judged against a head on the run's own stream.
   */
  recordCompletion: (head: string) => Promise<void>
}

export function keptRunPort(options: KeptRunPortOptions): KeptRunActionDeps {
  const { git, plantAt, issue, recordCompletion } = options

  return {
    async keep(spec): Promise<KeptRunAnswer> {
      const added = await git(['add', '-A', '--', '.', `:(exclude)${plantAt}`])
      if (Either.isLeft(added)) return { notKept: `git add refused it: ${added.left.detail}` }

      // `--quiet` implies `--exit-code`: a *right* here is *nothing staged*,
      // and a left is a difference to commit — `design`'s own `keep` reads this
      // the same way, and for the same reason (`recipe.ts`'s `keep`).
      const staged = await git(['diff', '--cached', '--quiet'])
      if (!Either.isLeft(staged)) return { clean: true }

      const ref = (await issue()).ref
      const committed = await git(['commit', '-m', `chore(implement): ${spec.name} for #${ref}`])
      if (Either.isLeft(committed)) return { notKept: `git commit refused it: ${committed.left.detail}` }

      const head = await git(['rev-parse', 'HEAD'])
      if (Either.isLeft(head)) return { notKept: `git rev-parse refused it: ${head.left.detail}` }

      await recordCompletion(head.right)
      return { committed: head.right }
    },

    async restore(): Promise<void> {
      // No `git clean`, and the header says why: the planted env file is
      // untracked, and a clean would delete it whenever a managed repository's
      // own `.gitignore` does not cover it.
      await git(['reset', '--hard', 'HEAD'])
    },
  }
}
