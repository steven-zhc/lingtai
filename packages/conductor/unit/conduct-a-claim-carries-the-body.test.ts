import type { Runtime } from '@lingtai/agent'
/**
 * **A pass's claim and continuation carry the ticket body it fetched** (#926,
 * [0109](../../../doc/decisions/0109-the-core-takes-a-ticket.md) §1).
 *
 * The string on the event is the string the implementer's prompt was rendered
 * from: the pass hands the one `issue.body` it fetched to both. (`getIssue` is read elsewhere in a pass too,
 * so the count of reads is not asserted.). Unit by 0060 §1.
 */
import { ticketStream, waitsOf } from '@lingtai/domain'
import { aResolution } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { describe, expect, it } from 'vitest'

import { fakeGitHub, fakePorts, issue, memoryStore, once, project, runtime, PROJECT } from '../test/one-attempt.ts'

const APPROVAL_AT_PROPOSED = `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps:
  proposed:
    - name: approval
      human: "Merge this?"
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`

/** A GitHub whose `getIssue` answers whatever body is current — the issue edited between passes. */
function withBody(first: string) {
  const client = fakeGitHub([], APPROVAL_AT_PROPOSED)
  const current = { body: first }
  client.getIssue = async () => ({ ...issue, body: current.body })
  return { client, edit: (body: string) => void (current.body = body) }
}

/** A runtime that keeps every prompt it was handed. */
function recording(prompts: string[]): Runtime {
  return {
    ...runtime,
    run: async (request, ...rest) => {
      prompts.push(request.prompt)
      return runtime.run(request, ...rest)
    },
  }
}

const options = (store: ReturnType<typeof memoryStore>, client: ReturnType<typeof fakeGitHub>, rt: Runtime) => ({
  project,
  client,
  runtime: rt,
  issue: 7,
  hookBinary: '/tmp/fake/lingtai-hook',
  prompt: 'fix {{body}}',
  merge: true,
  home: '/tmp/fake-home',
  store,
})

describe('the body a claim records', () => {
  it('is the string the implementer was prompted from', async () => {
    const store = memoryStore()
    const prompts: string[] = []
    const github = withBody('the body, as fetched')
    const result = await once(options(store, github.client, recording(prompts)), fakePorts([], store, true))
    expect(result.ok).toBe('held')

    const claimed = (await store.read(ticketStream(PROJECT, 7))).filter((e) => e.type === 'TicketClaimed')
    expect(claimed).toHaveLength(1)
    expect((claimed[0]!.data as { body?: string }).body).toBe('the body, as fetched')
    expect(prompts[0]).toContain('the body, as fetched')
  })

  it('on a continuation is the re-fetched body, not the claim’s', async () => {
    const store = memoryStore()
    const github = withBody('before the edit')
    const first = await once(options(store, github.client, runtime), fakePorts([], store, true))
    if (first.ok !== 'held') throw new Error(`expected a hold, got ${JSON.stringify(first)}`)

    const ticketId = ticketStream(PROJECT, 7)
    const wait = waitsOf(await store.read(ticketId)).at(-1)!
    await store.append(
      ticketId,
      (await store.read(ticketId)).length,
      aResolution(makeStream(ticketId), wait.waitId, { _tag: 'Approve', onSha: first.headSha }, 'human:steven'),
    )

    github.edit('after the edit')
    const ports = fakePorts([], store, true, { at: first.headSha, implementerCommits: false })
    await once({ ...options(store, github.client, runtime), continuing: { runId: first.runId } }, ports)

    const events = await store.read(ticketId)
    const claimed = events.filter((e) => e.type === 'TicketClaimed')
    const continued = events.filter((e) => e.type === 'TicketContinued')
    expect((claimed[0]!.data as { body?: string }).body).toBe('before the edit')
    expect(continued).toHaveLength(1)
    expect((continued[0]!.data as { body?: string }).body).toBe('after the edit')
  })
})
