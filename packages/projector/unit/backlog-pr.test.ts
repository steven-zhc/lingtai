/** A PR's resolution review's minors are backlog entries under the PR (#1315). */
import type { Envelope } from '@lingtai/domain'
import { anAttempt } from '@lingtai/domain/test/events'
import { describe, expect, it } from 'vitest'

import { backlogProjection, subjectOf } from '../src/backlog.ts'
import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'
import { createFace, reduceFace } from '../src/store-face.ts'

const SHA = 'b'.repeat(40)
const review = (stream: string, round: number, claims: string[]): Envelope[] =>
  anAttempt(stream).aStepEnded({
    step: 'review',
    round,
    actions: [
      {
        plugin: 'agent',
        name: 'review',
        onSha: SHA,
        evidence: 'ok',
        yields: 'verdict',
        result: {
          _tag: 'Completed',
          assessment: {
            verdict: 'accepted',
            findings: claims.map((claim) => ({
              file: 'src/a.ts',
              line: 1,
              claim,
              failureScenario: 'breaks',
              severity: 'minor' as const,
            })),
          },
        },
      },
    ],
  })

async function reduced(events: Envelope[]) {
  const store = createSqliteProjectionStore(openSqliteProjections(':memory:'))
  await store.transact((ctx) => createFace(backlogProjection, ctx))
  await store.transact((ctx) => reduceFace(backlogProjection, events, ctx))
  const rows = await store.backlog({})
  await store.close()
  return rows
}

describe('finding_backlog under a PR', () => {
  it('files each minor under the PR with no ticket and no RunStarted', async () => {
    const rows = await reduced(review('pr-p-7', 0, ['one', 'two']))
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r.pr).toEqual({ stream: 'pr-p-7', n: 7 })
      expect(r.issue).toBeNull()
      expect(r.taskId).toBeNull()
      expect(r.project).toBe('p')
      expect(r.onSha).toBe(SHA)
      expect(subjectOf(r)).toEqual({ kind: 'pr', stream: 'pr-p-7', n: 7 })
    }
  })

  it('dedupes within a PR and not across PRs', async () => {
    const same = await reduced([...review('pr-p-7', 0, ['one']), ...review('pr-p-7', 1, ['one'])])
    expect(same).toHaveLength(1)
    const other = await reduced([...review('pr-p-7', 0, ['one']), ...review('pr-p-8', 0, ['one'])])
    expect(other).toHaveLength(2)
  })

  it('files nothing for a pr- stream id that does not parse', async () => {
    expect(await reduced(review('pr-nonsense', 0, ['one']))).toHaveLength(0)
  })
})
