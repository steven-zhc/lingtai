import { inWords } from '@lingtai/conductor/queue'

/**
 * How long a ticket took: first claim to the end instant, in words. Null when
 * either is missing or the pair is reversed, so a page draws no `took` rather
 * than `0m`. One helper for the task page and `/landed`, so the two cannot word
 * one duration two ways.
 */
export function tookText(start: string | null | undefined, end: string | null | undefined): string | null {
  if (start == null || end == null) return null
  const ms = Date.parse(end) - Date.parse(start)
  return Number.isFinite(ms) && ms >= 0 ? inWords(ms) : null
}

const day = (iso: string) => iso.slice(0, 10)
const clock = (iso: string) => iso.slice(11, 16)

/**
 * The facts line's named times: `claimed 05:03`, `landed 05:12 on lingtai-base`.
 * UTC `HH:MM`, as the bar's coordinates print it. The date goes before the first
 * time whose UTC day differs from the next time's day. A closed ticket that had
 * landed keeps no landing time (the reducer holds none), so it reads
 * `closed HH:MM · landed on <base>`.
 */
export function namedTimes(input: {
  firstClaimAt: string | null
  state: string
  since: string | null
  landedBase?: string | null
}): string[] {
  const { firstClaimAt, state, since, landedBase } = input
  const times: { word: string; at: string }[] = []
  if (firstClaimAt !== null) times.push({ word: 'claimed', at: firstClaimAt })
  if (since !== null) times.push({ word: state, at: since })
  const out = times.map((t, i) => {
    const next = times[i + 1]
    const date = next !== undefined && day(t.at) !== day(next.at) ? `${day(t.at)} ` : ''
    return `${t.word} ${date}${clock(t.at)}`
  })
  if (landedBase != null && landedBase !== '') {
    if (state === 'landed' && out.length > 0) out[out.length - 1] += ` on ${landedBase}`
    else out.push(`landed on ${landedBase}`)
  }
  return out
}
