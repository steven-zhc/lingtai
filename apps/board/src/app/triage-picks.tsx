'use client'

import { triageAnswersText, type TriagePick, type TriageQuestion, type WaitId } from '@lingtai/domain'
import { createContext, useContext, useState, type ReactNode } from 'react'

import { MarkdownField } from './markdown-field.tsx'

/** Triage's picks and the agent's own are kept apart (#1253): one state, two maps. */
type Picks = {
  waitId: WaitId | null
  answers: Record<number, TriagePick>
  asked: Record<number, TriagePick>
  /** What the person wrote as their own answer, kept when they switch back to a listed one. */
  ownAnswers: Record<number, string>
  ownAsked: Record<number, string>
}

/** The radio value of the own-answer option. Page-only: it is never sent, a pick is `{ own }` instead. */
export const OWN_VALUE = '__own__'
/** A text the person has made their own, with the wait it was written under. */
type Draft = {
  waitId: WaitId | null
  text: string
  /** For a body edited after its wait ended: the wait whose retained own words the text already holds, so those are not joined again (identity, not text). */
  absorbed?: { from: WaitId | null } | null
}
type AnswerDraft = Draft & { open: boolean }
/** The two resolutions whose text a discussion answer can be added to. */
export type DraftTarget = 'EditBodyAndStartNewAttempt' | 'AnswerQuestion'
type TriageDraft = {
  waitId: WaitId | null
  text: string
  /** The current wait's picks, by question index in `triageQuestionsOf`'s order; empty under another wait's. */
  picks: Readonly<Record<number, TriagePick>>
  /** Why the page will not send these picks yet (an own answer left empty), or null. */
  refusal: string | null
  /** The body editor's draft once the person has edited it or added to it; null while it follows the picks. */
  body: Draft | null
  /** The own answers written under a wait, kept as text so they outlive it like a body draft does; null when none. */
  retainedOwn: Draft | null
  setBody: (text: string) => void
  /** The answer box's draft, and whether the box is open — open from an add as well as from its button. */
  answer: AnswerDraft | null
  setAnswer: (text: string) => void
  closeAnswer: () => void
  /** The recommended resolution a discussion answer can be added to, or null. */
  target: DraftTarget | null
  /** Appends to the target's draft. Page state only: the resolution is what writes (0118 §6). */
  add: (text: string) => void
  /** The wait's own questions (`AgentQuestion`, `InputNeeded`), empty where it asked none in this shape (#1253). */
  asked: readonly TriageQuestion[]
  selected: (index: number, question: TriageQuestion, source?: AnswerSource) => TriagePick
  pick: (index: number, answerId: string, source?: AnswerSource) => void
  /** Chooses the own-answer option, with the text last written there. */
  pickOwn: (index: number, source?: AnswerSource) => void
  /** Writes the own answer's text; it is the pick while the own option is chosen. */
  setOwn: (index: number, text: string, source?: AnswerSource) => void
  /** The text last written as an own answer. */
  ownText: (index: number, source?: AnswerSource) => string
  /** A button on this page has sent and not yet been answered, or was answered for `doneWaitId`; shared by every card that sends. */
  sending: Sending
  setSending: (next: Sending) => void
}

export type Sending = { pending: boolean; doneWaitId: WaitId | null }

/** Whose question a choice answers: triage's advice, or the agent's own question on the wait. */
export type AnswerSource = 'triage' | 'asked'

const Context = createContext<TriageDraft | null>(null)

/** An addition goes under what is there, after a blank line; into an empty draft it is the draft. */
export const appendTo = (current: string, addition: string): string =>
  current.trim() === '' ? addition : `${current}\n\n${addition}`

/**
 * The resolution the page draws first, when it writes text a person can see.
 * Split's plan and the fixes list are #563's and are not targets.
 */
export function draftTarget(recommended: string | null): DraftTarget | null {
  return recommended === 'EditBodyAndStartNewAttempt' || recommended === 'AnswerQuestion' ? recommended : null
}

