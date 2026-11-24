import type { ImplementOutcome, OutcomeForm } from '@lingtai/domain'

/** How much of a final message an unreadable outcome quotes back (#1398). */
export const UNREAD_TAIL = 300

/** The run-log line for an outcome read from a form other than the ```outcome fence. */
export function outcomeFormNote(form: Exclude<OutcomeForm, 'fence'>): string {
  const what = { 'json-fence': 'a json fence', 'last-line': 'the last line', 'bare-word': 'a bare Implemented' }[form]
  return `outcome read from ${what}`
}

/** An `AgentFailed` for a message nothing could be read from, carrying the message's tail apart from `why` (`wallOf` reads `why`). */
export function withUnreadTail(
  failed: Extract<ImplementOutcome, { _tag: 'AgentFailed' }>,
  text: string | null,
): ImplementOutcome {
  const tail = (text ?? '').trim().slice(-UNREAD_TAIL)
  return tail === '' ? failed : { ...failed, said: tail }
}
