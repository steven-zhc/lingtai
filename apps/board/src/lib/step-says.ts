import type { Step } from '@lingtai/domain'

/**
 * One sentence per step of an attempt: what the step is for (#983). Imports a
 * type only, because the add page — a client component — reads it too.
 */
export const STEP_SAYS: Record<Step, string> = {
  claim: 'which tickets, and in what order',
  admit: 'the requirement, and the worktree it is built in',
  prepared: 'getting the worktree ready before the agent starts',
  design: 'a document, or none',
  implement: 'which agent writes the change',
  build: 'what must pass before review',
  review: 'which agent, if any, reads it cold',
  proposed: 'the only step that decides what is next',
  merge: 'the branch in, verify, push',
  end: 'what happens to the ticket, on every outcome',
}
