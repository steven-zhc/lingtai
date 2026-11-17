/**
 * **Applies the previous attempt's kept WIP to a fresh worktree, as a diff, before
 * any agent runs** (#1170, 0109 §8). The git is here, beside `kept-run-port.ts`,
 * for the same reason: a closure inside `conduct.ts` is a place no test reaches.
 *
 * - **Never `checkout <sha> -- .` or `reset --hard <sha>`.** Either overwrites
 *   what landed on the base since the WIP was made. The only reset here is to
 *   `HEAD`, the base the worktree was just cut at.
 * - **The diff goes to a file, not through stdout.** `repo.git` has no stdin and
 *   decodes stdout as trimmed text, which loses a patch's last newline and
 *   corrupts a non-UTF-8 hunk — a silent partial apply.
 * - **A path that does not apply is left at the base** and named, and the
 *   edits land unstaged, as a stopped run's dirty tree looks.
 */
import { Effect, Result } from 'effect'

import { type GitHere, onlyThePlantedFileIsDirty } from './kept-run-port.ts'

/** A git whose stdout is handed back untrimmed: `-z` output is paths, and a leading space belongs to one. */
export type RawGit = (args: string[], options?: { trim: false }) => ReturnType<GitHere>

/** What the brief and the event say about the carry. */
export interface CarriedWork {
  /** Paths now in the worktree, uncommitted. */
  applied: string[]
  /** Paths left at the base's version because the patch did not apply to them. */
  leftOut: string[]
  /** Why nothing was applied, or null when something was. */
  unapplied: string | null
}

/** The WIP's own diff flags: the output is pinned so it can be parsed and applied. */
// `--find-renames` is pinned (never `diff.renames=copies`) so the patch and the rename lookup agree.
// The prefixes are pinned too: `diff.noprefix` / `diff.mnemonicPrefix` would make `apply -p1` strip a real directory.
const DIFF_FLAGS = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--binary',
  '--find-renames',
  '--src-prefix=a/',
  '--dst-prefix=b/',
]

const none = (why: string): CarriedWork => ({ applied: [], leftOut: [], unapplied: why })

const paths = (z: string): string[] => z.split('\0').filter((p) => p !== '')

