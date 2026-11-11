'use client'

import { EditorState, type TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useEffect, useRef } from 'react'

import { yamlExtensions } from './yaml-editor'

/** The read-only view's extensions: the editor's shared ones, and nothing that edits. */
export const viewExtensions = [...yamlExtensions, EditorState.readOnly.of(true), EditorView.editable.of(false)]

/** The change that makes the document `text`, or null when it already is. */
export function replaceDoc(state: EditorState, text: string): TransactionSpec | null {
  if (state.doc.toString() === text) return null
  return { changes: { from: 0, to: state.doc.length, insert: text } }
}

/** `recipe.yml` read-only, highlighted and numbered as the editor is (#984). */
export default function YamlView({ text, onReady }: { text: string; onReady: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const latest = useRef({ text, onReady })
  latest.current = { text, onReady }
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: latest.current.text, extensions: viewExtensions }),
    })
    viewRef.current = view
    latest.current.onReady()
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const spec = replaceDoc(view.state, text)
    if (spec) view.dispatch(spec)
  }, [text])
  return <div ref={host} className="rfile-fill" />
}
