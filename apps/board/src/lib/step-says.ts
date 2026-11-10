import type { Step } from '@lingtai/domain'

/**
 * One sentence per step of an attempt: what the step is for (#983). Imports a
 * type only, because the add page — a client component — reads it too.
 */
export const STEP_SAYS: Record<Step, string> = {
  claim: 'which tickets, and in what order',
  admit: 'the requirement, and the worktree it is built in',
  prepared: 'getting the worktree ready before the agent starts',
  design: 'a document, or none; either is an answer',
  implement: 'an agent, in that worktree',
  build: 'what must pass before review',
  review: 'reads it cold and hands in findings; it does not decide',
  proposed: 'the only step that decides what is next',
  merge: 'the branch in, verify, push',
  end: 'runs on every outcome',
}
