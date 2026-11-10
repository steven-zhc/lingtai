'use client'

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { yaml } from '@codemirror/lang-yaml'
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { useEffect, useRef } from 'react'

/**
 * Keys, values and comments, in the board's variables (#981). The YAML grammar
 * tags an unquoted value `content` and a quoted one `string`; it has no number
 * or boolean tag, so there is no rule for those.
 */
export const yamlHighlight = HighlightStyle.define([
  { tag: tags.definition(tags.propertyName), color: 'var(--accent-ink)', fontWeight: '600' },
  { tag: [tags.string, tags.content], color: 'var(--signal)' },
  { tag: tags.lineComment, color: 'var(--muted)', fontStyle: 'italic' },
])

const theme = EditorView.theme({
  '&': {
    height: '32lh',
    maxHeight: '70vh',
    backgroundColor: 'var(--surface)',
    color: 'var(--ink)',
    border: '1px solid var(--rule-2)',
  },
  '.cm-scroller': { fontFamily: 'var(--mono)', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--ink)' },
  '.cm-cursor': { borderLeftColor: 'var(--ink)' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface-2)',
    color: 'var(--muted)',
    borderRight: '1px solid var(--rule-2)',
  },
  '&.cm-focused': { outline: '1px solid var(--accent)' },
})

/**
 * The recipe's YAML in CodeMirror. Seeded once from `initial` and never fed
 * back: after that the caller's draft changes only because this reported it.
 */
export default function YamlEditor({
  initial,
  handoff,
  onChange,
  onReady,
}: {
  initial: string
  /** Read once, before the fallback textarea goes: whether it had focus, and its selection. */
  handoff: () => { focused: boolean; anchor: number; head: number } | null
  onChange: (text: string) => void
  onReady: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const latest = useRef({ onChange, onReady })
  latest.current = { onChange, onReady }
  useEffect(() => {
    const carried = handoff()
    const clamp = (n: number) => Math.min(Math.max(n, 0), initial.length)
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        selection: carried ? { anchor: clamp(carried.anchor), head: clamp(carried.head) } : undefined,
        extensions: [
          yaml(),
          lineNumbers(),
          history(),
          indentUnit.of('  '),
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          syntaxHighlighting(yamlHighlight),
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString())
          }),
        ],
      }),
    })
    if (carried?.focused) {
      view.focus()
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) })
    }
    latest.current.onReady()
    return () => view.destroy()
    // Seeded once: `initial` is the draft of the render the chunk arrived in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div ref={host} />
}
