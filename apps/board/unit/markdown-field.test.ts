import { EditorState, type Transaction } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { buildDecorations, changeFor, enterBinding, previewExtensions } from '../src/app/markdown-preview.ts'

const stateOf = (doc: string, readOnly = false) =>
  EditorState.create({ doc, extensions: previewExtensions({ readOnly }) })

/** Types `text` one character at the end, as input does. */
const typed = (text: string) => {
  let state = stateOf('')
  for (const ch of text) {
    state = state.update({ changes: { from: state.doc.length, insert: ch }, userEvent: 'input.type' }).state
  }
  return state
}

/** Runs the field's Enter at the end of `text`, as the command would. */
const enterAfter = (text: string) => {
  let state = stateOf(text)
  state = state.update({ selection: { anchor: text.length } }).state
  enterBinding.run({ state, dispatch: (tr: Transaction) => (state = tr.state) } as never)
  return state.doc.toString()
}

describe('MarkdownField hands back exactly what was typed (#1372)', () => {
  it.each(['**a**', '- a', '1. a', '# h\n> q\n```\ncode\n```', 'a  \r\nb', '1. a\n1. b\n3. c'])('keeps %j', (text) => {
    expect(typed(text).doc.toString()).toBe(text)
    expect(stateOf(text).doc.toString()).toBe(text)
  })

  it('Enter is a newline and nothing else: no list continuation, no renumbering, no stripped hard break', () => {
    expect(enterAfter('- a')).toBe('- a\n')
    expect(enterAfter('1. a')).toBe('1. a\n')
    expect(enterAfter('a  ')).toBe('a  \n')
  })
})

describe('a value from outside', () => {
  it('equal text is no change', () => {
    expect(changeFor('same', 'same')).toBeNull()
    expect(changeFor('a\r\nb', 'a\r\nb')).toBeNull()
  })
  it('different text is only the middle that differs', () => {
    expect(changeFor('hello world', 'hello brave world')).toEqual({ from: 6, to: 6, insert: 'brave ' })
    expect(changeFor('abc', '')).toEqual({ from: 0, to: 3, insert: '' })
  })
  it('keeps a cursor outside the changed middle', () => {
    let state = stateOf('one two three')
    state = state.update({ selection: { anchor: 13 } }).state
    const change = changeFor('one two three', 'one 2 three')!
    state = state.update({ changes: change }).state
    expect(state.doc.toString()).toBe('one 2 three')
    expect(state.selection.main.head).toBe(11)
  })
})

describe('the preview is decoration only', () => {
  const count = (doc: string, focused: boolean, readOnly = false) => {
    const state = stateOf(doc, readOnly)
    let n = 0
    buildDecorations(state, focused, readOnly).between(0, doc.length, () => void n++)
    return n
  }
  it('builds without touching the text', () => {
    const doc = '# Title\n\n**bold** and `code` and [a](http://x)\n\n- item\n\n```\nfenced\n```\n'
    const state = stateOf(doc)
    expect(count(doc, false)).toBeGreaterThan(0)
    expect(state.doc.toString()).toBe(doc)
  })
  it('a read-only field never shows Markdown, however it is focused', () => {
    const doc = '**a**'
    expect(count(doc, true, true)).toBe(count(doc, false, true))
  })
})
