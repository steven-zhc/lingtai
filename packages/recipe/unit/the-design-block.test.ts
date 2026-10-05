/**
 * **The `design:` block this repository intends to declare, resolved** (`#302`,
 * T6 of `#295`).
 *
 * `#302`'s *Watch out* is the whole reason this file exists: a recipe change on a
 * live queue that the schema refuses costs one claim, one worktree and one paid
 * agent, and then a person answering a refusal a schema line could have printed
 * (0066 §6, as corrected by `#299`). The block a person is told to paste is
 * therefore not prose here — it is read out of
 * `doc/experiments/015-does-a-design-make-the-implementing-run-smaller.md`,
 * spliced into this repository's own recipe and put through the real
 * `resolveSource`.
 *
 * **The document is the block and this is not a copy of it**, which is
 * `tamper-watch.test.ts`'s arrangement for the same reason: there is nowhere else
 * for the block to be taken out of, so an edit to the document is an edit to what
 * this test judges and there is no second copy to drift from.
 *
 * What it cannot assert is that the *machine's* file resolves — that file is
 * outside every worktree (0046 §3) and carries `build:` and `review:` blocks the
 * repository's copy does not. Nor is this the read the daemon does: that is
 * `resolveLocalRecipe`, which hands `resolveSource` a fourth argument refusing
 * `runtime.*` by name and injecting the machine's own (`src/local.ts:398`). The
 * block declares no `runtime:` key, which is what leaves nothing between the two.
 * What it does assert is the block itself, in a valid recipe: the fields, their
 * order, and the plugin's own `at`.
 */
import { readFileSync } from 'node:fs'

import { RECIPE_PATH, resolveSource } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

const root = new URL('../../../', import.meta.url)
const EXPERIMENT = 'doc/experiments/015-does-a-design-make-the-implementing-run-smaller.md'

/**
 * The block as the experiment publishes it — sliced from `  design:` so the
 * commented heading above it in the document is not spliced into YAML, and
 * indented to sit directly under `steps:`.
 */
function documented(): string {
  const md = readFileSync(new URL(EXPERIMENT, root), 'utf8')
  const fence = md.match(/```yaml\n([\s\S]*?)```/)
  if (fence === null) throw new Error(`${EXPERIMENT} has no yaml block — the block has no home`)
  const at = fence[1]!.indexOf('  design:')
  if (at === -1) throw new Error(`${EXPERIMENT}'s first yaml block does not declare \`design:\``)
  return fence[1]!.slice(at)
}

/** The documented block, in this repository's own recipe, resolved by the real schema. */
function resolved() {
  const live = readFileSync(new URL(RECIPE_PATH, root), 'utf8')
  const spliced = live.replace(/^steps:\n/m, `steps:\n${documented()}`)
  if (spliced === live) throw new Error(`${RECIPE_PATH} has no \`steps:\` to splice into`)
  return resolveSource(spliced, 'main', EXPERIMENT).recipe
}

describe('the `design:` block 015 publishes', () => {
  /**
   * **It resolves**, which is the claim the live queue would otherwise test. A
   * plugin declared at a step it does not serve, a field it does not understand,
   * a path that leaves the worktree — all of them are refused when the recipe
   * resolves, and all of them fail here instead.
   */
  it("resolves in this repository's own recipe", () => {
    expect(resolved().steps.design).toHaveLength(2)
  })

  /**
   * **The drafter first and the keep second, because that order is the
   * contract.** `file:` keeps what an earlier entry at the same step made, so one
   * written first would pass having written no file and returned no locator —
   * refused by `filePlugin`, and the reason the document's block cannot be
   * reordered by somebody tidying it.
   */
  it('drafts before it keeps, and names the runtime the conductor runs', () => {
    const [drafter, keep] = resolved().steps.design
    expect(drafter).toMatchObject({ agent: 'claude-code' })
    expect('file' in drafter!).toBe(false)
    expect(keep).toMatchObject({ file: expect.stringContaining('doc/design/') })
  })

  /**
   * **`prompt:` carries the project's half and not the step's.** What is written
   * in the recipe arrives as a trailing `## Also for this project` section of
   * `buildDesignPrompt`, so a block that restated *answering with nothing is a
   * real answer* or *do not edit the worktree* would pay for the built-in twice
   * in one context window. Pinned as *it says something, and it does not say the
   * built-in's sentences*.
   */
  it('gives the drafter a project prompt that does not restate the built-in', () => {
    const [drafter] = resolved().steps.design
    const prompt = (drafter as { prompt?: string }).prompt ?? ''
    expect(prompt.length).toBeGreaterThan(0)
    expect(prompt).toContain('file.ts:line')
    expect(prompt).not.toContain('Reply with the document and nothing else')
    expect(prompt).not.toContain('Do not change it')
  })

  /**
   * **The published block declares `design` and no other step**, which is the
   * half of §1's rule a test can hold. The measurement has one moving part only
   * while `design:` is the only block that changes, and the machine's file is
   * outside every worktree (0046 §3) — so what is checkable here is the block a
   * person is told to paste: a `file-brief:` at `implement` added to the
   * document's fence, with the explicit `agent:` it would force beside it, fails
   * this.
   *
   * **Asserting `steps.implement` on the spliced recipe would assert nothing.**
   * `.lingtai/config.yaml` never mentions `implement` and the block is sliced
   * from `  design:`, so it can only ever declare `design` — that expectation is
   * green before the document is read, which is why it is this one instead.
   */
  it('publishes a block that declares `design` and no other step', () => {
    const block = parseYaml(`steps:\n${documented()}`) as { steps: Record<string, unknown> }
    expect(Object.keys(block.steps)).toEqual(['design'])
  })

  /**
   * **§4's queries name the drafter, and this is what holds the two together.**
   * `StepPassed` is one row per action (`packages/actions/src/action.ts:722`) and
   * `stepBase.step` is the step rather than the action, so the two-entry block
   * leaves two rows at `design`: a query that names only the step returns every
   * designed run twice and double-weights the whole *with* arm. Both queries
   * therefore join on `d.data->>'action' = '…'`, and renaming the entry above
   * without renaming it there would silently restore the double count — and
   * `StepPassed` carries no other discriminator, since zod strips the `document`
   * key (`packages/domain/src/events.ts:812`).
   */
  it("names the drafter in every query that reads the drafter's row", () => {
    const [drafter] = resolved().steps.design
    const md = readFileSync(new URL(EXPERIMENT, root), 'utf8')
    const named = [...md.matchAll(/data->>'action' = '([^']*)'/g)].map((m) => m[1])
    expect(named.length).toBeGreaterThan(0)
    expect(new Set(named)).toEqual(new Set([drafter!.name]))
  })
})
