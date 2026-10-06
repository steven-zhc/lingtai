import type { KeptRunActionDeps, KeptRunAnswer, RestoreAnswer } from '@lingtai/actions'
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
 * - `git add -A`, excluding the planted env file and everything `baseline`
 *   named by pathspec. A formatter can touch any file, so unlike `design`'s
 *   `keep`, which stages one known path, this stages everything *but* two
 *   kinds of exception — and the second kind is why this module takes a
 *   `baseline` at all (see *What `baseline` protects, and why* below).
 * - `git diff --cached --quiet`, scoped to the same exclusion — not only the
 *   add, because a file `baseline` named may already have been staged by the
 *   agent before this ran, and an unscoped diff would read that pre-existing
 *   staged content as "the run changed something" even where it changed
 *   nothing at all.
 * - `git commit`, naming the action in the message and scoped to the same
 *   exclusion, so a commit this run makes carries only what it changed —
 *   never a baseline file that happened to be staged already, which a
 *   pathspec-less `git commit` would sweep in despite `git add -A` never
 *   having touched it. A refusal here is `{ notKept }`, in words a person
 *   reads.
 * - `git rev-parse HEAD`, and `recordCompletion` is called with it — the same
 *   `RunProducedDiff` and `RunProposedCompletion` the agent's own commit gets,
 *   so `stepsOn` in `@lingtai/domain` keeps reading every verdict after this
 *   one off the run's own stream rather than filtering them out.
 *
 * `restore` is `git restore --source=HEAD --staged --worktree` and then
 * `git clean -fd`, both scoped away from the planted env file and from
 * `baseline` — the design this implements
 * ([doc/design/390.md](../../../doc/design/390.md) §*Failure*) calls for
 * exactly this pair, and the first is `restore` rather than `reset --hard`
 * because `--hard` takes no pathspec at all: scoping it to "everything but
 * `baseline`" is the only way to put the run's own changes back without
 * reverting a baseline file this port never touched. The two steps are tried
 * independently rather than one gating the other — `git clean` does not take
 * the index lock `git restore` does, so a stale `.git/index.lock` that fails
 * the restore still lets the clean remove what the run left untracked. Either
 * step's refusal is answered, not swallowed: `restore` returns `{ failed }`
 * rather than claiming a tree it did not actually put back.
 *
 * ## What `baseline` protects, and why
 *
 * The agent that ran before this action may have left the worktree carrying
 * work it decided against — an edit to a file it never staged, a scratch file
 * it never tracked. That is not this action's to touch, and it is not the
 * command's output either: `git add -A` with no exclusion for it would sweep
 * it into the command's commit, and `git clean -fd` with no exclusion for it
 * would delete it outright the moment the command fails. `baseline()` is read
 * *before* the command runs, so both `keep` and `restore` can tell "already
 * here" apart from "the command's doing" and leave the former alone in either
 * direction — committed or deleted.
 *
 * ## Why the planted env file is excluded
 *
 * `provisionWorktree` plants a `.env.local`-shaped file under `recipe.env.plantAt`
 * (`packages/repo/src/worktree.ts`), mode `0600`, and nothing adds it to
 * `.git/info/exclude`. A `git add -A` with no exclusion would commit it the
 * moment a managed repository's own `.gitignore` does not cover it, and the merge
 * lane would land the secrets it carries — and a `git clean -fd` with no
 * exclusion would delete that same untracked file. Both are pathspec
 * exclusions rather than `.gitignore` entries, because the worktree is not
 * this port's to edit.
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
   * `recipe.env.plantAt` — the one path `git add -A` and `git clean -fd` must
   * never touch, so the planted credentials never reach a commit this port
   * makes, and never get deleted by its restore either.
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

/** A `:(exclude)` pathspec for every name in `paths`, so `git` is told to leave each one alone. */
function excluding(paths: Iterable<string>): string[] {
  return [...paths].map((path) => `:(exclude)${path}`)
}