export function carryKeptWork(options: {
  git: RawGit
  /** `fetch origin refs/heads/<arm>`, with retry where the caller has one. */
  fetchArm: (arm: string) => Effect.Effect<Result.Result<string, { readonly detail: string }>>
  plantAt: string
  kept: { arm: string; sha: string; parentSha: string }
}): Effect.Effect<CarriedWork | null> {
  const { git, fetchArm, plantAt, kept } = options
  return Effect.gen(function* () {
    const fetched = yield* fetchArm(kept.arm)
    if (Result.isFailure(fetched)) return none(`${kept.arm} could not be fetched: ${fetched.failure.detail}`)
    for (const sha of [kept.sha, kept.parentSha]) {
      const there = yield* git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])
      if (Result.isFailure(there)) return none(`${sha.slice(0, 7)} is not on ${kept.arm}, so it could not be fetched`)
    }

    const where = yield* git(['rev-parse', '--git-path', 'lingtai-wip.patch'])
    if (Result.isFailure(where)) return none(`the diff could not be written: ${where.failure.detail}`)
    const patch = where.success
    const written = yield* git(['diff', ...DIFF_FLAGS, `--output=${patch}`, kept.parentSha, kept.sha])
    if (Result.isFailure(written)) return none(`the diff could not be produced: ${written.failure.detail}`)

    const listed = yield* git(['apply', '--numstat', '-z', patch])
    if (Result.isFailure(listed)) return none(`the diff could not be read: ${listed.failure.detail}`)
    const touched = numstatPaths(listed.success)
    if (touched.length === 0) return null
    // `apply --numstat` names only the new path of a rename; the source comes from `diff --name-status`.
    const status = yield* git(
      ['diff', '--name-status', '-z', '--no-ext-diff', '--find-renames', kept.parentSha, kept.sha],
      {
        trim: false,
      },
    )
    if (Result.isFailure(status)) return none(`the diff could not be read: ${status.failure.detail}`)
    const sources = renameSources(status.success)

    const applied = yield* git(['apply', '--3way', patch])
    let leftOut: string[] = []
    /** The left-out paths that may hold conflict state; a path refused whole wrote nothing. */
    let conflicted: string[] = []
    if (Result.isFailure(applied)) {
      const unmerged = yield* git(['diff', '--name-only', '--diff-filter=U', '-z'], { trim: false })
      if (Result.isFailure(unmerged)) {
        // An unreadable conflict list is not an empty one: conflict markers may be in the tree.
        const stuck = yield* backToTheCut(git, plantAt)
        return none(
          `the conflicting paths could not be listed (${unmerged.failure.detail})` +
            (stuck === null
              ? ', so nothing was carried'
              : `, and the worktree could not be returned to the base (${stuck}); check \`git status\``),
        )
      }
      leftOut = paths(unmerged.success).filter((p) => touched.includes(p))
      conflicted = leftOut
      if (leftOut.length === 0) {
        // `git apply` is atomic: a path refused without a conflict (the base deleted it, say) aborts
        // the whole patch. Return to the cut and apply path by path, so only that path is left out.
        const stuck = yield* backToTheCut(git, plantAt)
        if (stuck !== null) {
          return none(
            `the diff did not apply (${applied.failure.detail}), and the worktree could not be returned to the base (${stuck}); check \`git status\``,
          )
        }
        for (const path of touched) {
          const one = yield* git(['apply', '--3way', `--include=${globEscape(path)}`, patch])
          if (Result.isFailure(one)) leftOut.push(path)
        }
        const after = yield* git(['diff', '--name-only', '--diff-filter=U', '-z'], { trim: false })
        if (Result.isFailure(after)) {
          const stuck = yield* backToTheCut(git, plantAt)
          return none(
            `the conflicting paths could not be listed (${after.failure.detail})` +
              (stuck === null
                ? ', so nothing was carried'
                : `, and the worktree could not be returned to the base (${stuck}); check \`git status\``),
          )
        }
        conflicted = paths(after.success).filter((p) => leftOut.includes(p))
        if (leftOut.length === touched.length) {
          const left = yield* backToTheCut(git, plantAt)
          return none(
            left === null
              ? `the diff did not apply: ${applied.failure.detail}`
              : `the diff did not apply, and the worktree could not be returned to the base (${left}); check \`git status\``,
          )
        }
      }
      // A conflicted rename left its source deleted in the index too: restore both ends.
      const restore = new Set(conflicted)
      for (const to of conflicted) {
        const from = sources.get(to)
        if (from !== undefined) restore.add(from)
      }
      for (const path of restore) {
        const known = yield* git(['cat-file', '-e', `HEAD:${path}`])
        // `--literal-pathspecs`: a name such as `a*.txt` is a file, never a pattern.
        const done = Result.isSuccess(known)
          ? yield* git(['--literal-pathspecs', 'checkout', 'HEAD', '--', path])
          : yield* git(['--literal-pathspecs', 'rm', '-f', '-q', '--', path])
        if (Result.isFailure(done)) {
          const stuck = yield* backToTheCut(git, plantAt)
          return none(
            `${path} could not be restored to the base (${done.failure.detail})` +
              (stuck === null
                ? ', so nothing was carried'
                : `, and the worktree could not be returned to the base (${stuck}); check \`git status\``),
          )
        }
      }
    }
    // `--3way` implies `--index`; the worktree should look like a stopped run's dirty tree.
    const unstaged = yield* git(['reset', '-q'])
    if (Result.isFailure(unstaged)) {
      const stuck = yield* backToTheCut(git, plantAt)
      return none(
        `the carried edits could not be unstaged (${unstaged.failure.detail})` +
          (stuck === null
            ? ', so nothing was carried'
            : `, and the worktree could not be returned to the base (${stuck}); check \`git status\``),
      )
    }
    return { applied: touched.filter((p) => !leftOut.includes(p)), leftOut, unapplied: null }
  })
}

/** `--include` takes a glob; a file name is not one. */
const globEscape = (path: string): string => path.replace(/[\\*?[]/g, '\\$&')

/** `apply --numstat -z` is `added\tdeleted\tpath\0` — a rename shows only its new path. */
function numstatPaths(out: string): string[] {
  const found: string[] = []
  for (const field of out.split('\0')) {
    const m = /^(?:\d+|-)\t(?:\d+|-)\t(.+)$/s.exec(field)
    if (m) found.push(m[1]!)
  }
  return found
}

/** `diff --name-status -z` is `X\0path\0`, or `R100\0old\0new\0` for a rename or copy: new path to old. */
function renameSources(out: string): Map<string, string> {
  const fields = out.split('\0')
  const sources = new Map<string, string>()
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i]!
    if (code === '') continue
    if (code.startsWith('R') || code.startsWith('C')) {
      const from = fields[i + 1]
      const to = fields[i + 2]
      // A copy leaves its source in place; only a rename deletes it.
      if (code.startsWith('R') && from && to) sources.set(to, from)
      i += 2
    } else i += 1
  }
  return sources
}

/**
 * The tree is just cut at the base, so `HEAD` is the only safe thing to return it to.
 * Null when it is back; otherwise what refused.
 */
function backToTheCut(git: RawGit, plantAt: string): Effect.Effect<string | null> {
  return Effect.gen(function* () {
    const status = yield* git(['status', '--porcelain', '-z', '--untracked-files=all'], { trim: false })
    if (Result.isSuccess(status) && onlyThePlantedFileIsDirty(status.success, plantAt)) return null
    const reset = yield* git(['reset', '--hard', 'HEAD'])
    if (Result.isFailure(reset)) return reset.failure.detail
    const clean = yield* git(['clean', '-fd', '-e', `/${plantAt}`])
    return Result.isFailure(clean) ? clean.failure.detail : null
  })
}
