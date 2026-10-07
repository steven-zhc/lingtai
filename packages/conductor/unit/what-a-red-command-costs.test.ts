/**
 * `doc/plugins/run.md`'s cost table, against the offer it describes.
 *
 * The page tells a person which of the five steps to write a command at by what
 * a red one costs there, so the column *is* the advice — and the first version
 * of it had `prepared` buying a fix round, where `AFTER_AN_AGENT` leaves that
 * step off the offer and the pass is held for a person with nothing bought. A
 * reader who believed it moved a precondition check there and paid a person for
 * it. Nothing derived the column, which is the failure
 * `packages/recipe/unit/plugin-pages.test.ts` names about a hand-kept table.
 *
 * **The implication is one-way, and that is deliberate.** A row may say *no
 * round bought* for a reason `onOffer` knows nothing about: `merge` affords
 * `implement` and buys nothing all the same, because an `action-refused` there
 * is not a direction any `judge:` answers (`directionOf`, whose cells are
 * `pass-steps.test.ts`'s). What this refuses is the other direction — a row
 * promising a round at a step the offer has nothing to give — which is the one
 * that costs money.
 *
 * Beside the code rather than beside the page, for the reason
 * `packages/actions/unit/tamper-watch.test.ts` reads `doc/tamper-watch.md`: the
 * document is what the code is judged against, and the judgement belongs where
 * the code is.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { runPlugin } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'

import { ARRIVE_AT_THE_ROUTER, onOffer, type Ceilings, type StepEnding } from '../src/pass.ts'

const page = readFileSync(fileURLToPath(new URL('../../../doc/plugins/run.md', import.meta.url)), 'utf8')

/** Everything a row claims: the step, and whether a red command there buys a round. */
interface Row {
  step: string
  bought: boolean
}

/**
 * The table under `## Where it may be declared`, parsed rather than counted.
 *
 * Only that section, and only its one table: the page has other tables — the
 * parameters are one — and a parser that swept the file would judge whatever the
 * next edit adds.
 */
function costTable(): Row[] {
  const section = page.split(/^## /m).find((part) => part.startsWith('Where it may be declared'))
  if (section === undefined) throw new Error('doc/plugins/run.md has no `## Where it may be declared` section')

  const rows: Row[] = []
  for (const line of section.split('\n')) {
    if (!line.startsWith('| `')) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    const step = /^`([^`]+)`$/.exec(cells[0] ?? '')?.[1]
    if (step === undefined) continue
    const says = cells[1] ?? ''
    const bought = /\*\*A fix round\b/.test(says)
    if (!bought && !/\*\*No round bought\b/.test(says)) {
      throw new Error(`the \`${step}\` row says neither "A fix round" nor "No round bought"`)
    }
    rows.push({ step, bought })
  }
  return rows
}

describe('the run page says what a red command costs at each step it may be written at', () => {
  /** One row per step `runPlugin` serves, in the order it declares them. */
  it('has a row for each of the five, and for nothing else', () => {
    expect(costTable().map((row) => row.step)).toEqual([...runPlugin.serves])
  })

  /**
   * A refusal buys a round by being routed back into the spine, so a row that
   * promises one is a claim about two things: that the refusal reaches the
   * router at all (`ARRIVE_AT_THE_ROUTER`), and that `implement` is on the offer
   * when it gets there (`AFTER_AN_AGENT`, through `onOffer`). `prepared` fails
   * the second and `proposed` the first.
   */
  it('promises a fix round only where the refusal reaches a judge that can give one', () => {
    const spare: Ceilings = { rounds: 2, restartsLeft: 1 }
    const refused: StepEnding = { ending: 'refused', because: 'action-refused', at: 'check', detail: '…' }

    for (const row of costTable().filter((each) => each.bought)) {
      const step = row.step as (typeof ARRIVE_AT_THE_ROUTER)[number]
      expect(ARRIVE_AT_THE_ROUTER, `a red \`run:\` at \`${step}\` never reaches the router`).toContain(step)
      expect(
        onOffer(step, refused, spare, 0).affordable,
        `\`${step}\` is promised a fix round, and the offer there has no \`implement\` on it`,
      ).toContain('implement')
    }
  })

  /**
   * And the two the page says buy nothing are the two nothing *could*: `prepared`
   * is off `reachable` as well as `affordable`, so it is not a number somebody
   * can raise, and `proposed` does not arrive at all.
   */
  it('says no round is bought where no ceiling would have bought one', () => {
    const spare: Ceilings = { rounds: 9, restartsLeft: 9 }
    const refused: StepEnding = { ending: 'refused', because: 'action-refused', at: 'check', detail: '…' }

    expect(onOffer('prepared', refused, spare, 0).reachable).toEqual(['waiting'])
    expect(ARRIVE_AT_THE_ROUTER).not.toContain('proposed')
    expect(
      costTable()
        .filter((row) => !row.bought)
        .map((row) => row.step),
    ).toEqual(['prepared', 'implement', 'proposed', 'merge'])
  })
})
