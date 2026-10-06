/**
 * `keptRunPort` against a fake `git` that records its arguments — `#390`.
 *
 * The git work follows `conduct.ts`'s own `keep` at `design`: stage, ask
 * whether anything is staged, commit only where there is a difference, ask
 * where `HEAD` landed. What differs is what gets staged — everything but the
 * planted env file and whatever `baseline` named, rather than one path — and
 * `baseline` is the fix: without it, a `git add -A` sweeps in whatever the
 * implementing agent left dirty before the command ever ran.
 *
 * Scoping the add is not enough on its own, which is why `diff --cached` and
 * `commit` carry the same pathspec: a file `baseline` names may already be
 * *staged*, not merely dirty, and an unscoped `git commit` commits every
 * staged path regardless of what `add -A` touched.
 *
 * `restore` cannot use `git reset --hard` for tracked files — it takes no
 * pathspec, so it would revert `baseline` along with everything else — so it
 * uses `git restore` instead, scoped the same way as `add`. For what the run
 * left *untracked*, it does not reuse that same pathspec-exclusion trick on
 * `git clean`: `git clean -fd` treats a wholly untracked directory as one
 * removable unit the moment any pathspec is given, `:(exclude)` included, so
 * a baseline file inside an untracked directory would be deleted along with
 * the directory around it. Instead `restore` asks `git status` again — which,
 * like `baseline()`, only ever names individual files — and cleans exactly
 * the literal paths that are not `baseline`'s, with no pathspec and no `-d`.
 * `git restore`, `git status` and `git clean` are each tried independently of
 * the others' results, because none of `git status` and `git clean` takes the
 * index lock `git restore` does.
 */
import { Either } from 'effect'
import { describe, expect, it } from 'vitest'

import { keptRunPort, type GitHere } from '../src/kept-run-port.ts'

function fakeGit(answers: Record<string, Either.Either<string, { readonly detail: string }>>) {
  const calls: string[][] = []
  const git: GitHere = async (args) => {
    calls.push(args)
    const key = args[0]!
    return answers[key] ?? Either.right('')
  }
  return { git, calls }
}

const base = {
  plantAt: '.env.local',
  issue: async () => ({ ref: '390' }),
  recordCompletion: async () => {},
}

describe('baseline reads what is already dirty, before the command runs', () => {
  it('excludes the planted env file from the status it reads', async () => {
    const { git, calls } = fakeGit({ status: Either.right('') })
    const port = keptRunPort({ ...base, git })

    await port.baseline()

    expect(calls).toEqual([
      ['status', '--porcelain=v1', '--untracked-files=all', '-z', '--', '.', ':(exclude).env.local'],
    ])
  })

  it('names every dirty and untracked path, agent leftovers included', async () => {
    const { git } = fakeGit({ status: Either.right(' M src/b.ts\0?? scratch.ts\0') })
    const port = keptRunPort({ ...base, git })

    const baseline = await port.baseline()

    expect(baseline).toEqual({ paths: new Set(['src/b.ts', 'scratch.ts']) })
  })

  it('names a path with a space or non-ASCII byte without the quoting `-z` turns off', async () => {
    // Without `-z`, `git status` would print `?? "new scratch.ts"` — quotes
    // and all — and that quoted text would never match the real file as a
    // literal path or a `:(exclude)` pathspec. `-z` never quotes, so the
    // fixture here is the raw path `git` actually hands back.
    const { git } = fakeGit({ status: Either.right('?? new scratch.ts\0') })
    const port = keptRunPort({ ...base, git })

    const baseline = await port.baseline()

    expect(baseline).toEqual({ paths: new Set(['new scratch.ts']) })
  })

  it('skips the original path of a rename or copy, which names nothing to exclude today', async () => {
    const { git } = fakeGit({ status: Either.right('R  src/new.ts\0src/old.ts\0?? scratch.ts\0') })
    const port = keptRunPort({ ...base, git })

    const baseline = await port.baseline()

    expect(baseline).toEqual({ paths: new Set(['src/new.ts', 'scratch.ts']) })
  })

  it('answers `unreadable` rather than throwing or claiming an empty tree, when `git status` itself refuses', async () => {
    const { git } = fakeGit({ status: Either.left({ detail: 'not a git repository' }) })
    const port = keptRunPort({ ...base, git })

    await expect(port.baseline()).resolves.toEqual({ unreadable: 'not a git repository' })
  })
})

