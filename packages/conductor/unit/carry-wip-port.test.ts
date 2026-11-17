import { Effect, Result } from 'effect'
import { describe, expect, it } from 'vitest'

import { carryKeptWork } from '../src/carry-wip-port.ts'

const KEPT = { arm: 'agent/9-attempt-1', sha: 'c'.repeat(40), parentSha: 'a'.repeat(40) }

/** A git that answers by the first words of the command and records every call. */
function scripted(answers: Record<string, string | { fail: string }>) {
  const calls: string[][] = []
  const git = (args: string[]) => {
    calls.push(args)
    const key = Object.keys(answers)
      .sort((x, y) => y.length - x.length)
      .find((k) => args.join(' ').startsWith(k))
    const answer = key === undefined ? '' : answers[key]!
    return Effect.succeed(typeof answer === 'string' ? Result.succeed(answer) : Result.fail({ detail: answer.fail }))
  }
  return { git, calls }
}

const carry = (answers: Record<string, string | { fail: string }>, fetch: 'ok' | 'fails' = 'ok') => {
  const { git, calls } = scripted({ 'rev-parse --git-path': '/wt/.git/lingtai-wip.patch', ...answers })
  const result = Effect.runSync(
    carryKeptWork({
      git,
      fetchArm: () => Effect.succeed(fetch === 'ok' ? Result.succeed('') : Result.fail({ detail: 'no route' })),
      plantAt: '.env.local',
      kept: KEPT,
    }),
  )
  return { result, calls: calls.map((c) => c.join(' ')) }
}

