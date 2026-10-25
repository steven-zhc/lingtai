/**
 * The recipe reading's triage row names the route a hold is triaged by (#568):
 * the Codex CLI with tools, the model-only API, or another runtime. Readiness
 * is doctor's — a board render spawns nothing.
 */
import { Recipe } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'

import { readRecipe } from '../src/lib/recipe.ts'

const BASE = {
  version: 2,
  repo: { base: 'main', submodules: false },
  source: { kinds: ['bug'], exclude: [] },
  env: { required: [], plantAt: '.env.local' },
  runtime: { agent: 'claude-code' },
  steps: {},
}

function triageRow(triage: Record<string, unknown>) {
  const row = readRecipe(Recipe.parse({ ...BASE, triage })).find((r) => r.name === 'triage')
  if (!row) throw new Error('no triage row')
  return row
}

describe('readRecipe, the triage row', () => {
  it('says the CLI route and which limits bind for codex with tools: full', () => {
    const row = triageRow({ agent: 'codex', tools: 'full' })
    expect(row.says).toContain('Codex CLI with tools, in a disposable checkout')
    expect(row.says).toContain('not enforced')
    expect(row.keys).toContain('triage.tools')
  })

  it('says model-only and separately billed for codex without tools', () => {
    const row = triageRow({ agent: 'codex' })
    expect(row.says).toContain('model-only API, separately billed')
    expect(row.keys).toContain('triage.tools')
  })

  it('leaves claude-code as it was', () => {
    const row = triageRow({ agent: 'claude-code' })
    expect(row.says).toMatch(/^claude-code, /)
    expect(row.says).not.toContain('Codex')
  })
})
