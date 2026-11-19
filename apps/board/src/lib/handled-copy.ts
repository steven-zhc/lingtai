/** What each problem kind says in the Waiting column's card: the problem, what was done, and the hover (#1286). */
export interface KindCopy {
  problem: string
  action: string
  hint: string
  /** A CSS colour for the kind's marks. */
  colour: string
}

const COPY: Record<string, KindCopy> = {
  'review-fixed': {
    problem: 'AI review found problems',
    action: 'auto-fixed',
    hint: 'Before any code is accepted, an AI reviewer reads it. When it found problems, the agent fixed them and had the code reviewed again.',
    colour: 'var(--s1)',
  },
  'review-restarted': {
    problem: 'AI review rejected the approach',
    action: 'auto-restarted',
    hint: 'The AI reviewer found the whole approach wrong, so the agent started the work again rather than patching it.',
    colour: 'var(--s2)',
  },
  'base-moved': {
    problem: 'newer changes landed first',
    action: 'auto-merged, re-tested',
    hint: 'Your project moved on while this work was in progress. Lingtai pulled in the newer code and ran the tests again, so nothing is built on an outdated copy.',
    colour: 'var(--accent)',
  },
  conflict: {
    problem: 'two changes touched the same code',
    action: 'auto-combined',
    hint: 'This work and a newer change edited the same lines. The agent combined both versions so neither was lost.',
    colour: 'var(--s3)',
  },
  build: {
    problem: 'tests or build broke',
    action: 'auto-fixed',
    hint: "Your project's tests or build failed on this change. The agent fixed the code until they passed.",
    colour: 'var(--signal)',
  },
  stopped: {
    problem: 'the agent stopped',
    action: 'auto-resumed',
    hint: 'The agent stopped before it finished. Lingtai started it again where it left off.',
    colour: 'var(--s4)',
  },
  disputed: {
    problem: 'the agent disputed a review finding',
    action: 'AI judge decided',
    hint: 'The agent disagreed with a review finding, so an AI judge decided who was right.',
    colour: 'var(--held)',
  },
  'too-big': {
    problem: 'task too big for one change',
    action: 'auto-split',
    hint: 'The change grew too large to review in one piece, so the work was split into smaller tickets.',
    colour: 'var(--warn)',
  },
  asked: {
    problem: 'the agent asked a question',
    action: 'auto-answered',
    hint: 'The agent needed an answer to go on, and Lingtai answered it without bothering you.',
    colour: 'var(--rule-2)',
  },
  setup: {
    problem: 'the project setup was refused',
    action: 'auto-fixed',
    hint: 'The project could not be prepared for the agent. Lingtai fixed that and went on.',
    colour: 'var(--rule-2)',
  },
  other: {
    problem: 'something else',
    action: 'handled',
    hint: 'A problem that fits none of the other kinds, handled without you.',
    colour: 'var(--rule-2)',
  },
}

export const kindCopy = (kind: string): KindCopy =>
  COPY[kind] ?? { problem: kind, action: 'handled', hint: kind, colour: 'var(--rule-2)' }
