export type MirrorHead = { at: string } | { missing: true } | { unreadable: string }

/** The mirror is only as fresh as the conductor's last fetch. */
export function triageHeadLine(headSha: string, mirror: MirrorHead): string | null {
  if ('at' in mirror) {
    return mirror.at === headSha
      ? null
      : `Triage read ${headSha.slice(0, 7)}; mirror head, as of its last fetch: ${mirror.at.slice(0, 7)}.`
  }
  if ('missing' in mirror) return 'The branch is no longer in the mirror.'
  return `Could not read the mirror: ${mirror.unreadable}`
}
