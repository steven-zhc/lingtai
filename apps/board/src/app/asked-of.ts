/** Not a client module: the server-rendered `Standing` calls it too (#1253). */
import type { TriageQuestion } from '@lingtai/domain'

/**
 * What the agent itself asked on a wait (#1253): an `AgentQuestion`'s questions, or those of a `ProposedEscalated`
 * carrying an `InputNeeded`. Empty for every other reason, and for a question written as prose (`said`).
 */
export function askedOf(
  reason: { readonly _tag: string; readonly questions?: readonly TriageQuestion[]; readonly proposal?: unknown } | null,
): readonly TriageQuestion[] {
  if (reason === null) return []
  if (reason._tag === 'AgentQuestion') return reason.questions ?? []
  const proposal = reason.proposal as { _tag?: string; questions?: readonly TriageQuestion[] } | undefined
  return reason._tag === 'ProposedEscalated' && proposal?._tag === 'InputNeeded' ? (proposal.questions ?? []) : []
}
