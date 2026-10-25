/**
 * What a `ContinueConflict` card or command is drawn from (#559): the
 * checks the page can make at render time, in `resolveWait`'s order, and the
 * rows the mirror's own count gives — never a count of triage's.
 */
import { MERGE_HUNKS_ONE_BY_ONE } from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

import { conflictWorkOf, type ConflictWorkPorts } from '../src/conflict-work.ts'

const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)

const ports = (
  over: Partial<ConflictWorkPorts> = {},
  remotes: Record<string, string | null> = {},
): ConflictWorkPorts => ({
  client: { refSha: async (ref) => (ref in remotes ? remotes[ref]! : ref === 'heads/main' ? BASE : HEAD) },
  base: 'main',
  conflicts: async () => [{ path: 'a.ts', hunkLines: [3, 9], hunkTexts: ['<<<<<<< x', '<<<<<<< y'] }],
  ...over,
})

const input = (over: Record<string, unknown> = {}) => ({
  proposal: { baseSha: BASE, headSha: HEAD },
  saved: { head: HEAD, ref: 'agent/1' },
  runEvents: [],
  status: null,
  ports: ports(),
  ...over,
})

describe('conflictWorkOf', () => {
  it('draws one row per counted hunk, with its text, and every row unset without advice', async () => {
    const work = await conflictWorkOf(input())
    expect(work).toMatchObject({
      baseSha: BASE,
      headSha: HEAD,
      ref: 'agent/1',
      roundsExhausted: false,
      paths: ['a.ts'],
    })
    expect('rows' in work && work.rows.map((r) => [r.path, r.line, r.text, r.suggested])).toEqual([
      ['a.ts', 3, '<<<<<<< x', null],
      ['a.ts', 9, '<<<<<<< y', null],
    ])
  })

  it('draws no rows past one-by-one, whatever triage said', async () => {
    const many = Array.from({ length: MERGE_HUNKS_ONE_BY_ONE + 1 }, (_, i) => i + 1)
    const work = await conflictWorkOf(
      input({ ports: ports({ conflicts: async () => [{ path: 'a.ts', hunkLines: many }] }) }),
    )
    expect(work).toMatchObject({ tooMany: MERGE_HUNKS_ONE_BY_ONE + 1 })
    expect('rows' in work).toBe(false)
  })

  it.each([
    ['a moved head', { saved: { head: 'c'.repeat(40), ref: 'agent/1' } }, /head moved/i],
    ['a missing ref', { ports: ports({}, { 'heads/agent/1': null }) }, /missing/],
    ['a moved ref', { ports: ports({}, { 'heads/agent/1': 'c'.repeat(40) }) }, /moved to/],
    ['a moved base', { ports: ports({}, { 'heads/main': 'c'.repeat(40) }) }, /base moved/],
    ['no saved work', { saved: { refusal: 'no published head' } }, /no published head/],
    ['no ports', { ports: { refusal: 'no GitHub App configured' } }, /no GitHub App/],
    [
      'an unreadable mirror',
      {
        ports: ports({
          conflicts: async () => {
            throw new Error('no git')
          },
        }),
      },
      /no git/,
    ],
  ])('refuses %s rather than drawing a form', async (_name, over, message) => {
    const work = await conflictWorkOf(input(over))
    expect(work).toHaveProperty('refusal')
    expect((work as { refusal: string }).refusal).toMatch(message)
  })

  it('reads the rounds off the run stream', async () => {
    const offer = {
      proposal: { _tag: 'MergeConflict', headSha: HEAD },
      unavailable: [{ id: 'fix-lines', because: { _tag: 'CeilingReached', ceiling: 'rounds' } }],
    }
    const work = await conflictWorkOf(input({ runEvents: [{ type: 'PassRouted', data: { offer } }] }))
    expect(work).toMatchObject({ roundsExhausted: true })
  })
})
