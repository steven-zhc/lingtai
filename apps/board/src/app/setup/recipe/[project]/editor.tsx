'use client'

import { useState, useTransition } from 'react'

import { saveRecipe } from '@/app/actions'
import type { SaveResult } from '@/lib/recipe-edit'

/** The mock's editor (`?v=4`): the text, *Validate and save*, and the results list. */
export function RecipeEditor({ project, text, loaded }: { project: string; text: string; loaded: string }) {
  const [draft, setDraft] = useState(text)
  const [result, setResult] = useState<SaveResult | null>(null)
  const [pending, start] = useTransition()
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        start(async () => setResult(await saveRecipe({ project, draft, loaded })))
      }}
    >
      <textarea
        className="mono"
        name="draft"
        spellCheck={false}
        rows={28}
        style={{ width: '100%' }}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <p>
        <button type="submit" disabled={pending}>
          {pending ? 'Checking…' : 'Validate and save'}
        </button>
      </p>
      {result === null ? null : (
        <div className={result.ok ? 'rnote' : 'refusal'} role="status">
          <p>{result.detail}</p>
          {result.problems === undefined ? null : (
            <ul>
              {result.problems.map((p) => (
                <li key={p} className="mono">
                  {p}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  )
}
