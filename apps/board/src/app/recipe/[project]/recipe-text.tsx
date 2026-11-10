'use client'

import dynamic from 'next/dynamic.js'
import { useState } from 'react'

import { RecipeForm } from './recipe-form'

// Loaded the way the editor is: never on the server (CodeMirror touches `document`), and a failed
// chunk leaves the `<pre>`, which is why it is caught here rather than boundaried.
const YamlView = dynamic(() => import('./yaml-view').catch(() => ({ default: () => null })), {
  ssr: false,
})

/** The text as a `<pre>` until the highlighted view reports ready, and for good if its chunk fails. */
function FileView({ text }: { text: string }) {
  const [ready, setReady] = useState(false)
  return (
    <>
      {ready ? null : <pre className="s2-yaml">{text}</pre>}
      <YamlView text={text} onReady={() => setReady(true)} />
    </>
  )
}

/**
 * The `recipe.yml` column (#980): the file's text, or the editor on it in
 * place, in one panel with its path and the button in its bar (#984). Props
 * are primitives, so nothing here reaches `@/lib/recipe` and its
 * server-side graph. No `key` anywhere above the form: a save revalidates the
 * page, and a remount would drop the message the save just earned.
 */
export function RecipeText({
  project,
  text,
  open,
  path,
}: {
  project: string
  text: string
  open: boolean
  path: string
}) {
  const [editing, setEditing] = useState(open)
  return (
    <div className="rfile">
      <div className="rfile-bar">
        <b>recipe.yml</b>
        <small>{path}</small>
        <button type="button" className="rfile-edit" onClick={() => setEditing(!editing)}>
          {editing ? 'Close' : 'Edit'}
        </button>
      </div>
      {editing ? <RecipeForm project={project} initial={text} /> : <FileView text={text} />}
    </div>
  )
}
