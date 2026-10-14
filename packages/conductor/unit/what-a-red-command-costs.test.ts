/**
 * `doc/plugins/run.md`'s cost table, against the offer it describes.
 *
 * The page tells a person which of the five steps to write a command at by what
 * a red one costs there, so the column *is* the advice — and the first version
 * of it had `prepared` buying a fix round, where `nextOf` answers its own
 * refusal with a `Propose{SetupRefused}` whose offer never carries `implement`
 * (`prepared` is not born at or after `implement`, `#472`) — and the pass is
 * held for a person with nothing bought. A reader who believed it moved a
 * precondition check there and paid a person for it. Nothing derived the
 * column, which is the failure `packages/recipe/unit/plugin-pages.test.ts`
 * names about a hand-kept table.
 *
 * **The implication is one-way, and that is deliberate.** A row may say *no
 * round bought* for a reason `offerFor` knows nothing about: `merge` affords
 * `implement` and buys nothing all the same, because an `action-refused` there
 * is not a direction any `judge:` answers (`checkRefused`, `pass-next.ts`).
 * What this refuses is the other direction — a row promising a round at a step
 * the offer has nothing to give — which is the one that costs money.
 *
 * Beside the code rather than beside the page, for the reason
 * `packages/actions/unit/tamper-watch.test.ts` reads `doc/tamper-watch.md`: the
 * document is what the code is judged against, and the judgement belongs where
 * the code is.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { nextOf, offerFor, type Proposal, type Step, type StepOutcome } from '@lingtai/domain'
import { runPlugin } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'

import { destinationOf } from '../src/proposed-route.ts'

/**
 * A `run:` action's own refusal, as `nextOf` reads it — a `verdict`-yielding
 * action whose assessment is `refused` (0120 §1's *Cleared when* table).
 */
function refusedRun(step: Step, name: string): StepOutcome {
  return {
    step,
    round: 0,
    actions: [
      {
        plugin: 'run',
        name,
        onSha: 'a'.repeat(40),
        call: null,
        evidence: '…',
        yields: 'verdict',
        result: { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } },
      },
    ],
  }
}

/**
 * **Asks `nextOf` rather than a hand-kept list** — the failure
 * `packages/recipe/unit/plugin-pages.test.ts` names about this file's own
 * header, which a literal duplicating `nextOf`'s own table would commit
 * again. The set `onOffer`/`AFTER_AN_AGENT` once named is `offerFor`'s
 * `Candidate`s now, built from `nextOf`'s own `Propose` cell rather than
 * copied beside it.
 */
function proposalOnRefusal(step: Step): Proposal | null {
  const next = nextOf(refusedRun(step, 'check'), { runId: 'r' })
  return next._tag === 'Propose' ? next.proposal : null
}

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
   * promises one is a claim about two things: that the refusal reaches a
   * judge at all (`proposalOnRefusal`, above, asking `nextOf` rather than a
   * list kept beside it), and that `implement` is a candidate's destination
   * once `offerFor` has built the offer from it. Since `#472` every refusal
   * reaches `nextOf` as a `Propose`, so what tells the five apart is the
   * second claim alone: `prepared`'s own `SetupRefused` and
   * `proposed`/`merge`'s own `CheckRefused` both offer `implement` only when
   * `offerFor`'s `bornAtOrAfterImplement` is true, and `prepared` and the two
   * checks are not.
   */
  it('promises a fix round only where the refusal reaches a judge that can give one', () => {
    for (const row of costTable().filter((each) => each.bought)) {
      const step = row.step as Step
      const proposal = proposalOnRefusal(step)
      expect(proposal, `a red \`run:\` at \`${step}\` never reaches a judge`).not.toBeNull()
      const offer = offerFor(proposal!, { rounds: 2, restarts: 1 }, { rounds: 0, restarts: 0 })
      expect(
        offer.available.some((candidate) => destinationOf(candidate, proposal!) === 'implement'),
        `\`${step}\` is promised a fix round, and the offer there has no \`implement\` on it`,
      ).toBe(true)
    }
  })

  /**
   * And the steps the page says buy nothing by default are the steps nothing
   * built in *could*: `prepared`'s own `SetupRefused` never offers
   * `implement` at all (`offerFor`'s `bornAtOrAfterImplement`, `#472`), and
   * `proposed`/`merge`'s own `CheckRefused` offers it unconditionally but no
   * built-in judge ever selects it (`BUILT_IN_FOR['check-refused'] ===
   * null`) — so without a recipe declaring one, none of the three buys a
   * round. `implement` is excluded here — `nextOf` throws `a verdict refusal
   * cannot happen at implement` (0120 §1's legality table: its `run:` yields
   * `commit`, never `verdict`) — and proved instead by the doc's own row
   * below, which the `## Where it may be declared` table is parsed against.
   */
  it('says no round is bought by default where no ceiling would have bought one', () => {
    for (const step of ['prepared', 'proposed', 'merge'] as const) {
      expect(
        proposalOnRefusal(step),
        `a red \`run:\` at \`${step}\` never reaches \`nextOf\` as a \`Propose\``,
      ).not.toBeNull()
    }
    const prepared = proposalOnRefusal('prepared')!
    const offer = offerFor(prepared, { rounds: 2, restarts: 1 }, { rounds: 0, restarts: 0 })
    expect(
      offer.available.some((candidate) => destinationOf(candidate, prepared) === 'implement'),
      '`prepared` is promised no round, and the offer there should have no `implement` on it',
    ).toBe(false)
    expect(
      costTable()
        .filter((row) => !row.bought)
        .map((row) => row.step),
    ).toEqual(['prepared', 'implement', 'proposed', 'merge'])
  })
})
