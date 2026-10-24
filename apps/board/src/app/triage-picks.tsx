'use client'

import type { TriageQuestion, WaitId } from '@lingtai/domain'
import { createContext, useContext, useState, type ReactNode } from 'react'

type Picks = { waitId: WaitId | null; answers: Record<number, string> }
type TriageDraft = {
  waitId: WaitId | null
  text: string
  selected: (index: number, question: TriageQuestion) => string
  pick: (index: number, answerId: string) => void
}

const Context = createContext<TriageDraft | null>(null)
const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim()

export function TriagePicks({
  waitId,
  questions,
  children,
}: {
  waitId: WaitId | null
  questions: readonly TriageQuestion[]
  children: ReactNode
}) {
  const [picks, setPicks] = useState<Picks>({ waitId, answers: {} })
  const answers = picks.waitId === waitId ? picks.answers : {}
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

  return <Context.Provider value={{ waitId, text, selected, pick }}>{children}</Context.Provider>
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
