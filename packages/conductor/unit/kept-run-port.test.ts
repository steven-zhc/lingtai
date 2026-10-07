/**
 * `keptRunPort` (#390), against a git that records what it was asked and
 * answers from a script. No git binary, so this is `unit/` by 0060 §1, and it
 * is what pins the two traps `doc/design/390.md` names: `clean` resets to the
 * agent's own `HEAD`, never the base, and the planted env file is spared by
 * both the clean and the add.
 */
import { Either } from 'effect'
import { describe, expect, it } from 'vitest'

import { type GitHere, keptRunPort } from '../src/kept-run-port.ts'

const PLANT = 'apps/web/.env.local'

function fakeGit(answers: Record<string, Either.Either<string, { detail: string }>> = {}) {
  const asked: string[][] = []
  const git: GitHere = async (args) => {
    asked.push(args)
    return answers[args.join(' ')] ?? Either.right('')
  }
  return { git, asked }
}

describe('keptRunPort.clean', () => {
  it('resets to HEAD and cleans with the planted file spared, in that order', async () => {
    const { git, asked } = fakeGit()
    const port = keptRunPort({ git, plantAt: PLANT, issue: '390', recordCompletion: async () => {} })
    expect(await port.clean()).toEqual({ ok: true })
    expect(asked).toEqual([
      ['reset', '--hard', 'HEAD'],
      ['clean', '-fd', '-e', `/${PLANT}`],
    ])
  })

  it('stops at a refused reset, and says which call refused', async () => {
    const { git, asked } = fakeGit({ 'reset --hard HEAD': Either.left({ detail: 'index.lock exists' }) })
    const port = keptRunPort({ git, plantAt: PLANT, issue: '390', recordCompletion: async () => {} })
    expect(await port.clean()).toEqual({ failed: 'git reset refused it: index.lock exists' })
    expect(asked).toHaveLength(1)
  })
})

describe('keptRunPort.keep', () => {
  it('adds everything but the planted file, commits, and records the new head', async () => {
    const recorded: string[] = []
    const { git, asked } = fakeGit({
      // `--quiet` implies `--exit-code`: a left is *something is staged*.
      'diff --cached --quiet': Either.left({ detail: 'exit 1' }),
      'rev-parse HEAD': Either.right('abc1234'),
    })
    const port = keptRunPort({
      git,
      plantAt: PLANT,
      issue: '390',
      recordCompletion: async (head) => {
        recorded.push(head)
      },
    })
    expect(await port.keep('format')).toEqual({ committed: 'abc1234' })
    expect(asked).toEqual([
      ['add', '-A', '--', '.', `:(exclude)${PLANT}`],
      ['diff', '--cached', '--quiet'],
      ['commit', '-m', 'chore(implement): format for #390'],
      ['rev-parse', 'HEAD'],
    ])
    expect(recorded).toEqual(['abc1234'])
  })

  it('commits and records nothing when the command changed nothing', async () => {
    const recorded: string[] = []
    const { git, asked } = fakeGit()
    const port = keptRunPort({
      git,
      plantAt: PLANT,
      issue: '390',
      recordCompletion: async (head) => {
        recorded.push(head)
      },
    })
    expect(await port.keep('format')).toEqual({ nothing: true })
    expect(asked.map((a) => a[0])).toEqual(['add', 'diff'])
    expect(recorded).toEqual([])
  })
})
