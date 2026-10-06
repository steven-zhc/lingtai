/**
 * `createKeptRunAction` against a fake inner action and a fake port — `#390`.
 *
 * `implement` is not one of `REFUSING_STEPS` (`packages/conductor/src/pass.ts`),
 * so the command's own exit code is never turned into a `failed` verdict here:
 * a failing command is a reason to restore and say so, never a reason to
 * refuse. What *does* still answer `failed` is the port's own git plumbing —
 * an unreadable baseline, or a restore that could not finish — because that is
 * not a judgement about the diff, it is the step having no safe tree to leave
 * `build` with.
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
    async baseline() {
      calls.push('baseline')
      return { paths: new Set() }
    },
    async keep() {
      calls.push('keep')
      return answer
    },
    async restore() {
      calls.push('restore')
      return { ok: true }
    },
  }
}

describe('a run at implement never turns the command’s own exit code into failed', () => {
  it('commits what changed, and carries the new head', async () => {
    const deps = port({ committed: 'c'.repeat(40) })
    const action = createKeptRunAction('format', inner({ verdict: 'passed', evidence: 'pnpm fmt', findings: [] }), deps)

    const result = await action.run(context)

    expect(result).toMatchObject({ verdict: 'passed', head: 'c'.repeat(40) })
    expect(result.evidence).toContain('pnpm fmt')
    // `baseline` is read before the command runs, never after.
    expect(deps.calls).toEqual(['baseline', 'keep'])
  })

  it('passes with no head when there was nothing to commit', async () => {
    const deps = port({ clean: true })
    const action = createKeptRunAction('format', inner({ verdict: 'passed', evidence: 'pnpm fmt', findings: [] }), deps)

    const result = await action.run(context)

    expect(result.verdict).toBe('passed')
    expect(result).not.toHaveProperty('head')
    expect(deps.calls).toEqual(['baseline', 'keep'])
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
    expect(deps.calls).toEqual(['baseline', 'restore'])
  })

  it('restores and passes when the commit itself is refused', async () => {
    const deps = port({ notKept: 'git commit refused it: nothing is staged' })
    const action = createKeptRunAction('format', inner({ verdict: 'passed', evidence: 'pnpm fmt', findings: [] }), deps)

    const result = await action.run(context)

    expect(result.verdict).toBe('passed')
    expect(result).not.toHaveProperty('head')
    expect(result.evidence).toContain('git commit refused it')
    expect(deps.calls).toEqual(['baseline', 'keep', 'restore'])
  })
})

describe('the port’s own git plumbing failing is answered as `failed`, not swallowed into a pass', () => {
  it('refuses by name, running neither the command nor keep or restore, when baseline is unreadable', async () => {
    const calls: string[] = []
    const deps: KeptRunActionDeps = {
      async baseline() {
        calls.push('baseline')
        return { unreadable: 'not a git repository' }
      },
      async keep() {
        calls.push('keep')
        return { clean: true }
      },
      async restore() {
        calls.push('restore')
        return { ok: true }
      },
    }
    const action = createKeptRunAction('format', inner({ verdict: 'passed', evidence: 'pnpm fmt', findings: [] }), deps)

    const result = await action.run(context)

    expect(result.verdict).toBe('failed')
    expect(result.evidence).toContain('not a git repository')
    expect(result).not.toHaveProperty('head')
    // Neither `keep` nor `restore` is safe without a baseline — running
    // either risks sweeping an agent's leftovers into the commit, or
    // deleting them.
    expect(calls).toEqual(['baseline'])
  })

  it('answers `failed` when the commit was refused and the restore after it also could not finish', async () => {
    const calls: string[] = []
    const deps: KeptRunActionDeps = {
      async baseline() {
        return { paths: new Set() }
      },
      async keep() {
        calls.push('keep')
        return { notKept: 'git commit refused it: nothing is staged' }
      },
      async restore() {
        calls.push('restore')
        return { failed: 'git restore refused it: index.lock exists' }
      },
    }
    const action = createKeptRunAction('format', inner({ verdict: 'passed', evidence: 'pnpm fmt', findings: [] }), deps)

    const result = await action.run(context)

    expect(result.verdict).toBe('failed')
    expect(result.evidence).toContain('git commit refused it')
    expect(result.evidence).toContain('index.lock exists')
    expect(calls).toEqual(['keep', 'restore'])
  })

  it('answers `failed` when the command failed and the restore after it could not finish', async () => {
    const deps: KeptRunActionDeps = {
      async baseline() {
        return { paths: new Set() }
      },
      async keep() {
        throw new Error('must not be called — the command failed, so there is nothing to commit')
      },
      async restore() {
        return { failed: 'git restore refused it: index.lock exists' }
      },
    }
    const action = createKeptRunAction(
      'format',
      inner({ verdict: 'failed', evidence: 'pnpm fmt exited 1', findings: [] }),
      deps,
    )

    const result = await action.run(context)

    expect(result.verdict).toBe('failed')
    expect(result.evidence).toContain('pnpm fmt exited 1')
    expect(result.evidence).toContain('index.lock exists')
  })
})
