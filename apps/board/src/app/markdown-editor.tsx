'use client'

import { EditorState, Prec } from '@codemirror/state'
import { EditorView, placeholder as placeholderExt } from '@codemirror/view'
import { useEffect, useRef } from 'react'

import { fromOutside, outsideTransaction, previewExtensions } from './markdown-preview.ts'

export type MarkdownEditorProps = {
  value: string
  onChange: (text: string) => void
  readOnly: boolean
  placeholder?: string
  autoFocus?: boolean
  ariaLabel?: string
  onKeyDown?: (e: KeyboardEvent) => void
  /** Read once, before the fallback textarea goes: whether it had focus, and its selection. */
  handoff: () => { focused: boolean; anchor: number; head: number } | null
  onReady: () => void
}

/** The CodeMirror view of `MarkdownField`. Loaded only through `dynamic(..., { ssr: false })`: CodeMirror touches `document`. */
export default function MarkdownEditor(props: MarkdownEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const latest = useRef(props)
  latest.current = props
  const taken = useRef<ReturnType<typeof props.handoff> | undefined>(undefined)
  useEffect(() => {
    if (taken.current === undefined) taken.current = latest.current.handoff()
    const carried = taken.current
    const initial = latest.current.value
    const clamp = (n: number) => Math.min(Math.max(n, 0), initial.length)
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        selection: carried ? { anchor: clamp(carried.anchor), head: clamp(carried.head) } : undefined,
        extensions: [
          previewExtensions({
            readOnly: latest.current.readOnly,
            placeholder: latest.current.placeholder ? placeholderExt(latest.current.placeholder) : undefined,
          }),
          EditorView.contentAttributes.of({
            role: 'textbox',
            'aria-multiline': 'true',
            ...(latest.current.ariaLabel ? { 'aria-label': latest.current.ariaLabel } : {}),
          }),
          Prec.highest(
            EditorView.domEventHandlers({
              keydown: (e) => {
                latest.current.onKeyDown?.(e)
                return e.defaultPrevented
              },
            }),
          ),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || u.transactions.some((t) => t.annotation(fromOutside))) return
            latest.current.onChange(u.state.doc.toString())
          }),
        ],
      }),
    })
    viewRef.current = view
    if (carried?.focused || (carried === null && latest.current.autoFocus)) {
      view.focus()
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) })
    }
    latest.current.onReady()
    return () => {
      viewRef.current = null
      view.destroy()
    }
  }, [])
  // A `value` from outside: only the middle that differs, so the cursor maps through it; an equal one dispatches nothing.
  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    const tr = outsideTransaction(view.state, props.value)
    if (tr !== null) view.dispatch(tr)
  }, [props.value])
  return <div ref={host} className="mdf-editor" />
}
