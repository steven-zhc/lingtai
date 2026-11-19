import type { AdvisedCause, Cause } from '@lingtai/domain/wait'

export type CauseChip = 'decision' | 'lines' | 'approach' | 'merge' | 'oversized' | 'setup' | 'unfinished'

export interface CausePresentation {
  label: string
  chip: CauseChip
}

const CAUSES: Record<Cause['_tag'], CausePresentation> = {
  UndecidedQuestion: { label: 'A decision for you', chip: 'decision' },
  FixableLines: { label: 'Lines to fix', chip: 'lines' },
  WrongApproach: { label: 'The approach is wrong', chip: 'approach' },
  ConflictingHunks: { label: 'Merge by hand', chip: 'merge' },
  TicketTooBig: { label: 'Ticket too big', chip: 'oversized' },
  SetupBroken: { label: 'Fix the setup', chip: 'setup' },
  Unfinished: { label: 'Did not finish', chip: 'unfinished' },
}

export function presentCause(cause: Cause | AdvisedCause): CausePresentation {
  return CAUSES[cause._tag]
}

/** A cause tag as the page says it: no tag is *not triaged*, and a tag with no entry shows itself. */
export function causeLabel(tag: string | null): string {
  if (tag === null) return 'not triaged'
  return (CAUSES as Record<string, CausePresentation | undefined>)[tag]?.label ?? tag
}
