'use client'

/**
 * The summary, the one field a person edits on a PR's page (#1320): a Markdown field over the summary alone, and under a rule the
 * generated rest of the description — the tickets and the `Closes #…` line — read-only, because an edit to a
 * `Closes` line would silently stop a ticket closing. Save calls `savePrSummaryNow` with the summary and nothing else.
 */
import { type ReactNode, useState, useTransition } from 'react'

import type { PageSummary } from '@/lib/pr-page.ts'

import { savePrSummaryNow } from './actions.ts'
import { MarkdownField } from './markdown-field.tsx'

export function PrSummaryEditor({
  project,
  n,
  summary,
  generated,
}: {
  project: string
  n: number
  summary: PageSummary
  /** The generated rest, read-only: a slot, because the page may stream it. */
  generated: ReactNode
}) {
  const [text, setText] = useState(summary.text)
  // The stream's summary moves under an open page (the agent finishes, a pr-fix extends it): a field the person has not
  // touched follows it, and one they have edited keeps their words.
  const [base, setBase] = useState(summary.text)
  if (summary.text !== base) {
    setBase(summary.text)
    if (text === base) setText(summary.text)
  }
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
      <MarkdownField
        aria-label="Summary"
        className="prp-textarea"
        value={text}
        readOnly={!summary.editable}
        onChange={setText}
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
      {generated}
    </div>
  )
}
