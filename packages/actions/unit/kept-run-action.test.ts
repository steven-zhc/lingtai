/**
 * `createKeptRunAction` against a fake inner action and a fake port — `#390`.
 *
 * `implement` is not one of `REFUSING_STEPS` (`packages/conductor/src/pass.ts`),
 * so the one thing every case here has to show is that the wrapper never
 * reports `failed`: a failing command is a reason to restore and say so, never
 * a reason to refuse.
 */
import { describe, expect, it } from 'vitest'

import type { Action, ActionContext, ActionResult } from '../src/action.ts'
import { createKeptRunAction, type KeptRunActionDeps, type KeptRunAnswer } from '../src/kept-run-action.ts'

const context: ActionContext = { runId: 'run-1', onSha: 'a'.repeat(40), cwd: '/tmp/wt', env: {} }

function inner(result: ActionResult): Action {
  return { name: 'format', kind: 'run', run: async () => result }
}

function port(answer: KeptRunAnswer): KeptRunActionDeps & { readonly calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async keep() {
      calls.push('keep')
      return answer
    },
    async restore() {
      calls.push('restore')
    },
  }
}

describe('a run at implement never reports failed', () => {
  it('commits what changed, and carries the new head', async () => {
    const deps = port({ committed: 'c'.repeat(40) })
    const action = createKeptRunAction('format', inner({ verdict: 'passed', evidence: 'pnpm fmt', findings: [] }), deps)

    const result = await action.run(context)

    expect(result).toMatchObject({ verdict: 'passed', head: 'c'.repeat(40) })
    expect(result.evidence).toContain('pnpm fmt')
    expect(deps.calls).toEqual(['keep'])
  })

  it('passes with no head when there was nothing to commit', async () => {
    const deps = port({ clean: true })
    const action = createKeptRunAction('format', inner({ verdict: 'passed', evidence: 'pnpm fmt', findings: [] }), deps)

    const result = await action.run(context)

    expect(result.verdict).toBe('passed')
    expect(result).not.toHaveProperty('head')
    expect(deps.calls).toEqual(['keep'])
  })

  it('restores and passes, with the failure first, when the command fails', async () => {
    const deps = port({ committed: 'c'.repeat(40) })
    const action = createKeptRunAction(
      'format',
      inner({ verdict: 'failed', evidence: 'pnpm fmt exited 1', findings: [] }),
      deps,
    )

    const result = await action.run(context)

    expect(result.verdict).toBe('passed')
    expect(result).not.toHaveProperty('head')
    expect(result.evidence.startsWith('pnpm fmt exited 1')).toBe(true)
    // `restore` ran and `keep` never did — a failing command commits nothing.
    expect(deps.calls).toEqual(['restore'])
  })

  it('restores and passes when the commit itself is refused', async () => {
    const deps = port({ notKept: 'git commit refused it: nothing is staged' })
    const action = createKeptRunAction('format', inner({ verdict: 'passed', evidence: 'pnpm fmt', findings: [] }), deps)

    const result = await action.run(context)

    expect(result.verdict).toBe('passed')
    expect(result).not.toHaveProperty('head')
    expect(result.evidence).toContain('git commit refused it')
    expect(deps.calls).toEqual(['keep', 'restore'])
  })
})
