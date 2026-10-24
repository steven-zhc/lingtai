/**
 * `triage:` — the top-level node beside `discuss:` (0118 §3, `#411`) — parsed,
 * defaulted, hashed, and absent means nothing runs.
 */
import { describe, expect, it } from 'vitest'

import { RECIPE_PATH, canonicalRecipe, hashRecipe, resolveRecipe, triageCallFor } from '../src/index.ts'

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

describe('triage:, absent', () => {
  it('resolves to undefined, not a defaulted object', async () => {
    const { recipe } = await resolve(BASE)
    expect('triage' in recipe).toBe(false)
    expect(recipe.triage).toBeUndefined()
  })

  it('never reaches the canonical form that configHash hashes', async () => {
    const { recipe } = await resolve(BASE)
    expect('triage' in canonicalRecipe(recipe)).toBe(false)
  })
})

describe('triage:, written', () => {
  it('takes an agent, with the stated defaults underneath', async () => {
    const { recipe } = await resolve(`${BASE}triage:\n  agent: claude-code\n`)
    expect(recipe.triage).toEqual({
      agent: 'claude-code',
      limits: { turns: 40, wall: '5m', usd: 0.5 },
    })
  })

  it('takes a model, a prompt and limits', async () => {
    const { recipe } = await resolve(
      `${BASE}triage:\n  agent: claude-code\n  model: haiku\n  prompt: Be terse.\n  limits: { turns: 7, wall: 90s, usd: 1.25 }\n`,
    )
    expect(recipe.triage).toEqual({
      agent: 'claude-code',
      model: 'haiku',
      prompt: 'Be terse.',
      limits: { turns: 7, wall: '90s', usd: 1.25 },
    })
  })

  it('accepts Codex for the configured model-only route', async () => {
    const { recipe } = await resolve(`${BASE}triage:\n  agent: codex\n`)
    expect(recipe.triage?.agent).toBe('codex')
  })

  it('refuses an unknown triage agent by name at resolve', async () => {
    await expect(resolve(`${BASE}triage:\n  agent: unknown\n`)).rejects.toThrow(/triage\.agent/)
  })

  it('refuses an unrecognized field, by name', async () => {
    await expect(resolve(`${BASE}triage:\n  agent: claude-code\n  rounds: 3\n`)).rejects.toThrow(/rounds/)
  })

  it('accepts a wall of any positive length', async () => {
    const { recipe } = await resolve(`${BASE}triage:\n  limits: { wall: 15m }\n`)
    expect(recipe.triage?.limits.wall).toBe('15m')
  })

  it('refuses a wall that is not a positive duration', async () => {
    const refused = resolve(`${BASE}triage:\n  limits: { wall: 0m }\n`)
    await expect(refused).rejects.toThrow(/triage\.limits\.wall/)
    await expect(refused).rejects.toThrow(/positive duration/)
  })
})

describe('triage:, inside configHash', () => {
  it('changes the hash once declared, with no second hashing path', async () => {
    const plain = await resolve(BASE)
    const declared = await resolve(`${BASE}triage:\n  agent: claude-code\n`)
    expect(hashRecipe(declared.recipe)).not.toBe(hashRecipe(plain.recipe))
    expect(declared.configHash).toBe(hashRecipe(declared.recipe))
  })
})

describe('triageCallFor', () => {
  it('carries the dollar ceiling through, unlike callFor', async () => {
    const { recipe } = await resolve(`${BASE}triage:\n  model: haiku\n  limits: { turns: 10, wall: 2m, usd: 0.75 }\n`)
    expect(recipe.triage).toBeDefined()
    expect(triageCallFor(recipe.triage!)).toEqual({ model: 'haiku', turns: 10, wallMs: 120_000, usd: 0.75 })
  })
})
