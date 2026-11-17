'use client'

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { yaml } from '@codemirror/lang-yaml'
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { EditorState, StateEffect, StateField, type Text } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, keymap, lineNumbers } from '@codemirror/view'
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
export const yamlExtensions = [
  yaml(),
  lineNumbers(),
  indentUnit.of('  '),
  syntaxHighlighting(yamlHighlight),
  EditorView.lineWrapping,
  baseTheme,
]

/** The line ranges to mark for these 1-based line numbers, clamped to the document so a shifted text never throws. */
export function marksFor(doc: Text, lines: readonly number[]): { from: number }[] {
  const seen = new Set<number>()
  for (const n of lines) seen.add(Math.min(Math.max(n, 1), doc.lines))
  return [...seen].sort((a, b) => a - b).map((n) => ({ from: doc.line(n).from }))
}

/** `replace` false adds to the marks already there; true starts over (and `lines: []` clears). */
const setMarks = StateEffect.define<{ lines: readonly number[]; replace: boolean }>()
const addedLine = Decoration.line({ class: 'cm-added' })

/** The marked lines: set by `setMarks`, moved with the text, gone with a deleted line. */
const markField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes)
    for (const e of tr.effects) {
      if (!e.is(setMarks)) continue
      const added = marksFor(tr.state.doc, e.value.lines).map((m) => addedLine.range(m.from))
      next = e.value.replace ? Decoration.set(added) : next.update({ add: added, sort: true })
    }
    return next
  },
  provide: (f) => EditorView.decorations.from(f),
})

const theme = EditorView.theme({
  '.cm-added': { background: 'var(--accent-soft)', borderLeft: '2px solid var(--accent)' },
  '.cm-content': { caretColor: 'var(--ink)' },
  '.cm-cursor': { borderLeftColor: 'var(--ink)' },
  '&.cm-focused': { outline: '1px solid var(--accent)', outlineOffset: '-1px' },
})

function applyMark(view: EditorView, lines: readonly number[], replace: boolean) {
  const first = marksFor(view.state.doc, lines)[0]
  view.dispatch({
    effects: [
      setMarks.of({ lines, replace }),
      ...(first ? [EditorView.scrollIntoView(first.from, { y: 'center' })] : []),
    ],
  })
}

/**
 * The recipe's YAML in CodeMirror. Seeded once from `initial`; after that fed only by `push` (a host added on request) and never fed
 * back: after that the caller's draft changes only because this reported it.
 */
export default function YamlEditor({
  initial,
  push,
  mark,
  handoff,
  onChange,
  onReady,
}: {
  initial: string
  /** Text to put in the live editor, replacing what is there; a new `rev` is a new push. */
  push: { rev: number; text: string } | null
  /** Lines (1-based) to highlight and scroll to; a new `rev` is a new mark, added to the earlier ones unless `replace`; `replace` with `lines: []` clears. */
  mark: { rev: number; lines: readonly number[]; replace: boolean } | null
  /** Read once, before the fallback textarea goes: whether it had focus, and its selection. */
  handoff: () => { focused: boolean; anchor: number; head: number } | null
  onChange: (text: string) => void
  onReady: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const latest = useRef({ onChange, onReady })
  latest.current = { onChange, onReady }
  // Read once for the component's life: Strict Mode replays this effect after the first run
  // has focused and destroyed an editor, and by then the textarea no longer has focus.
  const markedAtMount = useRef(mark)
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
          markField,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString())
          }),
        ],
      }),
    })
    viewRef.current = view
    if (markedAtMount.current !== null && markedAtMount.current.lines.length > 0)
      applyMark(view, markedAtMount.current.lines, markedAtMount.current.replace)
    if (carried?.focused) {
      view.focus()
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) })
    }
    latest.current.onReady()
    return () => {
      viewRef.current = null
      view.destroy()
    }
    // Seeded once: `initial` is the draft of the render the chunk arrived in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // A push already in the props when this mounted is in `initial` (the draft of the render the chunk arrived in),
  // and replaying it would overwrite what was typed into the fallback textarea since.
  const pushed = useRef(push?.rev)
  useEffect(() => {
    const view = viewRef.current
    if (push === null || view === null || push.rev === pushed.current) return
    pushed.current = push.rev
    if (view.state.doc.toString() === push.text) return
    // Only the middle that differs, so marks on the lines either side of it keep their place.
    const old = view.state.doc.toString()
    let from = 0
    while (from < old.length && from < push.text.length && old[from] === push.text[from]) from++
    let end = old.length
    let tail = push.text.length
    while (end > from && tail > from && old[end - 1] === push.text[tail - 1]) {
      end--
      tail--
    }
    view.dispatch({ changes: { from, to: end, insert: push.text.slice(from, tail) } })
  }, [push])
  // After the push effect above, so the lines refer to the pushed text.
  const marked = useRef(mark?.rev)
  useEffect(() => {
    const view = viewRef.current
    if (mark === null || view === null || mark.rev === marked.current) return
    marked.current = mark.rev
    applyMark(view, mark.lines, mark.replace)
  }, [mark])
  return <div ref={host} className="rfile-fill" />
}
