'use client'

import { withAllowedHost } from '@lingtai/recipe/allow-host'
import dynamic from 'next/dynamic.js'
import { useActionState, useEffect, useRef, useState } from 'react'

import { saveRecipe } from '@/app/actions.ts'
import type { SaveRecipeState } from '@/lib/recipe-edit'

import { FileBar } from './file-bar'
import type { AllowRequest } from './recipe-text'

// The chunk loads only when the form does, and never on the server: CodeMirror touches `document`.
// A failed load leaves the textarea, which is why it is caught here rather than boundaried.
const YamlEditor = dynamic(() => import('./yaml-editor').catch(() => ({ default: () => null })), {
  ssr: false,
})

/** The recipe as text, and Validate and save. Imports nothing server-side but the action. */
export function RecipeForm({
  project,
  initial,
  allow,
  path,
  onClose,
}: {
  project: string
  initial: string
  /** A host to add to what is in the editor now, unsaved. `initial` stays the file's bytes: it is `loaded`, which a save compares to the disk. */
  allow?: AllowRequest
  path: string
  onClose: () => void
}) {
  const [state, run, pending] = useActionState(saveRecipe, {
    ok: false,
    loaded: initial,
    text: initial,
    message: '',
  } satisfies SaveRecipeState)
  // Controlled: React resets an uncontrolled field when an action completes, which would drop
  // edits typed while Save was pending and the draft a refusal should keep.
  const first = allow === undefined ? null : withAllowedHost(initial, allow.host)
  const [body, setBody] = useState(() => (first?.kind === 'added' ? first.text : initial))
  const bodyNow = useRef(body)
  bodyNow.current = body
  // What was pushed into a live editor, and whether a host was added that is not saved yet.
  const [push, setPush] = useState<{ rev: number; text: string } | null>(null)
  const [said, setSaid] = useState<{ host: string; kind: 'added' | 'listed' } | null>(
    allow !== undefined && first !== null ? { host: allow.host, kind: first.kind } : null,
  )
  const [mark, setMark] = useState<{ rev: number; lines: readonly number[]; replace: boolean } | null>(
    allow !== undefined && first !== null ? { rev: 0, lines: first.lines, replace: false } : null,
  )
  // The marks have a counter of their own: the allow nonce and a save's clearing are different events, so they never share a number.
  const markSeq = useRef(0)
  const applied = useRef(allow?.nonce)
  useEffect(() => {
    if (allow === undefined || allow.nonce === applied.current) return
    applied.current = allow.nonce
    // On what is typed now, never on the disk text: earlier unsaved edits and earlier hosts stay.
    const next = withAllowedHost(bodyNow.current, allow.host)
    if (next === null) return
    if (next.kind === 'added') {
      setBody(next.text)
      setPush({ rev: allow.nonce, text: next.text })
    }
    setSaid({ host: allow.host, kind: next.kind })
    setMark({ rev: ++markSeq.current, lines: next.lines, replace: false })
  }, [allow])
  // A saved draft is no longer *not saved*, and its marks are done.
  useEffect(() => {
    // Keyed on the state object, not on `ok`: that stays true across saves, and each save is its own completion.
    if (!state.ok) return
    setSaid(null)
    setMark({ rev: ++markSeq.current, lines: [], replace: true })
  }, [state])
  // The textarea is the loading state and the fallback; the editor takes over once it is up.
  const [editorReady, setEditorReady] = useState(false)
  const fallback = useRef<HTMLTextAreaElement>(null)
  // What the editor inherits from the textarea it replaces: focus and the selection.
  const handoff = () => {
    const t = fallback.current
    if (!t) return null
    const back = t.selectionDirection === 'backward'
    return {
      focused: document.activeElement === t,
      anchor: back ? t.selectionEnd : t.selectionStart,
      head: back ? t.selectionStart : t.selectionEnd,
    }
  }
  return (
    <form action={run} className="redit">
      <input type="hidden" name="project" value={project} />
      <input type="hidden" name="loaded" value={JSON.stringify(state.loaded)} />
      <input type="hidden" name="text" value={body} />
      <FileBar path={path}>
        {said !== null && state.message === '' ? (
          <span className="rfile-said">
            {said.kind === 'added' ? `${said.host} was added for you — not saved` : `${said.host} is already allowed`}
          </span>
        ) : null}
        <button type="submit" className="rfile-edit" disabled={pending}>
          Validate and save
        </button>
        <button type="button" className="rfile-edit" onClick={onClose}>
          Close
        </button>
      </FileBar>
      {state.message === '' ? null : (
        <div className="rfile-said">
          {state.ok ? (
            <span className="ok">
              {state.message} — applies from the next pass; a pass in flight keeps the recipe it read
            </span>
          ) : (
            <pre className="fail">{state.message}</pre>
          )}
        </div>
      )}
      {editorReady ? null : (
        <textarea
          ref={fallback}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box' }}
          spellCheck={false}
          rows={32}
          className="mono"
        />
      )}
      <YamlEditor
        initial={body}
        push={push}
        mark={mark}
        handoff={handoff}
        onChange={setBody}
        onReady={() => setEditorReady(true)}
      />
    </form>
  )
}
