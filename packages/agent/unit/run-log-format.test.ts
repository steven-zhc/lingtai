import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { RUN_LOG_END, runLogEnded, runLogLine, runLogSaid, runLogStarted } from '../src/run-log-format.ts'
import { taggedTrace } from '../src/run-log.ts'

const AT = new Date(2026, 10, 5, 2, 3, 4)
const lines = (tag: string | null, label: string, detail: string): string => {
  const out: string[] = []
  const note = (l: string, d = '') => out.push(runLogLine(AT, l, d))
  if (tag === null) note(label, detail)
  else taggedTrace({ note }, tag).note(label, detail)
  return out[0]!
}

describe('runLogSaid', () => {
  it.each([null, 'fix:1', 'review:review', 'design:shape it'])('reads prose under tag %s', (tag) => {
    expect(runLogSaid(lines(tag, 'agent', 'All green. Committing.'), tag)).toEqual({
      at: '02:03:04',
      text: 'All green. Committing.',
    })
  })
  it('does not read what is not said', () => {
    expect(runLogSaid(lines('review:review', 'agent', '{ "findings": [] }'), 'review:review')).toBeNull()
    expect(runLogSaid(lines(null, 'agent', '[1]'), null)).toBeNull()
    expect(runLogSaid(lines(null, 'Bash', 'allow ls'), null)).toBeNull()
    expect(runLogSaid(lines('fix:1', 'Bash', 'allow ls'), 'fix:1')).toBeNull()
    expect(runLogSaid(runLogLine(AT, RUN_LOG_END, 'landed — x'), null)).toBeNull()
    expect(runLogSaid(lines('fix:2', 'agent', 'hi'), 'fix:1')).toBeNull()
    expect(runLogSaid(lines('fix:1', 'agent', 'hi'), null)).toBeNull()
  })
})

describe('runLogStarted', () => {
  it('reads an action start line, in the shape action.ts writes', () => {
    expect(runLogStarted(runLogLine(AT, 'implement:write the change', 'started · agent on 87dc4f4 · round 1'))).toBe(
      true,
    )
    expect(runLogStarted(runLogLine(AT, 'proposed:review', 'started · agent on 87dc4f4'))).toBe(true)
  })
  it('does not read prose or tool lines', () => {
    expect(runLogStarted(lines(null, 'agent', 'started · agent on 87dc4f4'))).toBe(false)
    expect(runLogStarted(lines(null, 'Bash', 'started · x on 87dc4f4'))).toBe(false)
    expect(runLogStarted(lines('fix:1', 'agent', 'Edit started'))).toBe(false)
  })
})

describe('the format module', () => {
  it('has no import', () => {
    const source = readFileSync(new URL('../src/run-log-format.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/^\s*import\b/m)
    expect(source).not.toMatch(/\bfrom\s+['"]/)
  })
  it('keeps runLogEnded as it was', () => {
    expect(runLogEnded(runLogLine(AT, RUN_LOG_END, 'landed — x'))).toBe('landed')
    expect(runLogEnded(runLogLine(AT, RUN_LOG_END, 'did not land — x'))).toBe('did not land')
    expect(runLogEnded(runLogLine(AT, 'agent', 'landed'))).toBeNull()
  })
})
