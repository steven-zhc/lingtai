/** `readBacklog({ taskIds })` (#894): one read narrowed to the tickets a page shows. */
import type { Envelope } from '@lingtai/domain'
import { anAttempt } from '@lingtai/domain/test/events'
import { describe, expect, it } from 'vitest'

import { backlogProjection } from '../src/backlog.ts'
import { createSqliteProjectionStore, openSqliteProjections } from '../src/sqlite.ts'

const SHA = 'a'.repeat(40)
const raise = (run: ReturnType<typeof anAttempt>, ticketId: string, claim: string): Envelope[] => [
  run.event('RunStarted', {
    ticketId,
    runtime: 'claude-code',
    model: 'm',
    promptVersion: '1',
    baseSha: SHA,
    configHash: 'c0ffee',
    worktree: '/tmp/pin',
    invocation: null,
  }),
  ...run.aStepEnded({
    step: 'proposed',
    round: 0,
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
            findings: [{ file: 'src/a.ts', line: 1, claim, failureScenario: 'breaks', severity: 'minor' }],
          },
        },
      },
    ],
  }),
]

describe('ProjectionStore.backlog taskIds', () => {
  it('reads only those tickets’ entries; empty reads nothing; absent reads all', async () => {
    const store = createSqliteProjectionStore(openSqliteProjections(':memory:'))
    try {
      await store.transact((ctx) => backlogProjection.create(ctx))
      await store.transact((ctx) =>
        backlogProjection.reduce(
          [
            ...raise(anAttempt('pass-ids-1'), 'ticket-ids-1', 'first claim'),
            ...raise(anAttempt('pass-ids-2'), 'ticket-ids-2', 'second claim'),
            ...raise(anAttempt('pass-ids-3'), 'ticket-ids-3', 'third claim'),
          ],
          ctx,
        ),
      )
      expect(await store.backlog({})).toHaveLength(3)
      const some = await store.backlog({ taskIds: ['ticket-ids-1', 'ticket-ids-3'] })
      expect(some.map((e) => e.taskId).sort()).toEqual(['ticket-ids-1', 'ticket-ids-3'])
      expect(await store.backlog({ taskIds: [] })).toEqual([])
      expect(await store.backlog({ taskIds: ['ticket-nobody-1'] })).toEqual([])
    } finally {
      await store.close()
    }
  })
})
