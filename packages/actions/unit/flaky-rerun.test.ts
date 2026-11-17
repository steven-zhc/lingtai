import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { ActionContext } from '../src/action.ts'
import type { CommandOutcome } from '../src/command.ts'
import { actionPortsFromRecipe } from '../src/from-recipe.ts'
import { type FlakyPort, makeProcessAction } from '../src/process-action.ts'

const context: ActionContext = { runId: 'r', onSha: 'a'.repeat(40), cwd: '/tmp/wt', env: {} }
const outcome = (over: Partial<CommandOutcome>): CommandOutcome => ({
  ok: false,
  evidence: 'boom',
  timedOut: false,
  durationMs: 1,
  exitCode: 1,
  ...over,
})
const green = outcome({ ok: true, evidence: 'ok', exitCode: 0 })

function scripted(outcomes: CommandOutcome[]) {
  const calls: number[] = []
  const command = () => {
    calls.push(1)
    return Effect.succeed(outcomes[Math.min(calls.length - 1, outcomes.length - 1)]!)
  }
  return { calls, command }
}
const finding = {
  file: 'a.test.ts',
  line: null,
  claim: 'flaky: x',
  failureScenario: 's',
  severity: 'minor' as const,
}
const lets: FlakyPort = () => Effect.succeed({ passed: true, evidence: 'red then green', findings: [finding] })

const run = (outcomes: CommandOutcome[], flaky?: FlakyPort, step: 'build' | 'merge' = 'build') => {
  const s = scripted(outcomes)
  const port = makeProcessAction({
    name: 'check',
    run: 'pnpm test',
    env: {},
    step,
    command: s.command,
    ...(flaky ? { flaky } : {}),
  })
  return Effect.runPromise(port.run(context) as Effect.Effect<any>).then((r) => ({ r, calls: s.calls.length }))
}

describe('a run: check reruns once', () => {
  it('red then green with a port that lets it through passes with its findings', async () => {
    const { r, calls } = await run([outcome({}), green], lets)
    expect(calls).toBe(2)
    expect(r.verdict).toBe('passed')
    expect(r.findings).toEqual([finding])
  })

  it('red then green the port refuses is failed with the port evidence', async () => {
    const { r } = await run([outcome({}), green], () => Effect.succeed({ passed: false, evidence: 'not let through' }))
    expect(r.verdict).toBe('failed')
    expect(r.evidence).toBe('not let through')
  })

  it('red twice is failed with the second run and never asks the port', async () => {
    let asked = false
    const { r, calls } = await run([outcome({ evidence: 'one' }), outcome({ evidence: 'two' })], () => {
      asked = true
      return Effect.succeed({ passed: true, evidence: '', findings: [] })
    })
    expect(calls).toBe(2)
    expect(asked).toBe(false)
    expect(r.verdict).toBe('failed')
    expect(r.evidence).toContain('failed too')
    expect(r.evidence).toContain('two')
  })

  it('does not rerun a timeout, and runs once without a port or when green', async () => {
    expect((await run([outcome({ timedOut: true, exitCode: null })], lets)).calls).toBe(1)
    expect((await run([outcome({})])).calls).toBe(1)
    expect((await run([green], lets)).calls).toBe(1)
  })

  it('applies at merge, and at build and proposed', async () => {
    const action = { name: 'check', run: 'pnpm test', timeout: '15m', env: [] as string[] }
    for (const step of ['merge', 'build', 'proposed'] as const) {
      const s = scripted([outcome({}), green])
      const [port] = actionPortsFromRecipe(step, [action], { env: () => ({}), command: s.command, flaky: lets })
      const r: any = await Effect.runPromise(port!.run(context) as Effect.Effect<any>)
      expect(r.verdict).toBe('passed')
      expect(s.calls.length).toBe(2)
    }
  })

  it('a sandbox that becomes unavailable on the rerun keeps its routing metadata', async () => {
    let n = 0
    const port = makeProcessAction({
      name: 'check',
      run: 'pnpm test',
      env: {},
      step: 'build',
      command: () => Effect.succeed(outcome({})),
      flaky: lets,
      sandbox: {
        profile: () => ({}) as never,
        wrap: () =>
          ++n === 1
            ? Effect.succeed({ argv: ['x'], env: {} } as never)
            : Effect.fail({ _tag: 'SandboxUnavailable', reason: 'cache gone', sentences: [] } as never),
      } as never,
    })
    const r: any = await Effect.runPromise(port.run(context) as Effect.Effect<any>)
    expect(r.verdict).toBe('failed')
    expect(r.sandboxUnavailable).toContain('cache gone')
    expect(r.notWrapped).toBe(true)
  })
})
