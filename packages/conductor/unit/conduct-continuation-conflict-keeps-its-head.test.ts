/**
 * **A continuation the merge lane refuses still has the head it published**
 * (#607).
 *
 * A continuation re-cuts its tree at the approved sha, so `tree.baseSha` is that
 * sha, and nothing dispatches before the lane. `publishWhatIsCommitted` read
 * `head === tree.baseSha` as *nothing committed* and wrote a last
 * `RunRefsPublished` of `nothing-committed` over the `published` one, so
 * `GrantFixRound` on the conflict wait was refused `no-saved-head`.
 *
 * Unit by [0060](../../../doc/decisions-archive/0060-the-gate-runs-unit-tests.md) §1.
 */
import { ticketStream, waitsOf } from '@lingtai/domain'
import { aResolution } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { resolveWaitHolding } from '../src/resolve-wait.ts'
import { fakeGitHub, fakePorts, memoryStore, once, project, runtime, PROJECT } from '../test/one-pass.ts'

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

describe('an approved continuation refused at the lane', () => {
  it('records the head it published, and a fix round can continue from it', async () => {
    const store = memoryStore()
    const base = {
      project,
      client: fakeGitHub([], APPROVAL_AT_PROPOSED),
      runtime,
      issue: 7,
      hookBinary: '/tmp/fake/lingtai-hook',
      prompt: 'fix {{issue}}',
      merge: true,
      home: '/tmp/fake-home',
      store,
    }
    const first = await once(base, fakePorts([], store, true))
    if (first.ok !== 'held') throw new Error(`expected a hold, got ${JSON.stringify(first)}`)
    const onSha = first.headSha

    const ticketId = ticketStream(PROJECT, 7)
    const wait = waitsOf(await store.read(ticketId)).at(-1)!
    await store.append(
      ticketId,
      (await store.read(ticketId)).length,
      aResolution(makeStream(ticketId), wait.waitId, { _tag: 'Approve', onSha }, 'human:steven'),
    )

    const did: string[] = []
    const ports = fakePorts(did, store, true, { at: onSha, implementerCommits: false })
    ports.repo.integrate = () =>
      Effect.sync(() => {
        did.push('integrate')
        return {
          ok: false,
          reason: 'conflict',
          detail: 'conflict in src/fix.ts',
          conflict: { paths: ['src/fix.ts'], baseSha: 'a'.repeat(40), headSha: onSha },
        } as never
      })
    const second = await once({ ...base, continuing: { runId: first.runId } }, ports)
    expect(second.ok, JSON.stringify(second)).toBe('held')
    const events = await store.read(second.runId!)
    const published = events.filter((e) => e.type === 'RunRefsPublished').map((e) => e.data as Record<string, unknown>)
    expect(published.at(-1)).toMatchObject({ headSha: onSha })
    expect(['published', 'already-published']).toContain(published.at(-1)!.outcome)

    const conflictWait = waitsOf(await store.read(ticketId)).at(-1)!
    const granted = await resolveWaitHolding(
      {
        ticketId,
        issue: 7,
        waitId: conflictWait.waitId,
        resolution: { _tag: 'GrantFixRound', onSha: '', ref: '' },
        by: 'human:steven',
        client: { refSha: async () => onSha },
        store,
      },
      ticketId,
    )
    expect(granted).toMatchObject({ ok: true })
  })
})
