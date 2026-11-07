'use client'

import { useActionState } from 'react'

import { saveRecipe } from '@/app/actions.ts'
import type { SaveRecipeState } from '@/lib/recipe-edit'

/** The recipe as text, and Validate and save. Imports nothing server-side but the action. */
export function RecipeForm({ project, initial }: { project: string; initial: string }) {
  const [state, run, pending] = useActionState(saveRecipe, {
    ok: false,
    loaded: initial,
    text: initial,
    message: '',
  } satisfies SaveRecipeState)
  return (
    <form action={run} className="redit">
      <input type="hidden" name="project" value={project} />
      <input type="hidden" name="loaded" value={state.loaded} />
      <textarea
        name="text"
        defaultValue={initial}
        style={{ width: '100%', boxSizing: 'border-box' }}
        spellCheck={false}
        rows={32}
        className="mono"
      />
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
