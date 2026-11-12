/**
 * **Merged work is recorded as landed, never given back** (#1056).
 *
 * When the append that closes the merge step is refused after the integration
 * succeeded, the pass dies with a defect. The handler used to release the item,
 * returning merged work to the queue; it now records `TicketLanded` first.
 */
import { describe, expect, it } from 'vitest'

import { PROJECT, fakeGitHub, fakePorts, memoryStore, once, project, runtime } from '../test/one-attempt.ts'

describe('a merge whose StepEnded append is refused', () => {
  it('records the landing and does not release the ticket', async () => {
    const base = memoryStore()
    const store: typeof base = {
      ...base,
      async append(streamId, expectedVersion, events) {
        const ended = events.find((e) => e.type === 'StepEnded')
        if (ended && (ended.data as { step?: string }).step === 'merge') throw new Error('store refused')
        return base.append(streamId, expectedVersion, events)
      },
    }
    const did: string[] = []
    await once(
      {
        project,
        client: fakeGitHub([]),
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: true,
        home: '/tmp/fake-home',
        store,
        log: () => {},
      },
      fakePorts(did, store, true),
    )
    expect(did).toContain('integrate')
    const types = (base.streams.get(`ticket-${PROJECT}-7`) ?? []).map((e) => e.type)
    expect(types).toContain('TicketLanded')
    expect(types).not.toContain('TicketReleased')
  })
})
