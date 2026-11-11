'use client'

/**
 * The two buttons a person's pause adds to the board (#994): *Pause* on the
 * bar, and *resume* on a banner row. Each acts on one project, so neither asks
 * for a confirmation, unlike the chip's Resume, which acts on the installation.
 */
import { useState, useTransition } from 'react'

import { pauseProjectNow, resumeProjectNow } from './actions.ts'

/** On the bar: *Pause*, or *Paused · resume* in the held colours while the project is paused. */
export function PauseButton({ project, paused }: { project: string; paused: boolean }) {
  const [pending, startTransition] = useTransition()
  const [refusal, setRefusal] = useState<string | null>(null)
  return (
    <>
      <button
        type="button"
        className={paused ? 'navlink held' : 'navlink'}
        disabled={pending}
        title={paused ? `resume ${project}` : `stop ${project} taking new work; an attempt in flight finishes`}
        onClick={() => {
          setRefusal(null)
          startTransition(async () => {
            const result = await (paused ? resumeProjectNow({ project }) : pauseProjectNow({ project }))
            if (!result.ok) setRefusal(result.detail)
          })
        }}
      >
        {paused ? 'Paused · resume' : 'Pause'}
      </button>
      {refusal ? <span className="refusal">{refusal}</span> : null}
    </>
  )
}

/** On a banner row: resume one project, with the server's sentence beside it if it fails. */
export function ResumeButton({ project }: { project: string }) {
  const [pending, startTransition] = useTransition()
  const [refusal, setRefusal] = useState<string | null>(null)
  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setRefusal(null)
          startTransition(async () => {
            const result = await resumeProjectNow({ project })
            if (!result.ok) setRefusal(result.detail)
          })
        }}
      >
        {pending ? '…' : 'resume'}
      </button>
      {refusal ? <span className="refusal">{refusal}</span> : null}
    </>
  )
}
