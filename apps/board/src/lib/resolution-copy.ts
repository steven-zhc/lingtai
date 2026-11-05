import type { Resolution } from '@lingtai/domain/wait'

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

/** A move's title; an unknown tag (an event older than the type) prints as it is. */
export function moveTitle(tag: string): string {
  return Object.hasOwn(RESOLUTION_COPY, tag) ? RESOLUTION_COPY[tag as Resolution['_tag']].title : tag
}
