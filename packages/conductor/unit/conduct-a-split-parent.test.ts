/**
 * A split parent whose recorded children are all closed (#604), through the
 * whole of `conduct`: closed at claim by the conductor, no agent dispatched,
 * and the comment says how each child closed.
 */
import { ticketStream } from '@lingtai/domain'
import { aSplit, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { GitHubClient } from '@lingtai/github'
import { describe, expect, it } from 'vitest'

import {
  PROJECT,
  fakeGitHub,
  fakePorts,
  issue,
  memoryStore,
  once,
  project,
  runtime,
  streams,
} from '../test/one-pass.ts'

describe('a split parent whose children are all closed', () => {
  it('is closed by the conductor with a comment, and no agent runs', async () => {
    const store = memoryStore()
    const did: string[] = []
    const said: string[] = []
    const bodies: string[] = []
    const ticketId = ticketStream(PROJECT, 7)
    await store.append(ticketId, 0, aSplit(makeStream(ticketId), aWaitId(), [161, 162]))

    const base = fakeGitHub(said)
    const client = {
      ...base,
      getIssue: async (n: number) =>
        n === 161
          ? { ...issue, number: 161, state: 'closed', stateReason: 'completed' }
          : n === 162
            ? { ...issue, number: 162, state: 'closed', stateReason: 'not_planned' }
            : issue,
      comment: async (_n: number, body: string) => {
        bodies.push(body)
        return { id: 1 }
      },
    } as unknown as GitHubClient

    await once(
      {
        project,
        client,
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts(did, store),
    )

    const held = streams(store).get(ticketId)!
    expect(held.map((e) => e.type)).not.toContain('TicketClaimed')
    const closed = held.find((e) => e.type === 'TicketClosed')
    expect(closed).toBeDefined()
    expect((closed!.data as { by: string }).by).toBe('conductor')
    // Nothing provisioned or dispatched — the only entry is the pass tidying a path it never cut.
    expect(did.filter((d) => !d.startsWith('remove '))).toEqual([])
    // The issue itself is closed even though this recipe's `end` is empty.
    expect(said).toContain('close #7')
    expect(bodies.join('\n')).toContain('#161 completed, #162 not planned')
  })

  it('does not announce a close GitHub refused', async () => {
    const store = memoryStore()
    const did: string[] = []
    const said: string[] = []
    const bodies: string[] = []
    const ticketId = ticketStream(PROJECT, 7)
    await store.append(ticketId, 0, aSplit(makeStream(ticketId), aWaitId(), [161, 162]))

    const base = fakeGitHub(said)
    const client = {
      ...base,
      getIssue: async (n: number) =>
        n === 161
          ? { ...issue, number: 161, state: 'closed', stateReason: 'completed' }
          : n === 162
            ? { ...issue, number: 162, state: 'closed', stateReason: 'not_planned' }
            : issue,
      closeIssue: async () => {
        throw new Error('GitHub is down')
      },
      comment: async (_n: number, body: string) => {
        bodies.push(body)
        return { id: 1 }
      },
    } as unknown as GitHubClient

    await once(
      {
        project,
        client,
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts(did, store),
    )

    const held = streams(store).get(ticketId)!
    expect(held.map((e) => e.type)).not.toContain('TicketClaimed')
    const closed = held.find((e) => e.type === 'TicketClosed')
    expect(closed).toBeDefined()
    expect((closed!.data as { by: string }).by).toBe('conductor')
    // Nothing provisioned or dispatched — the only entry is the pass tidying a path it never cut.
    expect(did.filter((d) => !d.startsWith('remove '))).toEqual([])
    expect(held.map((e) => e.type)).toContain('IssueUpdateFailed')
    expect(bodies).toEqual([])
  })
})
