import { runLogLine } from '@lingtai/agent/run-log-format'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { FollowedLog, RawRunLog, SaidLast } from '../src/app/run-log.tsx'
import { openFor, saidLast, tailRule } from '../src/lib/said.ts'

const at = (s: number) => new Date(2026, 10, 5, 2, 0, s)
const say = (s: number, text: string, tag: string | null = null) =>
  tag === null ? runLogLine(at(s), 'agent', text) : runLogLine(at(s), tag, `${'agent'.padEnd(6)}  ${text}`)
const start = (s: number, tag: string) => runLogLine(at(s), tag, 'started · agent on 87dc4f4')

describe('saidLast', () => {
  it('quotes the newest three, newest first', () => {
    const lines = [say(1, 'a'), say(2, 'b'), say(3, 'c'), say(4, 'd')]
    expect(saidLast(lines, [null]).map((s) => s.text)).toEqual(['d', 'c', 'b'])
  })
  it("never shows an earlier round's lines as this round's", () => {
    const lines = [say(1, 'old', 'review:review'), start(2, 'review:review')]
    expect(saidLast(lines, ['review:review'])).toEqual([])
    expect(saidLast([...lines, say(3, 'new', 'review:review')], ['review:review']).map((s) => s.text)).toEqual(['new'])
  })
  it("keeps the first action's speech when a second action of the phase starts", () => {
    const tags = ['review:first', 'review:second']
    const lines = [start(1, 'review:first'), say(2, 'one', 'review:first'), start(3, 'review:second')]
    expect(saidLast(lines, tags).map((s) => s.text)).toEqual(['one'])
    expect(saidLast([...lines, say(4, 'two', 'review:second')], tags).map((s) => s.text)).toEqual(['two', 'one'])
    expect(saidLast([say(0, 'old', 'review:first'), start(1, 'review:first')], tags)).toEqual([])
  })
  it('says nothing with no tags', () => {
    expect(saidLast([say(1, 'a')], [])).toEqual([])
  })
})

describe('the tail rule', () => {
  it('follows while live or open', () => {
    expect(tailRule(true, false)).toBe(true)
    expect(tailRule(false, true)).toBe(true)
    expect(tailRule(false, false)).toBe(false)
  })
  it('is open for one run only', () => {
    expect(openFor('a', 'a')).toBe(true)
    expect(openFor('a', 'b')).toBe(false)
    expect(openFor(null, null)).toBe(false)
  })
})

describe('FollowedLog on a live attempt', () => {
  const html = renderToStaticMarkup(
    <FollowedLog running="run-1" tags={[null]}>
      <SaidLast />
      <RawRunLog where="running" />
      <RawRunLog where="ended" />
    </FollowedLog>,
  )
  it('draws the raw log closed, once', () => {
    expect(html.split('<details').length - 1).toBe(1)
    expect(html).not.toContain('open=""')
  })
  it('says nothing yet when there are no lines', () => {
    expect(html).toContain('Nothing said yet in this round.')
  })
})
