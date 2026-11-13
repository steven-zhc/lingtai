import { StringDecoder } from 'node:string_decoder'

import { describe, expect, it } from 'vitest'

import { RUN_LOG_END, runLogEnd, runLogLine, wholeLines } from '../src/run-log.ts'

describe('wholeLines', () => {
  it('holds a line split across two reads until it is whole', () => {
    const first = wholeLines('one\ntw')
    expect(first.items).toEqual([{ line: 'one' }])
    const second = wholeLines(first.pending + 'o\n')
    expect(second.items).toEqual([{ line: 'two' }])
    expect(second.pending).toBe('')
  })

  it('holds a UTF-8 character split across two reads until it is whole', () => {
    const bytes = Buffer.from('é灵\n')
    const decoder = new StringDecoder('utf8')
    // Cut inside the three-byte character.
    const a = decoder.write(bytes.subarray(0, 3))
    const first = wholeLines(a)
    expect(first.items).toEqual([])
    const second = wholeLines(first.pending + decoder.write(bytes.subarray(3)))
    expect(second.items).toEqual([{ line: 'é灵' }])
  })

  it('stops after the line that ends the log and emits the ending', () => {
    const end = runLogLine(new Date(), RUN_LOG_END, runLogEnd(true))
    const r = wholeLines(`a\n${end}\nafter\n`)
    expect(r.ended).toBe(true)
    expect(r.items[0]).toEqual({ line: 'a' })
    expect(r.items.at(-1)).toEqual({ ended: 'landed' })
    expect(r.items.some((i) => 'line' in i && i.line === 'after')).toBe(false)
  })
})
