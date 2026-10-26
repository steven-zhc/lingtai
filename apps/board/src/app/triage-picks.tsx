'use client'

import type { TriageQuestion, WaitId } from '@lingtai/domain'
import { createContext, useContext, useState, type ReactNode } from 'react'

type Picks = { waitId: WaitId | null; answers: Record<number, string> }
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
  selected: (index: number, question: TriageQuestion) => string
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
export function draftTarget(recommended: string | null): DraftTarget | null {
  return recommended === 'EditBodyAndRequeue' || recommended === 'AnswerQuestion' ? recommended : null
}

export function TriagePicks({
  waitId,
  questions,
  recommended = null,
  children,
}: {
  waitId: WaitId | null
  questions: readonly TriageQuestion[]
  /** The card triage's advice recommends, as `recommendedResolution` answered it on the server. */
  recommended?: string | null
  children: ReactNode
}) {
  const [picks, setPicks] = useState<Picks>({ waitId, answers: {} })
  const answers = picks.waitId === waitId ? picks.answers : {}
  const [drafts, setDrafts] = useState<{ body: Draft | null; answer: AnswerDraft | null }>({
    body: null,
    answer: null,
  })
  const selected = (index: number, question: TriageQuestion) => answers[index] ?? question.recommended
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
    }))

  // A draft belongs to the wait it was written under, and is never cleared when
  // that wait ends: the person is told to copy it before leaving.
  const body = drafts.body
  const answer = drafts.answer
  const target = waitId === null ? null : draftTarget(recommended)
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
        selected,
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
 * One resolution card. `recommended` is triage's advice as
 * `recommendedResolution` answered it on the server; `Standing` already puts
 * that card first, so the order here is the DOM's.
 */
export function ResolutionCard({
  recommended,
  className,
  head,
  children,
  ...rest
}: {
  recommended: boolean
  className: string
  head: ReactNode
  children: ReactNode
  'data-resolution'?: string
  /** The anchor a waiting card's button opens the page at (#647). */
  id?: string
  hidden?: boolean
}) {
  return (
    <article className={`${className}${recommended ? ' sresolution--recommended' : ''}`} {...rest}>
      {head !== null ? (
        <div className="sresolutionhead">
          {head}
          {recommended ? <span className="sresolutionbadge">Triage recommended</span> : null}
        </div>
      ) : null}
      {children}
    </article>
  )
}
