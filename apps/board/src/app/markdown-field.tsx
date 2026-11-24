'use client'

/**
 * The one field where a person writes Markdown (#1372): a CodeMirror editor that draws the Markdown formatted as it is
 * typed and shows the source of the line the cursor is on. What `onChange` hands back is exactly what was typed.
 *
 * It is a textarea until the editor chunk has loaded — and stays one if the chunk fails — so the server markup and
 * the first paint are a box of the right size. The chunk is dynamic and never on the server: CodeMirror touches
 * `document`, and this file imports none of it.
 */
import dynamic from 'next/dynamic.js'
import { useRef, useState } from 'react'

const MarkdownEditor = dynamic(() => import('./markdown-editor').catch(() => ({ default: () => null })), {
  ssr: false,
})

export type MarkdownFieldProps = {
  value: string
  /** The text, not an event. */
  onChange?: (text: string) => void
  readOnly?: boolean
  placeholder?: string
  autoFocus?: boolean
  /** The minimum height, in lines. */
  rows?: number
  'aria-label'?: string
  /** On the wrapper, where the caller's border and ground go. */
  className?: string
  /** Seen before the field's own keys; `preventDefault()` keeps the field from acting on it. */
  onKeyDown?: (e: KeyboardEvent) => void
}

export function MarkdownField({
  value,
  onChange,
  readOnly = false,
  placeholder,
  autoFocus,
  rows = 3,
  'aria-label': ariaLabel,
  className,
  onKeyDown,
}: MarkdownFieldProps) {
  const [ready, setReady] = useState(false)
  const fallback = useRef<HTMLTextAreaElement>(null)
  const handoff = () => {
    const box = fallback.current
    if (box === null) return null
    return { focused: document.activeElement === box, anchor: box.selectionStart, head: box.selectionEnd }
  }
  return (
    <div
      className={`mdf${readOnly ? ' mdf-readonly' : ''}${className ? ` ${className}` : ''}`}
      style={{ ['--mdf-rows' as string]: rows }}
    >
      {ready ? null : (
        <textarea
          ref={fallback}
          aria-label={ariaLabel}
          value={value}
          readOnly={readOnly}
          placeholder={placeholder}
          autoFocus={autoFocus}
          rows={rows}
          onChange={(e) => onChange?.(e.target.value)}
          onKeyDown={onKeyDown ? (e) => onKeyDown(e.nativeEvent) : undefined}
        />
      )}
      <MarkdownEditor
        value={value}
        onChange={(text) => onChange?.(text)}
        readOnly={readOnly}
        placeholder={placeholder}
        autoFocus={autoFocus}
        ariaLabel={ariaLabel}
        onKeyDown={onKeyDown}
        handoff={handoff}
        onReady={() => setReady(true)}
      />
    </div>
  )
}
