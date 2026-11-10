'use client'

import dynamic from 'next/dynamic.js'
import { useActionState, useRef, useState } from 'react'

import { saveRecipe } from '@/app/actions.ts'
import type { SaveRecipeState } from '@/lib/recipe-edit'

// The chunk loads only when the form does, and never on the server: CodeMirror touches `document`.
// A failed load leaves the textarea, which is why it is caught here rather than boundaried.
const YamlEditor = dynamic(() => import('./yaml-editor').catch(() => ({ default: () => null })), {
  ssr: false,
})

/** The recipe as text, and Validate and save. Imports nothing server-side but the action. */
export function RecipeForm({ project, initial }: { project: string; initial: string }) {
  const [state, run, pending] = useActionState(saveRecipe, {
    ok: false,
    loaded: initial,
    text: initial,
    message: '',
  } satisfies SaveRecipeState)
  // Controlled: React resets an uncontrolled field when an action completes, which would drop
  // edits typed while Save was pending and the draft a refusal should keep.
  const [draft, setDraft] = useState(initial)
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
      <input type="hidden" name="text" value={draft} />
      {editorReady ? null : (
        <textarea
          ref={fallback}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box' }}
          spellCheck={false}
          rows={32}
          className="mono"
        />
      )}
      <YamlEditor initial={draft} handoff={handoff} onChange={setDraft} onReady={() => setEditorReady(true)} />
      <div className="row">
        <button type="submit" disabled={pending}>
          Validate and save
        </button>
        {state.message === '' ? null : state.ok ? (
          <span className="ok">
            {state.message} — applies from the next pass; a pass in flight keeps the recipe it read
          </span>
        ) : (
          <pre className="fail">{state.message}</pre>
        )}
      </div>
    </form>
  )
}
