/**
 * `keptRunPort` against a fake `git` that records its arguments — `#390`.
 *
 * The git work follows `conduct.ts`'s own `keep` at `design`: stage, ask
 * whether anything is staged, commit only where there is a difference, ask
 * where `HEAD` landed. What differs is what gets staged — everything but the
 * planted env file, rather than one path — and that is the one thing a fake
 * `read-only` `git` can prove a real binary would do wrong to leave out.
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

describe('the port commits what a run changed, or restores the tree', () => {
  it('excludes the planted env file from `git add -A`', async () => {
    const { git, calls } = fakeGit({
      add: Either.right(''),
      diff: Either.left({ detail: 'differs' }),
      commit: Either.right(''),
      'rev-parse': Either.right('c'.repeat(40)),
    })
    const port = keptRunPort({ ...base, git })

    await port.keep({ name: 'format' })

    expect(calls[0]).toEqual(['add', '-A', '--', '.', ':(exclude).env.local'])
  })

  it('commits nothing when the cached diff is clean', async () => {
    const { git, calls } = fakeGit({ add: Either.right(''), diff: Either.right('') })
    const port = keptRunPort({ ...base, git })

    const answer = await port.keep({ name: 'format' })

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

    const answer = await port.keep({ name: 'format' })

    expect(answer).toEqual({ committed: 'c'.repeat(40) })
    const commit = calls.find((args) => args[0] === 'commit')!
    expect(commit).toContain('chore(implement): format for #390')
    expect(recorded).toEqual(['c'.repeat(40)])
  })

  it('resets the tree on `restore`, and runs no `git clean`', async () => {
    const { git, calls } = fakeGit({})
    const port = keptRunPort({ ...base, git })

    await port.restore()

    expect(calls).toEqual([['reset', '--hard', 'HEAD']])
    expect(calls.some((args) => args[0] === 'clean')).toBe(false)
  })

  it('answers `notKept` when the commit itself is refused, naming the reason', async () => {
    const { git } = fakeGit({
      add: Either.right(''),
      diff: Either.left({ detail: 'differs' }),
      commit: Either.left({ detail: 'nothing is staged' }),
    })
    const port = keptRunPort({ ...base, git })

    const answer = await port.keep({ name: 'format' })

    expect(answer).toEqual({ notKept: 'git commit refused it: nothing is staged' })
  })
})