describe('keep commits what a run changed, and never what was already dirty', () => {
  it('excludes the planted env file and the baseline from `git add -A`', async () => {
    const { git, calls } = fakeGit({
      add: Either.right(''),
      diff: Either.left({ detail: 'differs' }),
      commit: Either.right(''),
      'rev-parse': Either.right('c'.repeat(40)),
    })
    const port = keptRunPort({ ...base, git })

    await port.keep({ name: 'format' }, new Set(['src/b.ts', 'scratch.ts']))

    expect(calls[0]).toEqual([
      'add',
      '-A',
      '--',
      '.',
      ':(exclude).env.local',
      ':(exclude)src/b.ts',
      ':(exclude)scratch.ts',
    ])
  })

  it('commits nothing when the cached diff is clean', async () => {
    const { git, calls } = fakeGit({ add: Either.right(''), diff: Either.right('') })
    const port = keptRunPort({ ...base, git })

    const answer = await port.keep({ name: 'format' }, new Set())

    expect(answer).toEqual({ clean: true })
    expect(calls.some((args) => args[0] === 'commit')).toBe(false)
  })

  it('reports clean, not a commit, when the only staged change is a baseline file left staged by the agent', async () => {
    // `git diff --cached --quiet` with no pathspec would see that pre-existing
    // staged change and conclude there is something to commit, even though
    // the run itself changed nothing — it must be scoped away from `baseline`
    // the same way `add -A` is.
    const { git, calls } = fakeGit({ add: Either.right(''), diff: Either.right('') })
    const port = keptRunPort({ ...base, git })

    const answer = await port.keep({ name: 'format' }, new Set(['src/b.ts']))

    expect(answer).toEqual({ clean: true })
    const diff = calls.find((args) => args[0] === 'diff')!
    expect(diff).toEqual(['diff', '--cached', '--quiet', '--', '.', ':(exclude).env.local', ':(exclude)src/b.ts'])
    expect(calls.some((args) => args[0] === 'commit')).toBe(false)
  })

  it('commits only what changed, never a baseline file the agent had already staged', async () => {
    const { git, calls } = fakeGit({
      add: Either.right(''),
      diff: Either.left({ detail: 'differs' }),
      commit: Either.right(''),
      'rev-parse': Either.right('c'.repeat(40)),
    })
    const port = keptRunPort({ ...base, git })

    await port.keep({ name: 'format' }, new Set(['src/b.ts']))

    const commit = calls.find((args) => args[0] === 'commit')!
    expect(commit).toEqual([
      'commit',
      '-m',
      'chore(implement): format for #390',
      '--',
      '.',
      ':(exclude).env.local',
      ':(exclude)src/b.ts',
    ])
  })

  it('commits, names the action, and reports the new head', async () => {
    const recorded: string[] = []
    const { git, calls } = fakeGit({
      add: Either.right(''),
      diff: Either.left({ detail: 'differs' }),
      commit: Either.right(''),
      'rev-parse': Either.right('c'.repeat(40)),
    })
    const port = keptRunPort({ ...base, git, recordCompletion: async (head) => void recorded.push(head) })

    const answer = await port.keep({ name: 'format' }, new Set())

    expect(answer).toEqual({ committed: 'c'.repeat(40) })
    const commit = calls.find((args) => args[0] === 'commit')!
    expect(commit).toContain('chore(implement): format for #390')
    expect(recorded).toEqual(['c'.repeat(40)])
  })

  it('answers `notKept` when the commit itself is refused, naming the reason', async () => {
    const { git } = fakeGit({
      add: Either.right(''),
      diff: Either.left({ detail: 'differs' }),
      commit: Either.left({ detail: 'nothing is staged' }),
    })
    const port = keptRunPort({ ...base, git })

    const answer = await port.keep({ name: 'format' }, new Set())

    expect(answer).toEqual({ notKept: 'git commit refused it: nothing is staged' })
  })
})

