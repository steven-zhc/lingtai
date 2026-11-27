import { elapsed } from '@/lib/progress'
import { NOTHING_BILLED, billHasAny, billText, totalBill } from '@/lib/spend'
import type { StandingState, Totals } from '@/lib/task'
import { tookText } from '@/lib/took'

import { Cell } from './cell.tsx'
import { Since } from './since'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The whole ticket's spend and time, under the title (#1494): Spent, Of which
 * answering, Took, Attempts. Drawn from `task.totals`, while it runs and after
 * it lands. A cell with nothing to say is left out, never drawn as `0`.
 */
export function TotalsStrip({
  totals,
  firstClaimAt,
  state,
  since,
  spend,
  now,
}: {
  totals: Totals
  firstClaimAt: string | null
  state: StandingState
  since: string | null
  spend: { current: boolean; label: string }
  now: number
}) {
  const total = totalBill(totals.byPurpose)
  const answering = totals.byPurpose.Answering
  const anySpend = billHasAny(total)
  if (totals.attempts === 0 && !anySpend) return null
  const estimated = Object.values(totals.byPurpose).reduce((n, b) => n + b.estimates.length, 0)
  const spentSub = [
    estimated > 0 ? `${plural(estimated, 'run')} estimated from tokens` : null,
    spend.current ? null : spend.label,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ')
  const agents = totals.durationMs > 0 ? `agents ran ${elapsed(totals.durationMs)}` : null
  const ended = state === 'landed' || state === 'closed' || state === 'satisfied'
  const took = ended ? tookText(firstClaimAt, since) : null
  const endWord = state === 'satisfied' ? 'satisfied' : state
  const attemptsSub = [
    totals.turns > 0 ? plural(totals.turns, 'turn') : null,
    totals.fixRounds > 0 ? plural(totals.fixRounds, 'fix round') : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ')
  return (
    <dl className="meters facts" data-totals="">
      {anySpend || totals.inFlight > 0 ? (
        <Cell name="Spent" cell="spent" sub={spentSub}>
          {anySpend ? billText(total) : NOTHING_BILLED}
        </Cell>
      ) : null}
      {billHasAny(answering) ? (
        <Cell name="Of which answering" cell="answering">
          <span style={{ color: 'var(--signal)' }}>{billText(answering)}</span>
        </Cell>
      ) : null}
      {firstClaimAt === null || (ended && took === null) ? null : (
        <Cell
          name="Took"
          cell="took"
          sub={
            ended
              ? [`claim → ${endWord}`, agents].filter((x) => x !== null).join(' · ')
              : ['since claim', agents].filter((x) => x !== null).join(' · ')
          }
        >
          {ended ? took : <Since iso={firstClaimAt} serverNow={now} />}
        </Cell>
      )}
      {totals.attempts > 0 ? (
        <Cell name="Attempts" cell="attempts" sub={attemptsSub}>
          {totals.attempts}
        </Cell>
      ) : null}
    </dl>
  )
}
