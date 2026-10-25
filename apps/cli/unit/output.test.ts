import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { jsonDocument, keyValues, printJson, printJsonError, section, symbol, table, width } from '../src/output.ts'
import { refusal } from '../src/prompt.ts'

const ESC = String.fromCharCode(27)
const saved = { ...process.env }

beforeEach(() => {
  for (const name of ['NO_COLOR', 'FORCE_COLOR', 'TERM']) delete process.env[name]
})
afterEach(() => {
  for (const name of ['NO_COLOR', 'FORCE_COLOR', 'TERM']) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

describe('plain mode', () => {
  it('has no escape under NO_COLOR, even when forced', () => {
    process.env['NO_COLOR'] = '1'
    process.env['FORCE_COLOR'] = '1'
    expect(section('Heading', [symbol.pass(), symbol.fail(), symbol.signal()])).not.toContain(ESC)
  })

  it('has none off a TTY without FORCE_COLOR', () => {
    expect(symbol.pass()).toBe('✓')
    expect(keyValues([['a', 'b']]).join('')).not.toContain(ESC)
  })

  it('colours under FORCE_COLOR', () => {
    process.env['FORCE_COLOR'] = '1'
    expect(symbol.fail()).toContain(ESC)
  })
})

describe('layout', () => {
  it('indents a section under its heading', () => {
    expect(section('Title', ['one', '', 'two'])).toBe('Title\n  one\n\n  two')
  })

  it('aligns key/values', () => {
    expect(
      keyValues([
        ['a', '1'],
        ['long', '2'],
      ]),
    ).toEqual(['a     1', 'long  2'])
  })

  const rows = [
    ['#612', 'running'],
    ['#6', 'landed'],
  ]

  it('aligns a table', () => {
    expect(table(['id', 'state'], rows)).toEqual(['id    state', '#612  running', '#6    landed'])
  })

  it('still aligns under colour, measuring visible width', () => {
    process.env['FORCE_COLOR'] = '1'
    const lines = table(['id', 'state'], rows)
    expect(lines.some((l) => l.includes(ESC))).toBe(true)
    expect(width(lines[0] ?? '')).toBe('id    state'.length)
    const starts = lines.map((l) => {
      const plainLine = l.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')
      return plainLine.search(/(state|running|landed)/)
    })
    expect(new Set(starts).size).toBe(1)
  })

  it('falls back to a key/value block per row when narrower than the table', () => {
    expect(table(['id', 'state'], rows, { columns: 8 })).toEqual([
      'id     #612',
      'state  running',
      '',
      'id     #6',
      'state  landed',
    ])
  })

  it('measures terminal columns, not code points', () => {
    expect(width('中')).toBe(2)
    expect(width('ab')).toBe(2)
    expect(width('e\u0301')).toBe(1)
    expect(width('🚀')).toBe(2)
    expect(width('🫠')).toBe(2)
    expect(width('🇯🇵')).toBe(2)
    expect(
      table(
        ['a', 'b'],
        [
          ['中', 'x'],
          ['ab', 'y'],
        ],
      ),
    ).toEqual(['a   b', '中  x', 'ab  y'])
  })

  it('never truncates a redirected stream', () => {
    expect(table(['id', 'state'], rows, { columns: undefined })).toHaveLength(3)
  })
})

describe('--json', () => {
  it('is one line with the schema version first', () => {
    expect(jsonDocument('x', { a: 1 })).toBe('{"version":1,"command":"x","a":1}')
  })

  it('writes to the stream given and nowhere else, without colour', () => {
    process.env['FORCE_COLOR'] = '1'
    const written: string[] = []
    printJson('x', { ok: true }, { write: (t) => written.push(t) })
    expect(written).toEqual(['{"version":1,"command":"x","ok":true}\n'])
    const code = printJsonError('x', 'boom', 'it broke', { write: (t) => written.push(t) })
    expect(code).toBe(1)
    expect(JSON.parse(written[1] ?? '')).toEqual({
      version: 1,
      command: 'x',
      error: { code: 'boom', message: 'it broke' },
    })
  })
})

describe('prompt refusals', () => {
  it('name the flag off a TTY and under --json', () => {
    expect(refusal('--name', { stdinIsTTY: false, stdoutIsTTY: true, json: false })).toContain('--name')
    expect(refusal('--name', { stdinIsTTY: true, stdoutIsTTY: true, json: true })).toContain('--name')
    expect(refusal('--name', { stdinIsTTY: true, stdoutIsTTY: true, json: false })).toBeNull()
  })
})
