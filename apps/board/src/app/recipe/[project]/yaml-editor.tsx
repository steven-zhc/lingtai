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

/** What the file looks like, in the editor and in the read-only view alike. */
const baseTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--surface)', color: 'var(--ink)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', overflow: 'auto' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface-2)',
    color: 'var(--muted)',
    borderRight: '1px solid var(--rule-2)',
  },
})

/** The extensions the editor and the read-only view share (#984): one highlighter, one look. */
export const yamlExtensions = [yaml(), lineNumbers(), indentUnit.of('  '), syntaxHighlighting(yamlHighlight), baseTheme]

const theme = EditorView.theme({
  '&': { height: '32lh', maxHeight: '70vh' },
  '.cm-content': { caretColor: 'var(--ink)' },
  '.cm-cursor': { borderLeftColor: 'var(--ink)' },
  '&.cm-focused': { outline: '1px solid var(--accent)', outlineOffset: '-1px' },
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
  // Read once for the component's life: Strict Mode replays this effect after the first run
  // has focused and destroyed an editor, and by then the textarea no longer has focus.
  const taken = useRef<ReturnType<typeof handoff> | undefined>(undefined)
  useEffect(() => {
    if (taken.current === undefined) taken.current = handoff()
    const carried = taken.current
    const clamp = (n: number) => Math.min(Math.max(n, 0), initial.length)
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        selection: carried ? { anchor: clamp(carried.anchor), head: clamp(carried.head) } : undefined,
        extensions: [
          ...yamlExtensions,
          history(),
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
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
