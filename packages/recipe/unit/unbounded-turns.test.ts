/**
 * `runtime.limits.turns: unbounded` (#547): the one spelling of *no turn
 * ceiling*, and the three that look like it and are refused.
 */
import { describe, expect, it } from 'vitest'

import { formatTurns, maxTurns, numericTurns } from '../src/duration.ts'
import { Recipe } from '../src/recipe.ts'
import { ceilingOf, declaresTurnsOn, limitsFor } from '../src/settings.ts'

const WITH = (runtime: unknown, steps: unknown = undefined) =>
  ({
    version: 2,
    repo: { base: 'main' },
    source: { kinds: ['bug'] },
    env: { plantAt: '.env.local' },
    runtime,
    ...(steps === undefined ? {} : { steps }),
  }) as unknown

describe('runtime.limits.turns', () => {
  it('parses unbounded, and leaves the default at 300', () => {
    expect(Recipe.parse(WITH({ limits: { turns: 'unbounded' } })).runtime.limits.turns).toBe('unbounded')
    expect(Recipe.parse(WITH({})).runtime.limits.turns).toBe(300)
  })

  it.each([null, 0, 'none', -1, 1.5])('refuses %s, naming the word that is accepted', (turns) => {
    const parsed = Recipe.safeParse(WITH({ limits: { turns } }))
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toContain('unbounded')
  })

  it("lets a step narrow an unbounded ceiling, and still refuses widening a number's", () => {
    const step = { implement: [{ name: 'write', agent: 'codex', prompt: 'go', limits: { turns: 50 } }] }
    const narrowed = Recipe.parse(WITH({ agent: 'codex', limits: { turns: 'unbounded' } }, step))
    expect(limitsFor(narrowed, 'implement').turns).toBe(50)
    expect(ceilingOf(narrowed).turns).toBe('unbounded')
    expect(Recipe.safeParse(WITH({ agent: 'codex', limits: { turns: 40 } }, step)).success).toBe(false)
  })

  it('knows which runtime a step-level turns count is promised on', () => {
    const step = { implement: [{ name: 'write', agent: 'codex', prompt: 'go', limits: { turns: 50 } }] }
    const recipe = Recipe.parse(WITH({ agent: 'codex', limits: { turns: 'unbounded' } }, step))
    expect(declaresTurnsOn(recipe, 'codex')).toBe(true)
    expect(declaresTurnsOn(recipe, 'claude-code')).toBe(false)
  })
})

describe('turn-limit helpers', () => {
  it('prints a count as it always did and unbounded with no number', () => {
    expect(formatTurns(150)).toBe('150 turns')
    expect(formatTurns('unbounded')).not.toMatch(/\d/)
  })

  it('orders unbounded above every count, and requests none for it', () => {
    expect(maxTurns(5, 'unbounded')).toBe('unbounded')
    expect(maxTurns(5, 9)).toBe(9)
    expect(numericTurns('unbounded')).toBeUndefined()
    expect(numericTurns(7)).toBe(7)
  })
})
