/**
 * A person's `lingtai:hold` survives converge's whole-set label write (#1336):
 * the target keeps it and drops only the stale label Lingtai computes.
 *
 * Unit, by 0060 §1: a memory log, a fake `DaemonStore`, a fake GitHub client.
 */
import { ticketStream } from '@lingtai/domain'
import type { ProjectState } from '@lingtai/domain'
import { aClaim } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { expect, it } from 'vitest'

import { findIssueDriftEffect } from '../src/converge.ts'
import type { DaemonStore } from '../src/store.ts'

const PROJECT = 'lingtai'
const STREAM = ticketStream(PROJECT, 1336)

const project: ProjectState = {
  project: PROJECT,
  owner: 'steven-zhc',
  base: 'main',
  configHash: 'seeded',
  fromSha: '0'.repeat(40),
  refused: null,
  paused: null,
  recipe: null,
  sandboxObserved: null,
  highestPr: null,
  version: 1,
  lastSeq: null,
}

it('keeps lingtai:hold in the target and drops the stale lingtai:waiting', async () => {
  const store = createMemoryEventStore()
  await store.append(STREAM, 0, [...aClaim(makeStream(STREAM), 'pass-1336')])
  const client = {
    getIssue: async (n: number) => ({
      number: n,
      title: 'a ticket',
      body: '',
      labels: ['bug', 'lingtai:hold', 'lingtai:waiting'].map((name) => ({ name, color: null })),
      state: 'open' as const,
      url: `https://example.invalid/${n}`,
      dependencies: { blockedBy: 0, totalBlockedBy: 0 },
      parent: null,
      subIssues: null,
      assignees: [],
    }),
    setLabels: async () => {},
    closeIssue: async () => {},
    branchExists: async () => false,
    createBranch: async () => {},
    matchingRefs: async () => [],
    deleteRef: async () => {},
  }
  const found = await Effect.runPromise(
    findIssueDriftEffect({
      store,
      daemonStore: { streams: () => Effect.succeed([STREAM]) } as unknown as DaemonStore,
      projects: [project],
      clients: new Map([[PROJECT, client]]),
    }),
  )
  const drift = found.find((d) => d.change === 'labels')
  expect(drift?.expected).toBe('bug, lingtai:hold, lingtai:working')
})
