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
  /** Set when a rollback failed: the tree holds conflict markers or staged edits and no agent may start on it. */
  wedged?: string
}

/** The WIP's own diff flags: the output is pinned so it can be parsed and applied. */
// `--find-renames` is pinned (never `diff.renames=copies`) so the patch and the rename lookup agree.
// The prefixes are pinned too: `diff.noprefix` / `diff.mnemonicPrefix` would make `apply -p1` strip a real directory.
// `--ignore-submodules=all` keeps `diff.submodule=log` from putting a textual summary in the patch, which
// `apply` would skip silently; gitlinks are found and named separately from `diff --raw`.
const DIFF_FLAGS = [
  '--ignore-submodules=all',
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
    // `apply --numstat` names only the new path of a rename; the source comes from `diff --raw`.
    const raw = yield* git(
      [
        'diff',
        '--raw',
        '-z',
        '--no-abbrev',
        '--no-ext-diff',
        '--find-renames',
        '--ignore-submodules=none',
        kept.parentSha,
        kept.sha,
      ],
      { trim: false },
    )
    if (Result.isFailure(raw)) return none(`the diff could not be read: ${raw.failure.detail}`)
    const entries = rawEntries(raw.success)
    const sources = new Map<string, string>()
    for (const e of entries) if (e.from !== null && e.status.startsWith('R')) sources.set(e.path, e.from)
    // A submodule's update is an index entry only: `apply --3way` stages it, `reset` takes it back, and the
    // submodule's checkout never moves. It is never carried, and is named instead.
    const gitlinks = entries.filter((e) => e.gitlink).map((e) => e.path)
    const carriable = entries.filter((e) => !e.gitlink).map((e) => e.path)
    const touched = numstatPaths(listed.success)
    // The patch must name every path the diff does: anything `apply` would skip is not a carry.
    const missing = carriable.filter((p) => !touched.includes(p))
    if (missing.length > 0) return none(`the diff could not be read in full (not in the patch: ${missing.join(', ')})`)
    if (touched.length === 0) return gitlinks.length === 0 ? null : { applied: [], leftOut: gitlinks, unapplied: null }

    const applied = yield* git(['apply', '--3way', patch])
    let leftOut: string[] = []
    /** The left-out paths that may hold conflict state; a path refused whole wrote nothing. */
    let conflicted: string[] = []
    /** Return to the cut and carry nothing; if the tree cannot be returned, say it is wedged. */
    const giveUp = (why: string): Effect.Effect<CarriedWork> =>
      Effect.gen(function* () {
        const stuck = yield* backToTheCut(git, plantAt)
        if (stuck === null) return none(`${why}, so nothing was carried`)
        const wedged = `${why}, and the worktree could not be returned to the base (${stuck}); check \`git status\``
        return { ...none(wedged), wedged }
      })
    if (Result.isFailure(applied)) {
      const unmerged = yield* git(['diff', '--name-only', '--diff-filter=U', '-z'], { trim: false })
      // An unreadable conflict list is not an empty one: conflict markers may be in the tree.
      if (Result.isFailure(unmerged))
        return yield* giveUp(`the conflicting paths could not be listed (${unmerged.failure.detail})`)
      leftOut = paths(unmerged.success).filter((p) => touched.includes(p))
      conflicted = leftOut
      if (leftOut.length === 0) {
        // `git apply` is atomic: a path refused without a conflict (the base deleted it, say) aborts
        // the whole patch. Return to the cut and apply path by path, so only that path is left out.
        const stuck = yield* backToTheCut(git, plantAt)
        if (stuck !== null) {
          const wedged = `the diff did not apply (${applied.failure.detail}), and the worktree could not be returned to the base (${stuck}); check \`git status\``
          return { ...none(wedged), wedged }
        }
        for (const path of touched) {
          const one = yield* git(['apply', '--3way', `--include=${globEscape(path)}`, patch])
          if (Result.isFailure(one)) leftOut.push(path)
        }
        const after = yield* git(['diff', '--name-only', '--diff-filter=U', '-z'], { trim: false })
        if (Result.isFailure(after))
          return yield* giveUp(`the conflicting paths could not be listed (${after.failure.detail})`)
        conflicted = paths(after.success).filter((p) => leftOut.includes(p))
        if (leftOut.length === touched.length) {
          const left = yield* backToTheCut(git, plantAt)
          if (left === null) return none(`the diff did not apply: ${applied.failure.detail}`)
          const wedged = `the diff did not apply, and the worktree could not be returned to the base (${left}); check \`git status\``
          return { ...none(wedged), wedged }
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
        if (Result.isFailure(done))
          return yield* giveUp(`${path} could not be restored to the base (${done.failure.detail})`)
      }
    }
    // `--3way` implies `--index`; the worktree should look like a stopped run's dirty tree.
    const unstaged = yield* git(['reset', '-q'])
    if (Result.isFailure(unstaged))
      return yield* giveUp(`the carried edits could not be unstaged (${unstaged.failure.detail})`)
    return { applied: touched.filter((p) => !leftOut.includes(p)), leftOut: [...leftOut, ...gitlinks], unapplied: null }
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

interface RawEntry {
  path: string
  /** The rename's source; null otherwise. */
  from: string | null
  status: string
  /** Either side is a submodule (mode 160000). */
  gitlink: boolean
}

/** `diff --raw -z` is `:srcmode dstmode srcsha dstsha status\0path\0`, with a second path for a rename or copy. */
function rawEntries(out: string): RawEntry[] {
  const fields = out.split('\0')
  const found: RawEntry[] = []
  for (let i = 0; i < fields.length; i++) {
    const meta = fields[i]!
    if (!meta.startsWith(':')) continue
    const [src, dst, , , status = ''] = meta.slice(1).split(' ')
    const two = status.startsWith('R') || status.startsWith('C')
    const first = fields[i + 1] ?? ''
    const second = two ? (fields[i + 2] ?? '') : null
    found.push({
      path: second ?? first,
      // A copy leaves its source in place; only a rename deletes it.
      from: second !== null && status.startsWith('R') ? first : null,
      status,
      gitlink: src === '160000' || dst === '160000',
    })
    i += two ? 2 : 1
  }
  return found
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
