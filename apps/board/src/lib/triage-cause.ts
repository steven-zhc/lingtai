import type { RootCause } from '@lingtai/domain/wait'

export type CauseChip = 'decision' | 'lines' | 'approach' | 'merge' | 'oversized' | 'setup'

export interface CausePresentation {
  label: string
  chip: CauseChip
}

const CAUSES: Record<RootCause['_tag'], CausePresentation> = {
  UndecidedQuestion: { label: 'A decision for you', chip: 'decision' },
  FixableLines: { label: 'Lines to fix', chip: 'lines' },
  WrongApproach: { label: 'The approach is wrong', chip: 'approach' },
  ConflictingHunks: { label: 'Merge by hand', chip: 'merge' },
  TicketTooBig: { label: 'Ticket too big', chip: 'oversized' },
  SetupBroken: { label: 'Fix the setup', chip: 'setup' },
}

export function presentCause(cause: RootCause): CausePresentation {
  return CAUSES[cause._tag]
}
