/**
 * `labelState`'s `approved` row (#465): an item approved but not yet
 * continued must not read as wanting no Lingtai label, which is what the
 * `default` arm answered before this and is indistinguishable from a landed
 * or untouched issue.
 *
 * Unit, by 0060 §1: a memory log, a fake `DaemonStore` naming one stream, and
 * a GitHub client that is a set of labels — no Postgres, no network.
 */
import { ticketStream } from '@lingtai/domain'
import type { ProjectState } from '@lingtai/domain'
import { aClaim, aResolution, aWait, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { findIssueDrift } from '../src/converge.ts'
import type { DaemonStore } from '../src/store.ts'

const PROJECT = 'lingtai'
const ISSUE = 465
const STREAM = ticketStream(PROJECT, ISSUE)
const SHA = 'a'.repeat(40)

const project: ProjectState = {
  project: PROJECT,
  owner: 'steven-zhc',
  base: 'main',
  configHash: 'seeded',
  fromSha: '0'.repeat(40),
  refused: null,
  version: 1,
  lastSeq: null,
}

function oneStream(): DaemonStore {
  return { streams: async () => [STREAM] } as unknown as DaemonStore
}

/** A fake GitHub client carrying a fixed label set — `lingtai:waiting`, the one the sweep's own signoff put there. */
function fakeClient(labels: readonly string[]) {
  return {
    getIssue: async (n: number) => ({
      number: n,
      id: (n * 1000 + 7) as never,
      title: 'a ticket',
      body: '',
      labels: labels.map((name) => ({ name, color: null })),
      state: 'open' as const,
      url: `https://example.invalid/${n}`,
      dependencies: { blockedBy: 0, totalBlockedBy: 0 },
      assignees: [],
    }),
    setLabels: async () => {},
    closeIssue: async () => {},
    matchingRefs: async () => [],
    deleteRef: async () => {},
  }
}

it("an approved item still wants a Lingtai label — not the default arm's none at all", async () => {
  const store: EventStore = createMemoryEventStore()
  const item = makeStream(STREAM)
  const waitId = aWaitId()
  await store.append(STREAM, 0, [
    ...aClaim(item, 'pass-465'),
    ...aWait(
      item,
      { _tag: 'SignoffRequired', run: { runId: 'pass-465' }, step: 'merge', action: 'human:land', question: '?' },
      waitId,
    ),
    ...aResolution(item, waitId, { _tag: 'Approve', onSha: SHA }, 'human:steven'),
  ])

  const found = await findIssueDrift({
    store,
    daemonStore: oneStream(),
    projects: [project],
    clients: new Map([[PROJECT, fakeClient(['lingtai:waiting'])]]),
  })

  // `labelState('approved')` now reads `approved` (#510), and `labelsFor`
  // gives it the same `lingtai:working` `running`/`verifying` get, rather
  // than the default arm's `[]` — the issue still carrying `lingtai:waiting`
  // is drift towards that, not towards no label at all.
  const drift = found.find((d) => d.change === 'labels')
  expect(drift?.expected).toBe('lingtai:working')
})

describe('once the label already agrees', () => {
  it('reports no drift', async () => {
    const store: EventStore = createMemoryEventStore()
    const item = makeStream(STREAM)
    const waitId = aWaitId()
    await store.append(STREAM, 0, [
      ...aClaim(item, 'pass-465'),
      ...aWait(
        item,
        { _tag: 'SignoffRequired', run: { runId: 'pass-465' }, step: 'merge', action: 'human:land', question: '?' },
        waitId,
      ),
      ...aResolution(item, waitId, { _tag: 'Approve', onSha: SHA }, 'human:steven'),
    ])

    const found = await findIssueDrift({
      store,
      daemonStore: oneStream(),
      projects: [project],
      clients: new Map([[PROJECT, fakeClient(['lingtai:working'])]]),
    })

    expect(found.find((d) => d.change === 'labels')).toBeUndefined()
  })
})
