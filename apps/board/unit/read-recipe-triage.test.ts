/**
 * The recipe reading's triage row names the route a hold is triaged by (#568):
 * the Codex CLI with tools, the model-only API, or another runtime. Readiness
 * is said beside it, and only for the CLI route.
 */
import { Recipe } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'

import { readRecipe, withTriageReadiness } from '../src/lib/recipe.ts'

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

describe('withTriageReadiness', () => {
  const recipeOf = (triage: Record<string, unknown>) => Recipe.parse({ ...BASE, triage })
  const says = async (triage: Record<string, unknown>, login: () => Promise<{ loggedIn: boolean; detail: string }>) => {
    const recipe = recipeOf(triage)
    const rows = await withTriageReadiness(readRecipe(recipe), recipe, login)
    return rows.find((r) => r.name === 'triage')?.says ?? ''
  }

  it('says triage cannot run when the Codex CLI route has no login', async () => {
    const text = await says({ agent: 'codex', tools: 'full' }, async () => ({
      loggedIn: false,
      detail: 'Not logged in',
    }))
    expect(text).toContain('NOT READY')
    expect(text).toContain('triage cannot run')
  })

  it('says the login is ready when it is', async () => {
    const text = await says({ agent: 'codex', tools: 'full' }, async () => ({ loggedIn: true, detail: 'ChatGPT' }))
    expect(text).toContain('Codex login ready')
    expect(text).not.toContain('NOT READY')
  })

  it('treats a probe that throws as not ready', async () => {
    const text = await says({ agent: 'codex', tools: 'full' }, async () => {
      throw new Error('spawn codex ENOENT')
    })
    expect(text).toContain('NOT READY')
  })

  it('asks nothing for the other routes', async () => {
    let asked = 0
    const login = async () => {
      asked += 1
      return { loggedIn: true, detail: '' }
    }
    await says({ agent: 'codex' }, login)
    await says({ agent: 'claude-code' }, login)
    expect(asked).toBe(0)
  })
})
