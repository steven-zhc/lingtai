import { conflictRoundsExhausted, conflictRows, type ConflictRow, type TriageStatus } from '@lingtai/domain/wait'

/** A counted hunk with the text a person reads before choosing for it. */
export type ConflictFormRow = ConflictRow & { text: string }

/** What a `ContinueConflict` card is drawn from — or the reason there is no card. */
export type ConflictWork =
  | {
      baseSha: string
      headSha: string
      ref: string
      baseBranch: string
      paths: string[]
      rows: ConflictFormRow[]
      /** Whether the automatic rounds are spent, so the continuation needs an expressly granted extra one. */
      roundsExhausted: boolean
    }
  | { baseSha: string; headSha: string; ref: string; baseBranch: string; tooMany: number }
  | { refusal: string }

/** The ports `continueConflictPorts` assembles, as the page reads them. */
export interface ConflictWorkPorts {
  client: { refSha(ref: string): Promise<string | null> }
  base: string
  conflicts: (
    baseSha: string,
    headSha: string,
  ) => Promise<readonly { path: string; hunkLines: readonly number[]; hunkTexts?: readonly string[] }[]>
}

/**
 * The checks the card can make at render time, in the order `resolveWait`
 * makes them under the decision lock — so a form is only drawn for a
 * conflict that is still the one the wait recorded. Rows come from the
 * mirror's own count, never from triage, which is only laid over them.
 */
export async function conflictWorkOf(input: {
  proposal: { baseSha: string; headSha: string }
  saved: { head: string; ref: string } | { refusal: string }
  runEvents: readonly { type: string; data: unknown }[]
  status: TriageStatus | null
  ports: ConflictWorkPorts | { refusal: string }
}): Promise<ConflictWork> {
  const { proposal, saved, ports } = input
  if ('refusal' in saved) return saved
  if ('refusal' in ports) return { refusal: `The conflict could not be checked: ${ports.refusal}` }
  if (saved.head !== proposal.headSha)
    return {
      refusal: `The head moved: the saved work is ${saved.head.slice(0, 7)} on ${saved.ref}, not the ${proposal.headSha.slice(0, 7)} this conflict was recorded against. Start over from base.`,
    }
  try {
    const remote = await ports.client.refSha(`heads/${saved.ref}`)
    if (remote === null)
      return {
        refusal: `The preserved ref ${saved.ref} is missing. Restore it at ${saved.head.slice(0, 7)} or start over from base.`,
      }
    if (remote !== saved.head)
      return {
        refusal: `The preserved ref ${saved.ref} moved to ${remote.slice(0, 7)}, not the saved ${saved.head.slice(0, 7)}. Restore it or start over from base.`,
      }
    const base = await ports.client.refSha(`heads/${ports.base}`)
    if (base !== proposal.baseSha)
      return {
        refusal: `The base moved since this conflict was recorded (${ports.base} is ${base?.slice(0, 7) ?? 'missing'}, not ${proposal.baseSha.slice(0, 7)}); a confirmation against it is refused. Start over from base.`,
      }
  } catch (err) {
    return { refusal: `The remote could not be checked: ${(err as Error).message}` }
  }
  let counted: { path: string; line: number; text: string }[]
  try {
    const paths = await ports.conflicts(proposal.baseSha, proposal.headSha)
    counted = paths.flatMap((p) => p.hunkLines.map((line, i) => ({ path: p.path, line, text: p.hunkTexts?.[i] ?? '' })))
  } catch (err) {
    return { refusal: `The mirror could not count the conflict's hunks: ${(err as Error).message}` }
  }
  const where = { baseSha: proposal.baseSha, headSha: proposal.headSha, ref: saved.ref, baseBranch: ports.base }
  const built = conflictRows(counted, input.status)
  if ('tooMany' in built) return { ...where, tooMany: built.tooMany }
  const text = new Map(counted.map((c) => [`${c.path}:${c.line}`, c.text]))
  return {
    ...where,
    paths: [...new Set(counted.map((c) => c.path))],
    rows: built.rows.map((row) => ({ ...row, text: text.get(`${row.path}:${row.line}`) ?? '' })),
    roundsExhausted: conflictRoundsExhausted(input.runEvents, proposal.headSha),
  }
}
