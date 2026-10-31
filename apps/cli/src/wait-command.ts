import type { Resolution, WaitReason } from '@lingtai/domain/wait'

type Tag = Resolution['_tag']

/**
 * A wait's moves (`waitMoves`) spelled as the one line a person reads (#769):
 * the recommended command first, the others after it, and the board last.
 * Pure; it ranks nothing, so an unranked wait reads `one of: …`.
 */
export function waitCommand(
  moves: { first: Tag | null; rest: Tag[] },
  at: { project: string; issue: number | string; reason: WaitReason },
): string {
  const base = (verb: string): string => `lingtai ${verb} ${at.project} --issue ${at.issue}`
  const { reason } = at
  const asksForAnswer =
    reason._tag === 'AgentQuestion' || (reason._tag === 'ProposedEscalated' && reason.proposal._tag === 'InputNeeded')
  const ordered = [...(moves.first === null ? [] : [moves.first]), ...moves.rest]
  const entries: string[] = []
  let requeued = false
  for (const tag of ordered) {
    if (tag === 'Requeue' || tag === 'EditBodyAndRequeue') {
      if (requeued) continue
      requeued = true
      // Only what the wait allows is spelled: the body edit when `EditBodyAndRequeue` is offered,
      // and the bare restart (brackets) when `Requeue` is offered beside it.
      const editsBody = ordered.includes('EditBodyAndRequeue')
      const bare = ordered.includes('Requeue')
      const body = !editsBody
        ? ''
        : asksForAnswer
          ? ' --into-body "<answer>"'
          : bare
            ? ' [--into-body "<text>"]'
            : ' --into-body "<text>"'
      entries.push(`${base('requeue')}${body}`)
    } else if (tag === 'Approve') {
      entries.push(reason._tag === 'SignoffRequired' ? base('approve') : `${base('approve')} --note "<why>"`)
    } else if (tag === 'GrantFixRound') {
      entries.push(base('grant-fix-round'))
    } else if (tag === 'AnswerQuestion') {
      entries.push(`${base('answer')} "<choice>"`)
    }
  }
  if (entries.length === 0) return 'the board'
  if (moves.first === null) return `one of: ${entries.join(', or ')}   (or the board)`
  const [first, ...rest] = entries
  return `${first}   (${[...rest.map((e) => `or ${e}`), 'or the board'].join(', ')})`
}
