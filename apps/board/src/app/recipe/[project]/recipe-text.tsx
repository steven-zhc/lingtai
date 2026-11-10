'use client'

import { useState } from 'react'

import { FileBar } from './file-bar'
import { FileView } from './file-view'
import { RecipeForm } from './recipe-form'

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
      {editing ? (
        <RecipeForm project={project} initial={text} path={path} onClose={() => setEditing(false)} />
      ) : (
        <>
          <FileBar path={path}>
            <button type="button" className="rfile-edit" onClick={() => setEditing(true)}>
              Edit
            </button>
          </FileBar>
          <FileView text={text} />
        </>
      )}
    </div>
  )
}
