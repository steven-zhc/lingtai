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
 * are plain data, so nothing here reaches `@/lib/recipe` and its
 * server-side graph. No `key` anywhere above the form: a save revalidates the
 * page, and a remount would drop the message the save just earned.
 */
export function RecipeText({
  project,
  text,
  open,
  path,
  allow,
  nav,
}: {
  project: string
  text: string
  open: boolean
  path: string
  /** A host to add to the draft, applied by the form to what is typed now; `text` stays the file's own bytes. */
  allow?: AllowRequest
  /** The page's navigation stamp (`?r=`, in the links that ask for the editor): a new one is a new command, a re-render is not. */
  nav?: number
}) {
  const [editing, setEditing] = useState(open)
  // The command's identity is minted here, once per accepted click: the URL's stamp names a render, and two links on
  // one cached page (a Back, then another host) share it.
  const minted = useRef(0)
  const [request, setRequest] = useState<AllowRequest | undefined>(
    allow === undefined ? undefined : { host: allow.host, nonce: 0 },
  )
  // A client navigation keeps this component, so a later request arrives as a changed prop, not a remount.
  // A stamp comes from the URL, so a revalidation after a save (same URL) is not a command, and a link's
  // click (a new URL) is, whether it asks for the editor (`open`) or for a host in it (`allow`).
  const seen = useRef(nav)
  useEffect(() => {
    if (nav === seen.current) return
    seen.current = nav
    if (allow !== undefined) setRequest({ host: allow.host, nonce: ++minted.current })
    if (open) setEditing(true)
  }, [nav, open, allow])
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
            <button type="button" className="btn" onClick={() => setEditing(true)}>
              Edit
            </button>
          </FileBar>
          <FileView text={text} />
        </>
      )}
    </div>
  )
}
