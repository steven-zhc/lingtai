import type { Resolution, WaitReason } from '@lingtai/domain/wait'

/** Every start-new-attempt cost line says so (0118 §7): an automatic new attempt is neither spent nor refunded. */
export const NO_RESTART_EFFECT = 'This neither spends nor refunds one of the ticket’s automatic new attempts.'

export const RESOLUTION_COPY: Record<Resolution['_tag'], { title: string; consequence: string }> = {
  Approve: {
    title: 'Approve and continue',
    consequence: 'Continue this attempt from its recorded commit. Every refusal that stopped it is waived.',
  },
  FixRefusal: {
    title: 'Fix the refusal on the saved work',
    consequence:
      'Start from the saved branch and head for one additional paid refusal fix. Build and review run again; this does not waive either refusal.',
  },
  RedoStep: {
    title: 'Redo this step on the saved work',
    consequence:
      'Run the step that stopped again, in this attempt, on its saved head. No fixer is dispatched and nothing is cut from base; no refusal fix or new attempt is spent.',
  },
  AnswerQuestions: {
    title: 'Answer and continue the step',
    consequence:
      'Write the answers into the ticket body, then run the step that asked again on its saved work. No new attempt starts and no step redo is spent; it uses one of the ticket’s five asks, which are already counted.',
  },
  ConfirmSatisfied: {
    title: 'Confirm it is already satisfied',
    consequence:
      'End the ticket as satisfied by what the base already holds. Nothing is merged, and the recipe’s `when: satisfied` actions run.',
  },
  AnswerQuestion: {
    title: 'Answer the question',
    consequence: 'Give the answer to the next attempt, or withdraw the question and return the ticket to the queue.',
  },
  StartNewAttempt: {
    title: 'Start a new attempt from base',
    consequence:
      'Queue a new attempt from base with the recipe’s refusal fixes. The saved branch is not continued. ' +
      NO_RESTART_EFFECT,
  },
  EditBodyAndStartNewAttempt: {
    title: 'Add to the ticket and start a new attempt',
    consequence:
      'Append your text to the ticket body, then queue a new attempt from main with that text. ' + NO_RESTART_EFFECT,
  },
  Split: {
    title: 'Split into smaller tickets',
    consequence: 'Open the approved child tickets in the order given; the ticket then stops waiting on you.',
  },
  Close: {
    title: 'Close the ticket',
    consequence: 'End this ticket without another attempt. A reason is required.',
  },
}

/**
 * The copy for a resolution on a particular wait. Approve on a `DiffTooLarge` wait
 * waives nothing: it runs the reviewer once on the clipped diff (#892, 0108 §14),
 * so the generic *any refusal is waived* line would be false there.
 */
export function resolutionCopyFor(
  tag: Resolution['_tag'],
  reason: WaitReason | null,
): { title: string; consequence: string } {
  if (tag === 'Approve' && reason?._tag === 'ProposedEscalated' && reason.proposal._tag === 'DiffTooLarge') {
    return clippedApproveCopy(reason.proposal.limit)
  }
  if (reason?._tag === 'SatisfiedUnconfirmed') {
    const own = SATISFIED_WAIT_TITLE[tag]
    if (own !== undefined) return { title: own, consequence: RESOLUTION_COPY[tag].consequence }
  }
  return RESOLUTION_COPY[tag]
}

/** The mock's titles for the confirm wait (#1252), keyed here so no other wait reads them. */
const SATISFIED_WAIT_TITLE: Partial<Record<Resolution['_tag'], string>> = {
  ConfirmSatisfied: 'Confirm it is already done',
  StartNewAttempt: 'Start over from base',
  EditBodyAndStartNewAttempt: 'Add to the ticket and start over',
}

/** Approve on a `DiffTooLarge` wait, for a surface that has the limit and not the reason (#892). */
export function clippedApproveCopy(limit: number): { title: string; consequence: string } {
  return {
    title: `Review the first ${limit} anyway`,
    consequence: `Run the reviewer once on the first ${limit} characters of the diff. Nothing is waived, and the review records that it read only part. No note is needed.`,
  }
}

/** A move's title; an unknown tag (an event older than the type) prints as it is. */
export function moveTitle(tag: string): string {
  return Object.hasOwn(RESOLUTION_COPY, tag) ? RESOLUTION_COPY[tag as Resolution['_tag']].title : tag
}
