/**
 * `limitsRow` and `turns: unbounded` (#547): a choice is not checked, a
 * promise is, and a number on a runtime that cannot hold it stays red.
 */
import { CLAUDE_CODE_CAPABILITIES, CODEX_CAPABILITIES } from '@lingtai/agent'
import { Recipe } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'

import { limitsRow } from '../src/doctor.ts'

const recipe = (agent: string, limits: Record<string, unknown>, steps?: unknown) =>
  Recipe.parse({
    version: 2,
    repo: { base: 'main' },
    source: { kinds: ['bug'] },
    env: { plantAt: '.env.local' },
    runtime: { agent, limits },
    ...(steps === undefined ? {} : { steps }),
  })

describe('limitsRow', () => {
  it('passes codex with turns unbounded and no usd', () => {
    const row = limitsRow('app', recipe('codex', { turns: 'unbounded' }), CODEX_CAPABILITIES)
    expect(row.status).toBe('ok')
    expect(row.detail).toContain('turns — unbounded')
    expect(row.detail).toContain('wall 2h ← applied by codex')
  })

  it('fails codex on a number, and names unbounded as a way out', () => {
    const row = limitsRow('app', recipe('codex', { turns: 300 }), CODEX_CAPABILITIES)
    expect(row.status).toBe('fail')
    expect(row.detail).toContain('turns: unbounded')
  })

  it('fails codex when a step promises turns the unbounded ceiling hides', () => {
    const steps = { implement: [{ name: 'write', agent: 'codex', prompt: 'go', limits: { turns: 50 } }] }
    const row = limitsRow('app', recipe('codex', { turns: 'unbounded' }, steps), CODEX_CAPABILITIES)
    expect(row.status).toBe('fail')
  })

  it('still fails codex with a usd ceiling', () => {
    const row = limitsRow('app', recipe('codex', { turns: 'unbounded', usd: 5 }), CODEX_CAPABILITIES)
    expect(row.status).toBe('fail')
    expect(row.detail).toContain('usd')
  })

  it('passes claude-code on its enforced number', () => {
    expect(limitsRow('app', recipe('claude-code', { turns: 300 }), CLAUDE_CODE_CAPABILITIES).status).toBe('ok')
  })
})
