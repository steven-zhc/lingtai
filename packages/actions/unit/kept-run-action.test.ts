/**
 * `createKeptRunAction` against the table in `kept-run-action.ts`'s own
 * header — every row, against fakes rather than a real `git` (`#390`).
 *
 * The inner action is a fake `Action` and never `createProcessAction`'s: that
 * one spawns a real shell (`command.ts`), which is a process and so is
 * integration (0060 §1). Faking it here is what the ticket's own tests
 * section asks for — "the command runner is injectable" — and it means every
 * case below runs in milliseconds and touches no disk.
 */
import { describe, expect, it } from 'vitest'

import type { Action, ActionContext, ActionResult } from '../src/action.ts'
import { createKeptRunAction, type KeptRunActionDeps } from '../src/kept-run-action.ts'

const context: ActionContext = { runId: 'run-abc', onSha: 'a'.repeat(40), cwd: '/tmp/wt', env: {} }

function fakeInner(result: ActionResult): Action {
  return { name: 'format', kind: 'run', run: async () => result }
}

const PASSED: ActionResult = { verdict: 'passed', evidence: 'pnpm fmt exited 0', findings: [] }
const FAILED: ActionResult = { verdict: 'failed', evidence: 'pnpm fmt exited 1', findings: [] }

/** A `KeptRunActionDeps` recording every call, with each answer a knob. */
function fakeDeps(opts: {
  cleanAnswers?: readonly ('ok' | string)[]
  keepAnswer?: { committed: string } | { nothing: true } | { failed: string }
}): KeptRunActionDeps & { calls: string[] } {
  const calls: string[] = []
  const cleanAnswers = [...(opts.cleanAnswers ?? ['ok'])]
  return {
    calls,
    clean: async () => {
      calls.push('clean')
      const next = cleanAnswers.length > 1 ? cleanAnswers.shift()! : cleanAnswers[0]!
      return next === 'ok' ? { ok: true } : { failed: next }
    },
    keep: async (name) => {
      calls.push(`keep ${name}`)
      return opts.keepAnswer ?? { nothing: true }
    },
  }
}

describe('createKeptRunAction', () => {
  it('cleans before the command, commits what changed, and carries the head', async () => {
    const deps = fakeDeps({ keepAnswer: { committed: 'd'.repeat(40) } })
    const action = createKeptRunAction('format', fakeInner(PASSED), deps)

    const result = await action.run(context)

    expect(deps.calls).toEqual(['clean', 'keep format'])
    expect(result.verdict).toBe('passed')
    expect(result.head).toBe('d'.repeat(40))
    expect(result.evidence).toContain('committed')
  })

  it('commits nothing and carries no head when the command changed nothing', async () => {
    const deps = fakeDeps({ keepAnswer: { nothing: true } })
    const action = createKeptRunAction('format', fakeInner(PASSED), deps)

    const result = await action.run(context)

    expect(result.verdict).toBe('passed')
    expect(result.head).toBeUndefined()
    expect(result.evidence).toContain('nothing to commit')
  })

  it('never refuses on a non-zero exit — it cleans again and passes with a note', async () => {
    const deps = fakeDeps({})
    const action = createKeptRunAction('format', fakeInner(FAILED), deps)

    const result = await action.run(context)

    // `keep` is never called: there is nothing the command did that is worth
    // committing, because the tree was already put back.
    expect(deps.calls).toEqual(['clean', 'clean'])
    expect(result.verdict).toBe('passed')
    expect(result.head).toBeUndefined()
    expect(result.evidence).toContain('pnpm fmt exited 1')
    expect(result.evidence).toContain('build')
  })

  it('answers failed when the worktree cannot be put back before the command runs', async () => {
    const deps = fakeDeps({ cleanAnswers: ['stale .git/index.lock'] })
    const action = createKeptRunAction('format', fakeInner(PASSED), deps)

    const result = await action.run(context)

    expect(deps.calls).toEqual(['clean'])
    expect(result.verdict).toBe('failed')
    expect(result.evidence).toContain('index.lock')
  })

  it('answers failed when a failed command leaves a tree that cannot be put back', async () => {
    const deps = fakeDeps({ cleanAnswers: ['ok', 'stale .git/index.lock'] })
    const action = createKeptRunAction('format', fakeInner(FAILED), deps)

    const result = await action.run(context)

    expect(deps.calls).toEqual(['clean', 'clean'])
    expect(result.verdict).toBe('failed')
    expect(result.evidence).toContain('pnpm fmt exited 1')
    expect(result.evidence).toContain('index.lock')
  })

  it('passes with a note when the commit itself is refused and the tree is put back', async () => {
    const deps = fakeDeps({ keepAnswer: { failed: 'git commit refused it: nothing staged matches' } })
    const action = createKeptRunAction('format', fakeInner(PASSED), deps)

    const result = await action.run(context)

    expect(deps.calls).toEqual(['clean', 'keep format', 'clean'])
    expect(result.verdict).toBe('passed')
    expect(result.head).toBeUndefined()
    expect(result.evidence).toContain('refused')
  })

  it('answers failed when a refused commit leaves a tree that cannot be put back', async () => {
    const deps = fakeDeps({
      cleanAnswers: ['ok', 'stale .git/index.lock'],
      keepAnswer: { failed: 'git commit refused it' },
    })
    const action = createKeptRunAction('format', fakeInner(PASSED), deps)

    const result = await action.run(context)

    expect(result.verdict).toBe('failed')
    expect(result.evidence).toContain('refused')
    expect(result.evidence).toContain('index.lock')
  })

  it('runs again on a second visit — the fix round — independently of the first', async () => {
    const deps = fakeDeps({ keepAnswer: { committed: 'd'.repeat(40) } })
    const action = createKeptRunAction('format', fakeInner(PASSED), deps)

    const first = await action.run(context)
    const second = await action.run(context)

    expect(deps.calls).toEqual(['clean', 'keep format', 'clean', 'keep format'])
    expect(first.head).toBe('d'.repeat(40))
    expect(second.head).toBe('d'.repeat(40))
  })

  it('is legal before the agent too, and finds nothing to commit', async () => {
    // `implement: [run, agent]` — the ticket's own "a run before the agent is
    // legal" case. Nothing about the wrapper cares where in the list it sits.
    const deps = fakeDeps({ keepAnswer: { nothing: true } })
    const action = createKeptRunAction('format', fakeInner(PASSED), deps)

    const result = await action.run(context)

    expect(result.verdict).toBe('passed')
    expect(result.head).toBeUndefined()
  })
})
