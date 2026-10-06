/**
 * `keptRunPort` against a fake `git` that records its arguments — `#390`.
 *
 * The git work follows `conduct.ts`'s own `keep` at `design`: stage, ask
 * whether anything is staged, commit only where there is a difference, ask
 * where `HEAD` landed. What differs is what gets staged — everything but the
 * planted env file and whatever `baseline` named, rather than one path — and
 * `baseline` is the fix: without it, a `git add -A` sweeps in whatever the
 * implementing agent left dirty before the command ever ran, and a bare
 * `git reset --hard HEAD` on `restore` neither removes what a failing command
 * left untracked nor says anything when the reset itself refuses.
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

    expect(calls).toEqual([['status', '--porcelain=v1', '--untracked-files=all', '--', '.', ':(exclude).env.local']])
  })

  it('names every dirty and untracked path, agent leftovers included', async () => {
    const { git } = fakeGit({ status: Either.right(' M src/b.ts\n?? scratch.ts\n') })
    const port = keptRunPort({ ...base, git })

    const baseline = await port.baseline()

    expect(baseline).toEqual(new Set(['src/b.ts', 'scratch.ts']))
  })

  it('answers empty rather than throwing when `git status` itself refuses', async () => {
    const { git } = fakeGit({ status: Either.left({ detail: 'not a git repository' }) })
    const port = keptRunPort({ ...base, git })

    await expect(port.baseline()).resolves.toEqual(new Set())
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

describe('restore puts tracked files back and removes what the run left untracked', () => {
  it('resets, then cleans excluding the planted env file and the baseline', async () => {
    const { git, calls } = fakeGit({ reset: Either.right(''), clean: Either.right('') })
    const port = keptRunPort({ ...base, git })

    const answer = await port.restore(new Set(['scratch.ts']))

    expect(answer).toEqual({ ok: true })
    expect(calls).toEqual([
      ['reset', '--hard', 'HEAD'],
      ['clean', '-fd', '--', '.', ':(exclude).env.local', ':(exclude)scratch.ts'],
    ])
  })

  it('answers `failed` and runs no `clean` when the reset itself refuses', async () => {
    const { git, calls } = fakeGit({ reset: Either.left({ detail: 'index.lock exists' }) })
    const port = keptRunPort({ ...base, git })

    const answer = await port.restore(new Set())

    expect(answer).toEqual({ failed: 'git reset refused it: index.lock exists' })
    expect(calls.some((args) => args[0] === 'clean')).toBe(false)
  })

  it('answers `failed` when the reset succeeds but the clean refuses', async () => {
    const { git } = fakeGit({ reset: Either.right(''), clean: Either.left({ detail: 'permission denied' }) })
    const port = keptRunPort({ ...base, git })

    const answer = await port.restore(new Set())

    expect(answer).toEqual({ failed: 'git clean refused it: permission denied' })
  })
})