describe('restore puts tracked files back, and removes only the literal untracked paths the run left', () => {
  it('restores from HEAD excluding the baseline, then asks `git status` again rather than a scoped `git clean`', async () => {
    const { git, calls } = fakeGit({ restore: Either.right(''), status: Either.right('?? leftover.txt\0') })
    const port = keptRunPort({ ...base, git })

    const answer = await port.restore(new Set(['scratch.ts']))

    expect(answer).toEqual({ ok: true })
    expect(calls).toEqual([
      ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.', ':(exclude).env.local', ':(exclude)scratch.ts'],
      ['status', '--porcelain=v1', '--untracked-files=all', '-z', '--', '.', ':(exclude).env.local'],
      ['clean', '-f', '--', 'leftover.txt'],
    ])
  })

  it('cleans every literal path the run left, even ones inside the same formerly-untracked directory as a baseline file', async () => {
    // The scenario a scoped `git clean -fd` gets wrong: `baseline` names one
    // file inside `scratchdir/`, and the run adds a second file in the same
    // directory. `git status --untracked-files=all` names each file
    // individually rather than the directory, which is what makes it safe to
    // clean one and spare the other without ever asking git to reason about
    // the directory as a whole.
    const { git, calls } = fakeGit({
      restore: Either.right(''),
      status: Either.right('?? scratchdir/k.ts\0?? scratchdir/other.ts\0'),
    })
    const port = keptRunPort({ ...base, git })

    const answer = await port.restore(new Set(['scratchdir/k.ts']))

    expect(answer).toEqual({ ok: true })
    const clean = calls.find((args) => args[0] === 'clean')!
    // Literal paths only — never `.`, never `-d`, never a pathspec that
    // could be read as "this whole directory".
    expect(clean).toEqual(['clean', '-f', '--', 'scratchdir/other.ts'])
  })

  it('calls no `git clean` at all when nothing is left over', async () => {
    const { git, calls } = fakeGit({ restore: Either.right(''), status: Either.right('?? scratch.ts\0') })
    const port = keptRunPort({ ...base, git })

    const answer = await port.restore(new Set(['scratch.ts']))

    expect(answer).toEqual({ ok: true })
    expect(calls.some((args) => args[0] === 'clean')).toBe(false)
  })

  it('still asks `git status` and cleans what the run left untracked when the restore itself refuses', async () => {
    // Neither `git status` nor `git clean` takes the index lock `git
    // restore` does, so a stale `.git/index.lock` that refuses the restore
    // must not stop this from removing whatever the run left on disk.
    const { git, calls } = fakeGit({
      restore: Either.left({ detail: 'index.lock exists' }),
      status: Either.right('?? leftover.txt\0'),
    })
    const port = keptRunPort({ ...base, git })

    const answer = await port.restore(new Set())

    expect(answer).toEqual({ failed: 'git restore refused it: index.lock exists' })
    expect(calls.find((args) => args[0] === 'clean')).toEqual(['clean', '-f', '--', 'leftover.txt'])
  })

  it('answers `failed` when the restore succeeds but the post-run status itself refuses', async () => {
    const { git } = fakeGit({ restore: Either.right(''), status: Either.left({ detail: 'not a git repository' }) })
    const port = keptRunPort({ ...base, git })

    const answer = await port.restore(new Set())

    expect(answer).toEqual({ failed: 'the untracked files could not be read or removed: not a git repository' })
  })

  it('answers `failed` when the restore and status succeed but the clean itself refuses', async () => {
    const { git } = fakeGit({
      restore: Either.right(''),
      status: Either.right('?? leftover.txt\0'),
      clean: Either.left({ detail: 'permission denied' }),
    })
    const port = keptRunPort({ ...base, git })

    const answer = await port.restore(new Set())

    expect(answer).toEqual({ failed: 'the untracked files could not be read or removed: permission denied' })
  })

  it('names both refusals when neither the restore nor the status/clean pair completes', async () => {
    const { git } = fakeGit({
      restore: Either.left({ detail: 'index.lock exists' }),
      status: Either.left({ detail: 'index.lock exists' }),
    })
    const port = keptRunPort({ ...base, git })

    const answer = await port.restore(new Set())

    expect(answer).toEqual({
      failed:
        'git restore refused it: index.lock exists; the untracked files could not be read or removed: index.lock exists',
    })
  })
})
