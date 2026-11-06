import type { Resolution, WaitReason } from '@lingtai/domain/wait'

/** Every requeue's cost line says so (0118 §7): a restart is neither spent nor refunded. */
export const NO_RESTART_EFFECT = 'This neither spends nor refunds an automatic restart.'

export const RESOLUTION_COPY: Record<Resolution['_tag'], { title: string; consequence: string }> = {
  Approve: {
    title: 'Approve and continue',
    consequence: 'Continue this attempt from its recorded commit. Every refusal that stopped it is waived.',
  },
  GrantFixRound: {
    title: 'Continue fixing current work',
    consequence:
      'Start from the saved branch and head for one additional paid fix round. Build and review run again; this does not waive either refusal.',
  },
  AnswerQuestion: {
    title: 'Answer the question',
    consequence: 'Give the answer to the next attempt, or withdraw the question and return the ticket to the queue.',
  },
  Requeue: {
    title: 'Start over from base',
    consequence:
      'Start a new attempt from base with the recipe’s rounds. The saved branch is not continued. ' + NO_RESTART_EFFECT,
  },
  EditBodyAndRequeue: {
    title: 'Add to the ticket and start over',
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
  return RESOLUTION_COPY[tag]
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
