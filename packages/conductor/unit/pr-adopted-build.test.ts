/**
 * A head a person pushed and a retry adopted was not built by Lingtai (#1314): the build step builds it, where a commit the
 * sync made itself is taken as built.
 */
import { emptyPr, type PrState } from '@lingtai/domain'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { buildStep } from '../src/pr-sync.ts'
import type { PrPorts } from '../src/pr.ts'

const HEAD = 'e'.repeat(40)

const state = (adopted: string | null): PrState => ({
  ...emptyPr,
  status: 'in-progress',
  prBranch: 'lingtai-team-pr-1',
  frozenSha: 'f'.repeat(40),
  target: HEAD,
  lastPushed: HEAD,
  adopted,
  steps: [{ step: 'sync', headSha: HEAD }],
})

const ports = (built: string[], kind: 'green' | 'red'): PrPorts =>
  ({
    sweep: () => Effect.void,
    git: () => Effect.succeed({ code: 0, stdout: '', stderr: '' }),
    build: (_p: string, ask: { sha: string }) => {
      built.push(ask.sha)
      return Effect.succeed(
        kind === 'green' ? { kind: 'green' } : { kind: 'red', command: 'pnpm test', evidence: 'one failed' },
      )
    },
  }) as unknown as PrPorts

const run = (s: PrState, p: PrPorts) =>
  Effect.runPromise(buildStep.run({ project: 'lingtai', n: 1, state: s, ports: p }))

describe('the build step and a head a person pushed', () => {
  it('takes the sync commit as built when Lingtai made it', async () => {
    const built: string[] = []
    expect(await run(state(null), ports(built, 'green'))).toMatchObject({ kind: 'done', headSha: HEAD })
    expect(built).toEqual([])
  })

  it('builds an adopted head, and records the build step as done without a merge record', async () => {
    const built: string[] = []
    const answer = await run(state(HEAD), ports(built, 'green'))
    expect(built).toEqual([HEAD])
    expect(answer).toMatchObject({ kind: 'done', headSha: HEAD })
    expect('record' in answer && answer.record !== undefined).toBe(false)
  })

  it('waits sync-red with the evidence when the adopted head builds red', async () => {
    const built: string[] = []
    expect(await run(state(HEAD), ports(built, 'red'))).toMatchObject({ kind: 'wait', reason: 'sync-red' })
  })

  it('waits at once for an adopted head that builds red, even with a conflict agent: nothing was merged (#1352)', async () => {
    const built: string[] = []
    const refuses = () => {
      throw new Error('no round may start for an adopted head')
    }
    const withAgent = {
      ...ports(built, 'red'),
      resolver: { standMerge: refuses, standCommit: refuses, locked: refuses },
    } as unknown as PrPorts
    expect(await run({ ...state(HEAD), main: 'main' }, withAgent)).toMatchObject({ kind: 'wait', reason: 'sync-red' })
  })
})
