'use client'

/**
 * The summary, the one field a person edits on a PR's page (#1320): a textarea over the summary alone, and under a rule the
 * generated rest of the description — tickets, `Closes #…`, merge commits and spend — read-only, because an edit to a
 * `Closes` line would silently stop a ticket closing. Save calls `savePrSummaryNow` with the summary and nothing else.
 */
import { useState, useTransition } from 'react'

import type { PageSummary } from '@/lib/pr-page.ts'

import { savePrSummaryNow } from './actions.ts'

export function PrSummaryEditor({ project, n, summary }: { project: string; n: number; summary: PageSummary }) {
  const [text, setText] = useState(summary.text)
  const [pending, startTransition] = useTransition()
  const [answer, setAnswer] = useState<{ ok: boolean; detail: string } | null>(null)
  const save = () => {
    setAnswer(null)
    startTransition(async () => {
      setAnswer(await savePrSummaryNow({ project, n, summary: text }))
    })
  }
  return (
    <div className="prp-summary">
      <textarea
        aria-label="Summary"
        className="prp-textarea"
        value={text}
        readOnly={!summary.editable}
        onChange={(e) => setText(e.target.value)}
        rows={6}
      />
      {summary.refusal === null ? (
        <div className="pr-actions">
          <button type="button" className="pr-btn primary" disabled={pending} onClick={save}>
            {summary.saveLabel}
          </button>
        </div>
      ) : (
        <p className="pr-why">{summary.refusal}</p>
      )}
      {answer === null ? null : answer.ok ? (
        <p className="pr-why">saved — Lingtai puts it on GitHub</p>
      ) : (
        <p className="pr-refusal" role="alert">
          {answer.detail}
        </p>
      )}
      {summary.notes.map((s) => (
        <p key={s} className="pr-why">
          {s}
        </p>
      ))}
      <hr className="prp-rule" />
      <textarea
        aria-label="The rest of the description, generated"
        className="prp-textarea generated"
        readOnly
        value={summary.generated}
        rows={Math.min(12, Math.max(3, summary.generated.split('\n').length))}
      />
    </div>
  )
}
