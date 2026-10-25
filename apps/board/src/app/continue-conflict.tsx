'use client'

import type { ConflictWork } from '@lingtai/conductor/conflict-work'
import type { WaitId } from '@lingtai/domain'
import { confirmHunks, conflictRowKey, type ConflictChoice, type ConflictRow } from '@lingtai/domain/wait'
import { useState, useTransition } from 'react'

import { continueConflictCard } from './actions.ts'

type Rows = Extract<ConflictWork, { rows: unknown }>

const short = (sha: string) => sha.slice(0, 7)

/** The radio a choice selects, so the group can be controlled. */
const selection = (choice: ConflictChoice | null): string =>
  choice === null
    ? ''
    : choice._tag === 'Mechanical'
      ? 'mechanical'
      : choice._tag === 'Answer'
        ? `answer:${choice.answerId}`
        : 'other'

/**
 * Confirm what each hunk should do, then ask the AI to continue the
 * preserved branch (0118 §8, #559). The rows are the mirror's own count and
 * triage is only laid over them, so with no advice every row starts unset and
 * the person's own intent is required. Nothing here lands the change: the
 * button says what happens, and build and review run again.
 */
export function ContinueConflict({
  project,
  issue,
  waitId,
  work,
  primary,
}: {
  project: string
  issue: number
  waitId: WaitId
  work: Rows
  primary: boolean
}) {
  // The only state is what the person did: an `onChange` writes it and nothing
  // else does. Triage's advice is read at render to show a recommendation and
  // is never copied in, so advice arriving, changing or going cannot change a
  // choice that was made (#559).
  const [own, setOwn] = useState<Record<string, ConflictChoice>>({})
  const [grant, setGrant] = useState(false)
  const [pending, setPending] = useState(false)
  const [detail, setDetail] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [, startTransition] = useTransition()

  // A divergent row starts with no choice, the recommendation badged rather than checked.
  const rows = work.rows.map((row) => (row.suggested?._tag === 'Answer' ? { ...row, suggested: null } : row))
  const confirmed = confirmHunks(rows, own)
  const unset = 'unset' in confirmed ? confirmed.unset : []
  const needsGrant = work.roundsExhausted
  const ready = 'hunks' in confirmed && (!needsGrant || grant)
  const current = (key: string, suggested: ConflictChoice | null) => own[key] ?? suggested
  const set = (row: ConflictRow, choice: ConflictChoice) => setOwn((all) => ({ ...all, [conflictRowKey(row)]: choice }))
  const unsetId = `conflict-unset-${waitId}`

  return (
    <form
      className="conflict-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!('hunks' in confirmed) || !ready) return
        setPending(true)
        setDetail(null)
        startTransition(async () => {
          const result = await continueConflictCard({
            project,
            issue,
            waitId,
            resolution: {
              _tag: 'ContinueConflict',
              baseSha: work.baseSha,
              headSha: work.headSha,
              ref: work.ref,
              hunks: confirmed.hunks,
              grantExtraRound: needsGrant,
            },
          })
          setPending(false)
          setDone(result.ok)
          setDetail(result.detail)
        })
      }}
    >
      <p className="conflict-where">
        <span title={work.baseSha}>
          {work.baseBranch} @ <code>{short(work.baseSha)}</code>
        </span>{' '}
        ←{' '}
        <span title={work.headSha}>
          {work.ref} @ <code>{short(work.headSha)}</code>
        </span>
        {' · '}
        {work.paths.length} {work.paths.length === 1 ? 'file' : 'files'}, {work.rows.length}{' '}
        {work.rows.length === 1 ? 'hunk' : 'hunks'}
      </p>
      {done ? null : (
        <>
          {rows.map((row, index) => {
            const key = conflictRowKey(row)
            const choice = current(key, row.suggested)
            const name = `conflict-${index}`
            const chosen = selection(choice)
            return (
              <fieldset key={key} className="conflict-row">
                <legend>
                  <code>{key}</code>
                </legend>
                {row.text !== '' ? (
                  <details className="conflict-hunk">
                    <summary>Show the divergent hunk</summary>
                    <pre className="conflict-hunk-text">{row.text}</pre>
                  </details>
                ) : null}
                {row.question !== null ? <p className="conflict-question">{row.question.text}</p> : null}
                {row.question === null && row.suggested === null ? (
                  <p className="conflict-note">No advice for this hunk — your own intent is required.</p>
                ) : null}
                <div className="triage-choices-grid">
                  {row.question?.answers.map((answer) => (
                    <label
                      key={answer.id}
                      className={`triage-choice${chosen === `answer:${answer.id}` ? ' triage-choice--selected' : ''}`}
                    >
                      <span className="triage-choice-main">
                        <input
                          type="radio"
                          name={name}
                          checked={chosen === `answer:${answer.id}`}
                          onChange={() => set(row, { _tag: 'Answer', answerId: answer.id })}
                        />
                        <span className="triage-choice-text">{answer.text}</span>
                      </span>
                      {answer.id === row.question?.recommended ? (
                        <span className="triage-choice-badges">
                          <span className="triage-choice-recommended">Recommended</span>
                        </span>
                      ) : null}
                    </label>
                  ))}
                  <label className={`triage-choice${chosen === 'mechanical' ? ' triage-choice--selected' : ''}`}>
                    <span className="triage-choice-main">
                      <input
                        type="radio"
                        name={name}
                        checked={chosen === 'mechanical'}
                        onChange={() => set(row, { _tag: 'Mechanical' })}
                      />
                      <span className="triage-choice-text">Mechanical — no behavior to decide</span>
                    </span>
                  </label>
                  <label className={`triage-choice${chosen === 'other' ? ' triage-choice--selected' : ''}`}>
                    <span className="triage-choice-main">
                      <input
                        type="radio"
                        name={name}
                        checked={chosen === 'other'}
                        onChange={() => set(row, { _tag: 'Behavior', text: '' })}
                      />
                      <span className="triage-choice-text">Other — write the behavior</span>
                    </span>
                  </label>
                </div>
                {choice?._tag === 'Behavior' ? (
                  <textarea
                    className="conflict-behavior"
                    aria-label={`Intended behavior for ${key}`}
                    rows={3}
                    value={choice.text}
                    onChange={(event) => set(row, { _tag: 'Behavior', text: event.target.value })}
                  />
                ) : null}
              </fieldset>
            )
          })}
          {needsGrant ? (
            <label className="conflict-grant">
              <input type="checkbox" checked={grant} onChange={(event) => setGrant(event.target.checked)} /> Grant one
              extra paid round beyond the ceiling — the automatic rounds are spent.
            </label>
          ) : (
            <p className="conflict-note">This uses one of the run’s remaining automatic rounds.</p>
          )}
          {unset.length > 0 ? (
            <p className="conflict-note" id={unsetId}>
              Still to choose: {unset.map((row) => conflictRowKey(row)).join(', ')}.
            </p>
          ) : null}
          <div className="btnrow">
            <button
              className={primary ? 'btn pri' : 'btn'}
              type="submit"
              disabled={pending || !ready}
              aria-describedby={unset.length > 0 ? unsetId : undefined}
            >
              {pending ? 'confirming…' : 'Confirm and continue the conflict'}
            </button>
          </div>
        </>
      )}
      {detail ? <p className={done ? 'decided' : 'refusal'}>{detail}</p> : null}
    </form>
  )
}
