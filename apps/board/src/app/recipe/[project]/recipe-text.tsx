'use client'

import { useState } from 'react'

import { RecipeForm } from './recipe-form'

/**
 * The `recipe.yml` column (#980): the file's text, or the editor on it in
 * place. Props are primitives, so nothing here reaches `@/lib/recipe` and its
 * server-side graph. No `key` anywhere above the form: a save revalidates the
 * page, and a remount would drop the message the save just earned.
 */
export function RecipeText({ project, text, open }: { project: string; text: string; open: boolean }) {
  const [editing, setEditing] = useState(open)
  return (
    <>
      <h3 className="s2-h">
        recipe.yml{' '}
        <button type="button" className="s2-change" onClick={() => setEditing(!editing)}>
          {editing ? 'Close' : 'Edit'}
        </button>
      </h3>
      {editing ? <RecipeForm project={project} initial={text} /> : <pre className="s2-yaml">{text}</pre>}
    </>
  )
}
