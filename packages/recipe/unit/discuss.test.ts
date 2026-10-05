/**
 * `discuss:` — the top-level node beside `steps:` and `subscribers:` (0061 §6,
 * `#243`) — parsed, defaulted, hashed, and refused where it is not a plugin.
 */
import { describe, expect, it } from 'vitest'

import { DISCUSS_DEFAULTS, RECIPE_PATH, hashRecipe, resolveRecipe } from '../src/index.ts'

const BASE = `
version: 2
repo:
  base: develop
  submodules: true
source:
  kinds: [bug, feature]
env:
  plantAt: apps/web/.env.local
runtime:
  agent: claude-code
`

const reader = (files: Record<string, string>) => async (path: string, ref: string) => files[`${ref}:${path}`] ?? null

async function resolve(text: string) {
  return resolveRecipe(reader({ [`develop:${RECIPE_PATH}`]: text }), 'develop')
}

describe('discuss:, absent', () => {
  it('resolves to the stated defaults, readable rather than missing', async () => {
    const { recipe } = await resolve(BASE)
    expect(recipe.discuss).toEqual(DISCUSS_DEFAULTS)
    expect(recipe.discuss).toEqual({ agent: 'claude-code', limits: { turns: 40, wall: '5m' } })
  })
})

describe('discuss:, written', () => {
  it('takes an agent, a model, a prompt and limits', async () => {
    const { recipe } = await resolve(
      `${BASE}discuss:\n  agent: claude-code\n  model: haiku\n  prompt: Be terse.\n  limits: { turns: 7, wall: 90s }\n`,
    )
    expect(recipe.discuss).toEqual({
      agent: 'claude-code',
      model: 'haiku',
      prompt: 'Be terse.',
      limits: { turns: 7, wall: '90s' },
    })
  })

  it('refuses a list, by name — one object, not several answerers', async () => {
    await expect(resolve(`${BASE}discuss:\n  - agent: claude-code\n`)).rejects.toThrow(/discuss/)
  })

  it('refuses a runtime that cannot be given no tools, by name, at resolve', async () => {
    await expect(resolve(`${BASE}discuss:\n  agent: codex\n`)).rejects.toThrow(/discuss\.agent/)
  })

  it('refuses an unrecognized field, by name', async () => {
    await expect(resolve(`${BASE}discuss:\n  agent: claude-code\n  rounds: 3\n`)).rejects.toThrow(/rounds/)
  })
})

describe('discuss:, written at a step', () => {
  it('is refused as a step name, by name', async () => {
    await expect(resolve(`${BASE}steps:\n  discuss:\n    - name: x\n      run: 'true'\n`)).rejects.toThrow(/discuss/)
  })

  it("is refused as an action, naming 0061 §6 rather than 'names no plugin'", async () => {
    await expect(resolve(`${BASE}steps:\n  proposed:\n    - name: x\n      discuss: true\n`)).rejects.toThrow(
      /top-level node beside .steps:. and .subscribers:./,
    )
  })
})

describe('discuss:, inside configHash', () => {
  it('changes the hash when it changes, with no second hashing path', async () => {
    const plain = await resolve(BASE)
    const narrowed = await resolve(`${BASE}discuss:\n  limits: { turns: 7 }\n`)
    expect(hashRecipe(narrowed.recipe)).not.toBe(hashRecipe(plain.recipe))
    // And the resolve's own hash agrees with hashing the resolved form directly.
    expect(narrowed.configHash).toBe(hashRecipe(narrowed.recipe))
  })
})
