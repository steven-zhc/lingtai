'use client'

import { useEffect, useRef, useState } from 'react'

import { FileBar } from './file-bar'
import { FileView } from './file-view'
import { RecipeForm } from './recipe-form'

/** A host to add to the editor's draft. A new `nonce` is a new request, even for the same host. */
export interface AllowRequest {
  readonly host: string
  readonly nonce: number
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
  allow,
}: {
  project: string
  text: string
  open: boolean
  path: string
  /** A host to add to the draft, applied by the form to what is typed now; `text` stays the file's own bytes. */
  allow?: AllowRequest
}) {
  const [editing, setEditing] = useState(open)
  const [request, setRequest] = useState(allow)
  // A client navigation keeps this component, so a later request arrives as a changed prop, not a remount.
  const seen = useRef(allow?.nonce)
  useEffect(() => {
    if (allow === undefined || allow.nonce === seen.current) return
    seen.current = allow.nonce
    setRequest(allow)
    setEditing(true)
  }, [allow])
  return (
    <div className="rfile">
      {editing ? (
        <RecipeForm
          project={project}
          initial={text}
          {...(request === undefined ? {} : { allow: request })}
          path={path}
          onClose={() => {
            setRequest(undefined)
            setEditing(false)
          }}
        />
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
