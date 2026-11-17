import { flakyClaim } from '@lingtai/domain'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { flakyPortOf, type FlakyReads } from '../src/flaky-port.ts'

const ENTRY = 'src/a.test.ts > does a thing'
const OUTPUT = [` FAIL  ${ENTRY}`, ' Test Files  1 failed (3)'].join('\n')
const COMMAND = 'pnpm test'
const outcome = (evidence: string) => ({ ok: false, evidence, timedOut: false, durationMs: 1, exitCode: 1 })
const ask = { step: 'build' as const, action: 'check', command: COMMAND, first: outcome(OUTPUT), second: outcome('') }
const baseChecked = (data: Record<string, unknown>) => ({ type: 'BaseChecked', data: { command: COMMAND, ...data } })

function reads(over: Partial<FlakyReads> & { events?: unknown[] } = {}): FlakyReads {
  return {
    store: { read: async () => (over.events ?? []) as never },
    stream: 'integration/p/main',
    diffPaths: () => Effect.succeed(['src/other.ts']),
    backlog: () => Effect.succeed([]),
    head: () => Effect.succeed('f'.repeat(40)),
    ...over,
  }
}
const answer = (r: FlakyReads, a = ask) => Effect.runPromise(flakyPortOf(r)(a))

describe('flakyPortOf', () => {
  it('a red BaseChecked naming the test on another commit satisfies condition 3', async () => {
    const r = await answer(reads({ events: [baseChecked({ baseSha: 'b'.repeat(40), ok: false, evidence: OUTPUT })] }))
    expect(r.passed).toBe(true)
  })

  it('a BaseChecked of another command proves nothing', async () => {
    const r = await answer(
      reads({ events: [baseChecked({ baseSha: 'b', ok: false, evidence: OUTPUT, command: 'other' })] }),
    )
    expect(r.passed).toBe(false)
  })

  it('a declined backlog row naming the test satisfies condition 3', async () => {
    const row = { file: 'src/a.test.ts', claim: flakyClaim(ENTRY, COMMAND), status: 'declined' }
    const r = await answer(reads({ backlog: () => Effect.succeed([row]) }))
    expect(r.passed).toBe(true)
  })

  it('a store whose read fails answers red', async () => {
    const r = await answer(
      reads({
        store: {
          read: async () => {
            throw new Error('down')
          },
        },
      }),
    )
    expect(r.passed).toBe(false)
    expect(r.evidence).toContain('could not be read')
  })

  it('a backlog or diff read that fails answers red', async () => {
    const events = [baseChecked({ baseSha: 'b', ok: false, evidence: OUTPUT })]
    expect((await answer(reads({ events, backlog: () => Effect.fail(new Error('x')) }))).passed).toBe(false)
    expect((await answer(reads({ events, diffPaths: () => Effect.fail(new Error('x')) }))).passed).toBe(false)
    expect((await answer(reads({ events, diffPaths: () => Effect.succeed(null) }))).passed).toBe(false)
  })

  it('reads nothing when the tests cannot be named', async () => {
    let touched = false
    const r = await answer(
      reads({
        diffPaths: () => {
          touched = true
          return Effect.succeed([])
        },
      }),
      { ...ask, first: outcome('tsc error') },
    )
    expect(r.passed).toBe(false)
    expect(touched).toBe(false)
  })
})
