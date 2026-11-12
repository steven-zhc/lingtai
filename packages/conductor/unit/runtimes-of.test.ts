import { describe, expect, it } from 'vitest'

import { runtimesOf } from '../src/runtimes-of.ts'

const recipe = (agent: string, steps: Record<string, unknown[]>) =>
  ({ runtime: { agent }, steps }) as unknown as Parameters<typeof runtimesOf>[0]

describe('runtimesOf', () => {
  it('lists runtime.agent, then step agents and non-built-in judges in recipe order, without duplicates', () => {
    expect(
      runtimesOf(
        recipe('claude-code', {
          build: [{ run: 'pnpm test' }, { agent: 'codex' }],
          review: [{ agent: 'claude-code' }],
          proposed: [{ judge: 'codex' }],
        }),
      ),
    ).toEqual(['claude-code', 'codex'])
  })

  it('puts the steps first-seen order after runtime.agent', () => {
    expect(runtimesOf(recipe('codex', { build: [{ agent: 'claude-code' }] }))).toEqual(['codex', 'claude-code'])
  })

  it('never lists a built-in judge, or discuss.agent and triage.agent', () => {
    const r = {
      runtime: { agent: 'codex' },
      steps: { findings: [{ judge: 'same-worktree' }] },
      discuss: { agent: 'claude-code' },
      triage: { agent: 'claude-code' },
    } as unknown as Parameters<typeof runtimesOf>[0]
    expect(runtimesOf(r)).toEqual(['codex'])
  })
})
