import { Effect, Result } from 'effect'
import { describe, expect, it } from 'vitest'

import { ownChangeStart } from '../src/conduct.ts'

const SHA = 'a'.repeat(40)

const scripted = (answers: Record<string, Result.Result<string, { detail: string }>>) => {
  const asked: string[][] = []
  const notes: string[] = []
  return {
    asked,
    notes,
    port: {
      git: (args: string[]) =>
        Effect.sync(() => {
          asked.push(args)
          return answers[args[0]!] ?? Result.succeed('')
        }),
      note: (l: string) => void notes.push(l),
      base: 'main',
      fallback: 'FALLBACK',
    },
  }
}

describe('ownChangeStart (#937)', () => {
  it('asks merge-base FETCH_HEAD HEAD after a fetch and returns its sha', async () => {
    const s = scripted({ fetch: Result.succeed(''), 'merge-base': Result.succeed(`${SHA}\n`) })
    expect(await Effect.runPromise(ownChangeStart(s.port))).toBe(SHA)
    expect(s.asked).toEqual([
      ['fetch', 'origin', 'refs/heads/main'],
      ['merge-base', 'FETCH_HEAD', 'HEAD'],
    ])
    expect(s.notes).toEqual([])
  })

  it('uses the local base ref and notes it when the fetch fails', async () => {
    const s = scripted({ fetch: Result.fail({ detail: 'mirror busy' }), 'merge-base': Result.succeed(SHA) })
    expect(await Effect.runPromise(ownChangeStart(s.port))).toBe(SHA)
    expect(s.asked[1]).toEqual(['merge-base', 'refs/heads/main', 'HEAD'])
    expect(s.notes).toHaveLength(1)
    expect(s.notes[0]).toContain('mirror busy')
  })

  it('returns the fallback and notes it when merge-base fails', async () => {
    const s = scripted({ fetch: Result.succeed(''), 'merge-base': Result.fail({ detail: 'no common ancestor' }) })
    expect(await Effect.runPromise(ownChangeStart(s.port))).toBe('FALLBACK')
    expect(s.notes[0]).toContain('no common ancestor')
  })

  it('returns the fallback when merge-base prints nothing or more than one line', async () => {
    for (const out of ['', `${SHA}\n${'b'.repeat(40)}\n`]) {
      const s = scripted({ fetch: Result.succeed(''), 'merge-base': Result.succeed(out) })
      expect(await Effect.runPromise(ownChangeStart(s.port))).toBe('FALLBACK')
      expect(s.notes).toHaveLength(1)
    }
  })
})
