'use client'

import type { TriageQuestion, WaitId } from '@lingtai/domain'
import { createContext, useContext, useState, type ReactNode } from 'react'

export type Reading = 'judge' | 'triage'
type Picks = {
  waitId: WaitId | null
  answers: Record<number, string>
  touched: Record<number, number>
  reading: Reading | null
}
/** A text the person has made their own, with the wait it was written under. */
type Draft = { waitId: WaitId | null; text: string }
type AnswerDraft = Draft & { open: boolean }
/** The two resolutions whose text a discussion answer can be added to. */
export type DraftTarget = 'EditBodyAndRequeue' | 'AnswerQuestion'
type TriageDraft = {
  waitId: WaitId | null
  text: string
  /** The body editor's draft once the person has edited it or added to it; null while it follows the picks. */
  body: Draft | null
  setBody: (text: string) => void
  /** The answer box's draft, and whether the box is open — open from an add as well as from its button. */
  answer: AnswerDraft | null
  setAnswer: (text: string) => void
  closeAnswer: () => void
  /** The recommended resolution a discussion answer can be added to, or null. */
  target: DraftTarget | null
  /** Appends to the target's draft. Page state only: the resolution is what writes (0118 §6). */
  add: (text: string) => void
  /** Which of a judge/triage disagreement's readings the person chose — page state, never an event (0118 §6). */
  reading: Reading | null
  pickReading: (reading: Reading | null) => void
  selected: (index: number, question: TriageQuestion) => string
  /** How many times the person has acted on this question's radios, including re-clicking the checked one. */
  touched: (index: number) => number
  pick: (index: number, answerId: string) => void
}

const Context = createContext<TriageDraft | null>(null)
const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim()

/** An addition goes under what is there, after a blank line; into an empty draft it is the draft. */
export const appendTo = (current: string, addition: string): string =>
  current.trim() === '' ? addition : `${current}\n\n${addition}`

/**
 * The resolution the page draws first, when it writes text a person can see.
 * Split's plan and the fixes list are #563's and are not targets.
 */
export function draftTarget(
  by: Record<'none' | 'judge' | 'triage', string | null>,
  reading: Reading | null,
): DraftTarget | null {
  const tag = by[reading ?? 'none']
  return tag === 'EditBodyAndRequeue' || tag === 'AnswerQuestion' ? tag : null
}

export function TriagePicks({
  waitId,
  questions,
  initialReading = null,
  recommendedBy = { none: null, judge: null, triage: null },
  children,
}: {
  waitId: WaitId | null
  questions: readonly TriageQuestion[]
  /** As `recommendedResolution` answered it on the server, per reading. */
  recommendedBy?: Record<'none' | 'judge' | 'triage', string | null>
  /** For a static render, which has no click to make the pick with. */
  initialReading?: Reading | null
  children: ReactNode
}) {
  const [picks, setPicks] = useState<Picks>({ waitId, answers: {}, touched: {}, reading: initialReading })
  const answers = picks.waitId === waitId ? picks.answers : {}
  const touches = picks.waitId === waitId ? picks.touched : {}
  const reading = picks.waitId === waitId ? picks.reading : null
  const [drafts, setDrafts] = useState<{ body: Draft | null; answer: AnswerDraft | null }>({
    body: null,
    answer: null,
  })
  const selected = (index: number, question: TriageQuestion) => answers[index] ?? question.recommended
  const touched = (index: number) => touches[index] ?? 0
  const text = questions
    .map((question, index) => {
      const answer = question.answers.find((item) => item.id === selected(index, question))
      return `${oneLine(question.text)} — ${oneLine(answer?.text ?? '')}`
    })
    .join('\n')
  const pick = (index: number, answerId: string) =>
    setPicks((current) => ({
      waitId,
      answers: { ...(current.waitId === waitId ? current.answers : {}), [index]: answerId },
      touched: {
        ...(current.waitId === waitId ? current.touched : {}),
        [index]: (current.waitId === waitId ? (current.touched[index] ?? 0) : 0) + 1,
      },
      reading: current.waitId === waitId ? current.reading : null,
    }))
  const pickReading = (next: Reading | null) =>
    setPicks((current) => ({
      waitId,
      answers: current.waitId === waitId ? current.answers : {},
      touched: current.waitId === waitId ? current.touched : {},
      reading: next,
    }))

  // A draft belongs to the wait it was written under, and is never cleared when
  // that wait ends: the person is told to copy it before leaving.
  const body = drafts.body
  const answer = drafts.answer
  const target = waitId === null ? null : draftTarget(recommendedBy, reading)
  const setBody = (next: string) => setDrafts((current) => ({ ...current, body: { waitId, text: next } }))
  const setAnswer = (next: string) =>
    setDrafts((current) => ({ ...current, answer: { waitId, text: next, open: true } }))
  const closeAnswer = () =>
    setDrafts((current) => ({
      ...current,
      answer: current.answer === null ? null : { ...current.answer, open: false },
    }))
  const add = (addition: string) => {
    if (target === 'EditBodyAndRequeue')
      setDrafts((current) => ({
        ...current,
        body: {
          waitId,
          text: appendTo(current.body?.waitId === waitId ? current.body.text : text, addition),
        },
      }))
    else if (target === 'AnswerQuestion')
      setDrafts((current) => ({
        ...current,
        answer: {
          waitId,
          text: appendTo(current.answer?.waitId === waitId ? current.answer.text : '', addition),
          open: true,
        },
      }))
  }

  return (
    <Context.Provider
      value={{
        waitId,
        text,
        body,
        setBody,
        answer,
        setAnswer,
        closeAnswer,
        target,
        add,
        reading,
        pickReading,
        selected,
        touched,
        pick,
      }}
    >
      {children}
    </Context.Provider>
  )
}