describe('carryKeptWork', () => {
  it('applies the WIP’s own diff, from a file, with pinned flags, and unstages it', () => {
    const { result, calls } = carry({ 'apply --numstat': '1\t0\ta.ts\0 2\t1\tb.ts\0'.replace(' ', '') })
    expect(result).toEqual({ applied: ['a.ts', 'b.ts'], leftOut: [], unapplied: null })
    const diff = calls.find((c) => c.startsWith('diff --no-color'))!
    expect(diff).toContain(
      '--no-ext-diff --no-textconv --binary --find-renames --src-prefix=a/ --dst-prefix=b/ --output=/wt/.git/lingtai-wip.patch',
    )
    expect(diff.endsWith(`${KEPT.parentSha} ${KEPT.sha}`)).toBe(true)
    expect(calls).toContain('apply --3way /wt/.git/lingtai-wip.patch')
    expect(calls.at(-1)).toBe('reset -q')
  })

  it('carries nothing when the conflict list cannot be read, rather than reporting no conflicts', () => {
    const { result } = carry({
      'apply --numstat': '1\t0\ta.ts\0',
      'apply --3way': { fail: 'conflicts' },
      'diff --name-only': { fail: 'index locked' },
    })
    expect(result).toMatchObject({ applied: [], unapplied: expect.stringContaining('could not be listed') })
  })

  it('leaves a path the base changed too at the base’s version, and never takes anything from the WIP sha', () => {
    const { result, calls } = carry({
      'apply --numstat': '1\t0\ta.ts\0 1\t1\tc.ts\0'.replace(' ', ''),
      'apply --3way': { fail: 'conflicts' },
      'diff --name-only': 'c.ts\0',
    })
    expect(result).toEqual({ applied: ['a.ts'], leftOut: ['c.ts'], unapplied: null })
    expect(calls).toContain('--literal-pathspecs checkout HEAD -- c.ts')
    expect(calls.filter((c) => c.includes('checkout') || c.startsWith('reset --hard')).join('\n')).not.toContain(
      KEPT.sha,
    )
  })

  it('restores a conflicted rename at both ends, literally', () => {
    const { result, calls } = carry({
      'apply --numstat': '1\t1\tnew.txt\0',
      'diff --raw': ':100644 100644 a b R090\0old.txt\0new.txt\0',
      'apply --3way': { fail: 'conflicts' },
      'diff --name-only': 'new.txt\0',
      'cat-file -e HEAD:new.txt': { fail: 'absent' },
    })
    expect(result).toEqual({ applied: [], leftOut: ['new.txt'], unapplied: null })
    expect(calls).toContain('--literal-pathspecs rm -f -q -- new.txt')
    expect(calls).toContain('--literal-pathspecs checkout HEAD -- old.txt')
  })

  it('does not claim a carry when a restore fails', () => {
    const { result } = carry({
      'apply --numstat': '1\t0\ta.ts\0' + '1\t1\tc.ts\0',
      'apply --3way': { fail: 'conflicts' },
      'diff --name-only': 'c.ts\0',
      '--literal-pathspecs checkout': { fail: 'index.lock' },
    })
    expect(result?.unapplied).toContain('could not be restored')
    expect(result?.applied).toEqual([])
  })

  it('applies nothing and says so when the arm could not be fetched', () => {
    const { result, calls } = carry({}, 'fails')
    expect(result?.unapplied).toContain('could not be fetched')
    expect(calls.some((c) => c.startsWith('apply'))).toBe(false)
  })

  it('applies nothing when the diff cannot be read', () => {
    const { result, calls } = carry({ 'apply --numstat': { fail: 'corrupt patch' } })
    expect(result?.unapplied).toContain('could not be read')
    expect(calls).not.toContain('apply --3way /wt/.git/lingtai-wip.patch')
  })

  it('returns the tree to the cut when the whole patch was refused', () => {
    const { result, calls } = carry({
      'apply --numstat': '1\t0\ta.ts\0',
      'apply --3way': { fail: 'missing blob' },
      'diff --name-only': '',
      'status --porcelain': ' M a.ts\0',
    })
    expect(result).toEqual({ applied: [], leftOut: [], unapplied: expect.stringContaining('did not apply') })
    expect(calls).toContain('reset --hard HEAD')
  })

  it('carries the paths that apply when another is refused without a conflict', () => {
    const { result, calls } = carry({
      'apply --numstat': '1\t0\ta.txt\0' + '1\t1\tb.txt\0',
      'apply --3way /wt': { fail: 'b.txt: does not exist in index' },
      'apply --3way --include=b.txt': { fail: 'does not exist in index' },
      'apply --3way --include=a.txt': '',
      'diff --name-only': '',
      'status --porcelain': '',
    })
    expect(result).toEqual({ applied: ['a.txt'], leftOut: ['b.txt'], unapplied: null })
    expect(calls).toContain('apply --3way --include=a.txt /wt/.git/lingtai-wip.patch')
    expect(calls.some((c) => c.includes('rm -f'))).toBe(false)
  })

  it('names a submodule update as left out rather than staging and unstaging it', () => {
    const { result, calls } = carry({
      'apply --numstat': '1\t0\ta.ts\0',
      'diff --raw': ':100644 100644 a b M\0a.ts\0:160000 160000 c d M\0sub\0',
    })
    expect(result).toEqual({ applied: ['a.ts'], leftOut: ['sub'], unapplied: null })
    expect(calls.find((c) => c.startsWith('diff --no-color'))).toContain('--ignore-submodules=all')
  })

  it('carries nothing when the patch omits a path the diff names', () => {
    const { result, calls } = carry({
      'apply --numstat': '1\t0\ta.ts\0',
      'diff --raw': ':100644 100644 a b M\0a.ts\0:100644 100644 c d M\0b.ts\0',
    })
    expect(result?.unapplied).toContain('b.ts')
    expect(calls).not.toContain('apply --3way /wt/.git/lingtai-wip.patch')
  })

  it('is wedged, not merely empty, when the tree cannot be returned to the base', () => {
    const { result } = carry({
      'apply --numstat': '1\t0\ta.ts\0' + '1\t1\tc.ts\0',
      'apply --3way': { fail: 'conflicts' },
      'diff --name-only': 'c.ts\0',
      '--literal-pathspecs checkout': { fail: 'index.lock' },
      'status --porcelain': ' M a.ts\0',
      'reset --hard': { fail: 'index.lock' },
    })
    expect(result?.wedged).toContain('could not be returned')
  })

  it('has nothing to carry for an empty WIP', () => {
    expect(carry({ 'apply --numstat': '' }).result).toBeNull()
  })
})