export function keptRunPort(options: KeptRunPortOptions): KeptRunActionDeps {
  const { git, plantAt, issue, recordCompletion } = options

  return {
    async baseline(): Promise<ReadonlySet<string>> {
      // `-z`: without it, `git status` C-quotes a path that carries a space or
      // a non-ASCII byte (`"new scratch.ts"`, quotes included), and that quoted
      // text then fails to match the real file when reused as a `:(exclude)`
      // pathspec. `-z` prints every path verbatim, NUL-terminated.
      const status = await git([
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '-z',
        '--',
        '.',
        `:(exclude)${plantAt}`,
      ])
      if (Either.isLeft(status)) return new Set()
      const tokens = status.right.split('\0').filter((token) => token.length > 0)
      const paths = new Set<string>()
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!
        paths.add(token.slice(3))
        // A rename or copy prints two NUL-terminated paths — the entry's own,
        // then the path it was renamed or copied from. The second is not a
        // path in the worktree today, so it names nothing to exclude.
        if (token[0] === 'R' || token[0] === 'C') i++
      }
      return paths
    },

    async keep(spec, baseline): Promise<KeptRunAnswer> {
      const exclude = [`:(exclude)${plantAt}`, ...excluding(baseline)]

      const added = await git(['add', '-A', '--', '.', ...exclude])
      if (Either.isLeft(added)) return { notKept: `git add refused it: ${added.left.detail}` }

      // `--quiet` implies `--exit-code`: a *right* here is *nothing staged*,
      // and a left is a difference to commit — `design`'s own `keep` reads this
      // the same way, and for the same reason (`recipe.ts`'s `keep`). Scoped to
      // the same pathspec as the add: unscoped, a baseline file the agent had
      // already staged before this ran would read as a difference on its own.
      const staged = await git(['diff', '--cached', '--quiet', '--', '.', ...exclude])
      if (!Either.isLeft(staged)) return { clean: true }

      const ref = (await issue()).ref
      // Scoped the same way: a `git commit` with no pathspec commits every
      // staged change, including a baseline file `add -A` above never touched
      // but that was staged before this action ran.
      const committed = await git(['commit', '-m', `chore(implement): ${spec.name} for #${ref}`, '--', '.', ...exclude])
      if (Either.isLeft(committed)) return { notKept: `git commit refused it: ${committed.left.detail}` }

      const head = await git(['rev-parse', 'HEAD'])
      if (Either.isLeft(head)) return { notKept: `git rev-parse refused it: ${head.left.detail}` }

      await recordCompletion(head.right)
      return { committed: head.right }
    },

    async restore(baseline): Promise<RestoreAnswer> {
      const exclude = [`:(exclude)${plantAt}`, ...excluding(baseline)]

      // `reset --hard` takes no pathspec, so it cannot spare `baseline`; this
      // is the pathspec-aware equivalent — put tracked files the run touched
      // back to `HEAD`, excluding the planted env file and every baseline
      // path, in both the index and the worktree.
      const restored = await git(['restore', '--source=HEAD', '--staged', '--worktree', '--', '.', ...exclude])
      // Tried regardless of whether the restore above succeeded: `git clean`
      // never touches the index, so a stale `.git/index.lock` that refuses the
      // restore still lets this remove what the run left untracked.
      const cleaned = await git(['clean', '-fd', '--', '.', ...exclude])

      if (Either.isLeft(restored) && Either.isLeft(cleaned)) {
        return {
          failed: `git restore refused it: ${restored.left.detail}; git clean refused it: ${cleaned.left.detail}`,
        }
      }
      if (Either.isLeft(restored)) return { failed: `git restore refused it: ${restored.left.detail}` }
      if (Either.isLeft(cleaned)) return { failed: `git clean refused it: ${cleaned.left.detail}` }

      return { ok: true }
    },
  }
}