export function useTriageDraft(): TriageDraft | null {
  return useContext(Context)
}

export function TriageChoices({ question, index }: { question: TriageQuestion; index: number }) {
  const draft = useTriageDraft()
  const selected = draft?.selected(index, question) ?? question.recommended
  return (
    <fieldset className="triage-choices">
      <legend className="triage-choices-question">{question.text}</legend>
      <div className="triage-choices-grid">
        {question.answers.map((answer) => (
          <label key={answer.id} className={`triage-choice${selected === answer.id ? ' triage-choice--selected' : ''}`}>
            <span className="triage-choice-main">
              <input
                type="radio"
                name={`triage-question-${index}`}
                value={answer.id}
                checked={selected === answer.id}
                onChange={() => draft?.pick(index, answer.id)}
                onClick={() => draft?.pick(index, answer.id)}
              />
              <span className="triage-choice-text">{answer.text}</span>
            </span>
            <span className="triage-choice-badges">
              {selected === answer.id ? <span className="triage-choice-selected">Selected</span> : null}
              {answer.id === question.recommended ? (
                <span className="triage-choice-recommended">Recommended</span>
              ) : null}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/**
 * Which reading of a judge/triage disagreement is right (0118 §5). Choosing
 * only decides which resolution is drawn first; it resolves nothing and
 * writes nothing.
 */
export function ReadingChoice({ judgeDrawsNothing }: { judgeDrawsNothing: boolean }) {
  const draft = useTriageDraft()
  const reading = draft?.reading ?? null
  const options: { value: Reading | null; label: string; note: string | null }[] = [
    {
      value: 'judge',
      label: 'The judge is right',
      note: judgeDrawsNothing ? 'The judge handed this wait to you, so no resolution is drawn first.' : null,
    },
    { value: 'triage', label: 'Triage is right', note: null },
    { value: null, label: 'Neither', note: 'No resolution is drawn first.' },
  ]
  return (
    <fieldset className="triage-choices">
      <legend className="triage-choices-question">Which reading is right?</legend>
      <div className="triage-choices-grid">
        {options.map((option) => (
          <label
            key={option.value ?? 'neither'}
            className={`triage-choice${reading === option.value ? ' triage-choice--selected' : ''}`}
          >
            <span className="triage-choice-main">
              <input
                type="radio"
                name="triage-reading"
                value={option.value ?? ''}
                checked={reading === option.value}
                onChange={() => draft?.pickReading(option.value)}
              />
              <span className="triage-choice-text">
                {option.label}
                {option.note !== null ? ` — ${option.note}` : ''}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/**
 * One resolution card. `by` says whether it is the recommended one under each
 * reading, as `recommendedResolution` answered it on the server; the person's
 * pick selects among those answers here. Order is CSS `order`, so the keyed
 * body editor stays mounted.
 */
export function ResolutionCard({
  by,
  disagreed,
  className,
  head,
  children,
  ...rest
}: {
  by: { none: boolean; judge: boolean; triage: boolean }
  disagreed: boolean
  className: string
  head: ReactNode
  children: ReactNode
  'data-resolution'?: string
  hidden?: boolean
}) {
  const reading = useTriageDraft()?.reading ?? null
  const recommended = by[reading ?? 'none']
  const badge = recommended ? (
    <span className="sresolutionbadge">
      {disagreed && reading === 'judge' ? 'Judge’s reading' : 'Triage recommended'}
    </span>
  ) : null
  return (
    <article
      className={`${className}${recommended ? ' sresolution--recommended' : ''}`}
      style={disagreed ? { order: recommended ? -1 : 0 } : undefined}
      {...rest}
    >
      {head !== null ? (
        <div className="sresolutionhead">
          {head}
          {badge}
        </div>
      ) : null}
      {children}
    </article>
  )
}
