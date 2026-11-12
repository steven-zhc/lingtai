'use client'

import { useState } from 'react'

import type { TaskAnswer } from '@/lib/task'

import { Deferred, type Answered } from './deferred.tsx'
import { OutgoingEditor } from './outgoing.tsx'
import { Skeleton } from './skeleton.tsx'

/** The Edit card's action. Its draft lives here, above the `Deferred` and its problem branch, so a refresh that fails does not unmount the draft. A client module: it holds state. */
export function EditPromptAction({
  g,
  pending,
  taskId,
}: {
  g: Answered<TaskAnswer>
  pending: boolean
  taskId: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const fallback = <Skeleton shape="lines" count={1} />
  if (pending) return fallback
  return (
    <Deferred value={g} fallback={fallback}>
      {(a) =>
        a.outgoing === null || a.outgoing.problem !== null ? (
          <p className="empty">The prompt could not be composed, so there is nothing to edit.</p>
        ) : (
          <OutgoingEditor taskId={taskId} outgoing={a.outgoing} sendable={false} draft={draft} onDraft={setDraft} />
        )
      }
    </Deferred>
  )
}