export function TriagePicks({
  waitId,
  cause,
  asked = null,
  recommended = null,
  children,
}: {
  waitId: WaitId | null
  /** The cause triage advised, whose questions the choices draw; null when there is none. */
  cause: Parameters<typeof triageAnswersText>[0] | null
  /**
   * What the agent asked on this wait, from the wait's own reason (#1253). Its picks are kept apart from
   * triage's: the server checks `picks` against triage's cause, and an agent's answer id is not one of its.
   */
  asked?: readonly TriageQuestion[] | null
  /** The card triage's advice recommends, as `recommendedResolution` answered it on the server. */
  recommended?: string | null
  children: ReactNode
}) {
  const [picks, setPicks] = useState<Picks>({ waitId, answers: {}, asked: {}, ownAnswers: {}, ownAsked: {} })
  const answers = picks.waitId === waitId ? picks.answers : {}
  const askedAnswers = picks.waitId === waitId ? picks.asked : {}
  const ownAnswers = picks.waitId === waitId ? picks.ownAnswers : {}
  const ownAsked = picks.waitId === waitId ? picks.ownAsked : {}
  const [drafts, setDrafts] = useState<{ body: Draft | null; answer: AnswerDraft | null; own: Draft | null }>({
    body: null,
    answer: null,
    own: null,
  })
  const [sending, setSending] = useState<Sending>({ pending: false, doneWaitId: null })
  const askedList = asked ?? []
  const selected = (index: number, question: TriageQuestion, source: AnswerSource = 'triage') =>
    (source === 'asked' ? askedAnswers : answers)[index] ?? question.recommended
  const ownText = (index: number, source: AnswerSource = 'triage') =>
    (source === 'asked' ? ownAsked : ownAnswers)[index] ?? ''
  // The one composition: the server writes this same text for the same picks (#921).
  const composed = cause === null ? null : triageAnswersText(cause, answers)
  // What the wait itself asked is composed the same way and takes the body box first (#1253).
  const composedAsked =
    askedList.length === 0 ? null : triageAnswersText({ _tag: 'UndecidedQuestion', questions: askedList }, askedAnswers)
  const text = composedAsked?.ok ? composedAsked.text : composed?.ok ? composed.text : ''
  const blankOwn = [answers, askedAnswers].some((m) =>
    Object.values(m).some((p) => typeof p !== 'string' && p.own.trim() === ''),
  )
  const refusal = !blankOwn
    ? null
    : composedAsked !== null && !composedAsked.ok
      ? composedAsked.detail
      : composed?.ok === false
        ? composed.detail
        : null
  const update = (source: AnswerSource, change: (current: Picks) => Partial<Picks>) =>
    setPicks((current) => {
      const same = current.waitId === waitId
      const base: Picks = same ? current : { waitId, answers: {}, asked: {}, ownAnswers: {}, ownAsked: {} }
      return { ...base, ...change(base) }
    })
  const pick = (index: number, answerId: string, source: AnswerSource = 'triage') =>
    update(source, (c) =>
      source === 'asked'
        ? { asked: { ...c.asked, [index]: answerId } }
        : { answers: { ...c.answers, [index]: answerId } },
    )
  const pickOwn = (index: number, source: AnswerSource = 'triage') =>
    update(source, (c) =>
      source === 'asked'
        ? { asked: { ...c.asked, [index]: { own: c.ownAsked[index] ?? '' } } }
        : { answers: { ...c.answers, [index]: { own: c.ownAnswers[index] ?? '' } } },
    )
  const setOwn = (index: number, own: string, source: AnswerSource = 'triage') => {
    update(source, (c) =>
      source === 'asked'
        ? { ownAsked: { ...c.ownAsked, [index]: own }, asked: { ...c.asked, [index]: { own } } }
        : { ownAnswers: { ...c.ownAnswers, [index]: own }, answers: { ...c.answers, [index]: { own } } },
    )
    // The own words also go where a draft goes, so a wait ending under them does not take them (#1255).
    const written = { ...(source === 'asked' ? ownAsked : ownAnswers), [index]: own }
    const other = source === 'asked' ? ownAnswers : ownAsked
    const chosen = [...Object.values(other), ...Object.values(written)].filter((t) => t.trim() !== '')
    setDrafts((current) => ({ ...current, own: { waitId, text: chosen.join('\n\n') } }))
  }

  // A draft belongs to the wait it was written under, and is never cleared when
  // that wait ends: the person is told to copy it before leaving.
  const body = drafts.body
  const answer = drafts.answer
  const target = waitId === null ? null : draftTarget(recommended)
  const setBody = (next: string) =>
    setDrafts((current) => ({
      ...current,
      body: {
        waitId,
        text: next,
        ...(waitId === null ? { absorbed: current.own ? { from: current.own.waitId } : null } : {}),
      },
    }))
  const setAnswer = (next: string) =>
    setDrafts((current) => ({ ...current, answer: { waitId, text: next, open: true } }))
  const closeAnswer = () =>
    setDrafts((current) => ({
      ...current,
      answer: current.answer === null ? null : { ...current.answer, open: false },
    }))
  const add = (addition: string) => {
    if (target === 'EditBodyAndStartNewAttempt')
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
        picks: answers,
        refusal,
        retainedOwn: drafts.own,
        body,
        setBody,
        answer,
        setAnswer,
        closeAnswer,
        target,
        add,
        asked: askedList,
        selected,
        pick,
        pickOwn,
        setOwn,
        ownText,
        sending,
        setSending,
      }}
    >
      {children}
    </Context.Provider>
  )
}

