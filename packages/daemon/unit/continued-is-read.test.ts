/**
 * `reconcile` and `converge` select ticket streams by event type and then fold
 * each with `reduceTicket`, which reads a claim and a continuation through
 * `claimShapeOf`. #685: both type lists name `TicketContinued`, and a
 * continuation by another worker is the claimant that is checked — in the old
 * form (a second `TicketClaimed`) and the new one alike.
 *
 * Unit, by 0060 §1: a memory log and a fake `DaemonStore`. Every worker is on a
 * foreign host so nothing here spawns `ps`.
 */
import { ticketStream } from '@lingtai/domain'
import type { ProjectState } from '@lingtai/domain'
import { aClaim, aResolution, aWait, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { findIssueDrift } from '../src/converge.ts'
import { releaseForeignClaims } from '../src/reconcile.ts'
import type { DaemonStore } from '../src/store.ts'

const PROJECT = 'lingtai'
const STREAM = ticketStream(PROJECT, 685)
const SHA = 'a'.repeat(40)
const W1 = 'elsewhere:4242'
const W2 = 'elsewhere:4343'
const MINE = 'elsewhere:1'

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

type Form = 'claimed' | 'continued'

async function seeded(form: Form) {
  const store = createMemoryEventStore()
  const item = makeStream(STREAM)
  const waitId = aWaitId()
  await store.append(STREAM, 0, [
    ...aClaim(item, 'r1', W1),
    ...aWait(
      item,
      { _tag: 'SignoffRequired', run: { runId: 'r1' }, step: 'merge', action: 'human:land', question: '?' },
      waitId,
    ),
    ...aResolution(item, waitId, { _tag: 'Approve', onSha: SHA }, 'human:steven'),
    form === 'claimed'
      ? item('TicketClaimed', { runId: 'r1', worker: W2, title: null, kind: null })
      : item('TicketContinued', { runId: 'r1', worker: W2 }),
  ])
  const queries: { types?: readonly string[] }[] = []
  const daemonStore = {
    streams: async (q: { types?: readonly string[] }) => {
      queries.push(q)
      return [STREAM]
    },
  } as unknown as DaemonStore
  return { store, daemonStore, queries }
}

function fakeClient(labels: readonly string[]) {
  return {
    getIssue: async (n: number) => ({
      number: n,
      title: 't',
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

describe('a continuation is read by reconcile and converge', () => {
  it('both ask for TicketContinued streams', async () => {
    const s = await seeded('continued')
    await releaseForeignClaims({ store: s.store, daemonStore: s.daemonStore, projects: [project], worker: MINE })
    await findIssueDrift({
      store: s.store,
      daemonStore: s.daemonStore,
      projects: [project],
      clients: new Map([[PROJECT, fakeClient([])]]),
    })
    expect(s.queries).toHaveLength(2)
    for (const q of s.queries) expect(q.types).toContain('TicketContinued')
  })

  it("checks the continuation's worker, same as the old form", async () => {
    const run = async (form: Form, worker: string) => {
      const s = await seeded(form)
      return releaseForeignClaims({
        store: s.store,
        daemonStore: s.daemonStore,
        projects: [project],
        worker,
        dryRun: true,
      })
    }
    const old = await run('claimed', MINE)
    const next = await run('continued', MINE)
    expect(next).toEqual(old)
    expect(next).toHaveLength(1)
    expect(next[0]!.actual).toContain(W2)
    expect(next[0]!.actual).not.toContain(W1)
  })

  it('leaves a run alone when this conductor made the continuation', async () => {
    for (const form of ['claimed', 'continued'] as const) {
      const s = await seeded(form)
      const found = await releaseForeignClaims({
        store: s.store,
        daemonStore: s.daemonStore,
        projects: [project],
        worker: W2,
        dryRun: true,
      })
      expect(found).toEqual([])
    }
  })

  it('converge reports the same drift for both forms', async () => {
    const run = async (form: Form) => {
      const s = await seeded(form)
      return findIssueDrift({
        store: s.store,
        daemonStore: s.daemonStore,
        projects: [project],
        clients: new Map([[PROJECT, fakeClient(['lingtai:waiting'])]]),
      })
    }
    const old = await run('claimed')
    expect(await run('continued')).toEqual(old)
    expect(old.find((d) => d.change === 'labels')?.expected).toBe('lingtai:working')
  })
})
