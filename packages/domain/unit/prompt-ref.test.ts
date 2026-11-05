import { describe, expect, it } from 'vitest'

import { composePrompt, expandPrompt, markerOf, sha256Hex, utf8Bytes, type PromptRef } from '../src/prompt-ref.ts'

const BODY: PromptRef = { _tag: 'TicketBody', stream: 'ticket-p-9', version: 2 }
const DIFF_A: PromptRef = { _tag: 'Diff', from: '1'.repeat(40), to: '2'.repeat(40) }
const DIFF_B: PromptRef = { _tag: 'Diff', from: '2'.repeat(40), to: '3'.repeat(40) }

const compose = (body: string, a: string, b: string) =>
  composePrompt([
    'head ',
    { text: body, ref: BODY },
    ' mid ',
    { text: a, ref: DIFF_A },
    ' | ',
    { text: b, ref: DIFF_B },
    ' end',
  ])

const valuesOf = (c: ReturnType<typeof compose>) => c.values.map((text) => ({ text }))

describe('composePrompt and expandPrompt (#927)', () => {
  it('round-trips a body and two diffs, and records far less than it hands', () => {
    const diff = '+line\n'.repeat(1000)
    const c = compose('the body é', diff, `${diff}more`)
    expect(c.handed).toBe(`head the body é mid ${diff} | ${diff}more end`)
    expect(c.recorded.length).toBeLessThan(300)
    expect(c.refs.map((r) => r.bytes)).toEqual([utf8Bytes('the body é'), utf8Bytes(diff), utf8Bytes(`${diff}more`)])
    expect(expandPrompt({ prompt: c.recorded, refs: c.refs }, valuesOf(c))).toEqual({ text: c.handed, unresolved: [] })
  })

  it('round-trips a body that contains the marker text, {{body}} and {{body}}', () => {
    const marker = markerOf(DIFF_A, 5)
    const body = `${marker} and {{body}} and {{body}} ${markerOf(BODY, 99)}`
    const c = compose(body, 'diff-a', 'diff-b')
    expect(expandPrompt({ prompt: c.recorded, refs: c.refs }, valuesOf(c))).toEqual({ text: c.handed, unresolved: [] })
    expect(c.handed).toContain(body)
  })

  it('leaves a marker-looking text outside a recorded span alone', () => {
    const c = composePrompt([`say ${markerOf(DIFF_A, 3)} `, { text: 'abc', ref: DIFF_A }])
    const got = expandPrompt({ prompt: c.recorded, refs: c.refs }, valuesOf(c))
    expect(got.text).toBe(c.handed)
  })

  it('does not reference an empty insert', () => {
    const c = composePrompt(['a', { text: '', ref: BODY }, 'b'])
    expect(c).toMatchObject({ handed: 'ab', recorded: 'ab', refs: [] })
  })

  it('returns a whole prompt unchanged, and a v1 null as null', () => {
    expect(expandPrompt({ prompt: 'whole' }, [])).toEqual({ text: 'whole', unresolved: [] })
    expect(expandPrompt({ prompt: null }, [])).toEqual({ text: null, unresolved: [] })
  })

  describe('unresolved, never thrown and never invented', () => {
    const c = compose('body', 'diff-a', 'diff-b')
    const record = { prompt: c.recorded, refs: c.refs }

    it('a value the resolver could not find', () => {
      const got = expandPrompt(record, [{ text: 'body' }, { unresolved: 'no event at version 2' }, { text: 'diff-b' }])
      expect(got.unresolved).toEqual([{ index: 1, ref: DIFF_A, why: 'no event at version 2' }])
      expect(got.text).toContain(markerOf(DIFF_A, 6))
      expect(got.text).toContain('diff-b')
    })

    it('a value of the wrong size', () => {
      const got = expandPrompt(record, [{ text: 'bod' }, { text: 'diff-a' }, { text: 'diff-b' }])
      expect(got.unresolved).toEqual([{ index: 0, ref: BODY, why: 'the value is 3 bytes, the record says 4' }])
      expect(got.text).toContain(markerOf(BODY, 4))
    })

    it('a value of the same size and other content, by the recorded sha256', () => {
      const one = composePrompt([{ text: 'allow', ref: BODY }])
      const refs = one.refs.map((r) => ({ ...r, sha256: sha256Hex('allow') }))
      expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
      const got = expandPrompt({ prompt: one.recorded, refs }, [{ text: 'deny!' }])
      expect(got.text).toBe(one.recorded)
      expect(got.unresolved[0]!.why).toBe("the value's sha256 differs from the record's")
      expect(expandPrompt({ prompt: one.recorded, refs }, [{ text: 'allow' }]).text).toBe('allow')
    })

    it('a value that is missing', () => {
      const got = expandPrompt(record, [{ text: 'body' }])
      expect(got.unresolved.map((u) => u.index)).toEqual([1, 2])
    })

    it('a span that does not hold its marker', () => {
      const bad = { prompt: c.recorded.replace('lingtai:body', 'lingtai:BODY'), refs: c.refs }
      const got = expandPrompt(bad, valuesOf(c))
      expect(got.unresolved).toEqual([{ index: 0, ref: BODY, why: 'the record does not hold the marker it names' }])
      expect(got.text).toContain('lingtai:BODY')
    })

    it('overlapping, out of order, or past-the-end spans are malformed', () => {
      const [r0, r1, r2] = c.refs
      for (const refs of [
        [r1!, r0!],
        [r0!, { ...r1!, start: r0!.start }],
        [r0!, r1!, { ...r2!, end: c.recorded.length + 5 }],
      ]) {
        const got = expandPrompt({ prompt: c.recorded, refs }, valuesOf(c))
        expect(got.text).toBe(c.recorded)
        expect(got.unresolved[0]!.why).toBe('malformed refs')
      }
    })
  })
})