export function useTriageDraft(): TriageDraft | null {
  return useContext(Context)
}

export function TriageChoices({
  question,
  index,
  source = 'triage',
}: {
  question: TriageQuestion
  index: number
  source?: AnswerSource
}) {
  const draft = useTriageDraft()
  const selected = draft?.selected(index, question, source) ?? question.recommended
  const ownChosen = typeof selected !== 'string'
  const name = `${source === 'asked' ? 'asked' : 'triage'}-question-${index}`
  // The recommended answer first, then the rest in the agent's order; the stored question is not touched.
  const ordered = [
    ...question.answers.filter((a) => a.id === question.recommended),
    ...question.answers.filter((a) => a.id !== question.recommended),
  ]
  return (
    <fieldset className="triage-choices">
      <legend className="triage-choices-question">{`${index + 1}. ${question.text}`}</legend>
      <div className="triage-choices-grid">
        {ordered.map((answer) => (
          <label key={answer.id} className={`triage-choice${selected === answer.id ? ' triage-choice--selected' : ''}`}>
            <span className="triage-choice-main">
              <input
                type="radio"
                name={name}
                value={answer.id}
                checked={selected === answer.id}
                onChange={() => draft?.pick(index, answer.id, source)}
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
        <label className={`triage-choice${ownChosen ? ' triage-choice--selected' : ''}`}>
          <span className="triage-choice-main">
            <input
              type="radio"
              name={name}
              value={OWN_VALUE}
              checked={ownChosen}
              onChange={() => draft?.pickOwn(index, source)}
            />
            <span className="triage-choice-text">My own answer</span>
          </span>
          <span className="triage-choice-badges">
            {ownChosen ? <span className="triage-choice-selected">Selected</span> : null}
            <span className="triage-choice-hint">Write it yourself.</span>
          </span>
        </label>
      </div>
      {ownChosen ? (
        <label className="triage-own">
          <span>Your own answer</span>
          <MarkdownField value={selected.own} onChange={(text) => draft?.setOwn(index, text, source)} />
        </label>
      ) : null}
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
  badge = 'Triage recommended',
  className,
  head,
  children,
  ...rest
}: {
  recommended: boolean
  /** The badge's words when `recommended`; triage's by default. */
  badge?: string
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
          {recommended ? <span className="sresolutionbadge">{badge}</span> : null}
        </div>
      ) : null}
      {children}
    </article>
  )
}
