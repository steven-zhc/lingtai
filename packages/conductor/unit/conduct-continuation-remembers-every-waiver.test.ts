/**
 * **A continuation remembers every waiver its item has been granted, not
 * only the one the latest approval named** (#465's blocker finding).
 *
 * `proposed:` declaring two actions that each stop the pass — `tamper`
 * first, `approval` second — used to loop forever: each approval resolved
 * one wait and waived that one action alone, so the other ran again
 * unwaived on the very next continuation and refused again, which is the
 * failure scenario the finding quotes verbatim: *"the two cards alternate
 * for ever: the ticket never lands, every lap re-cuts a worktree and costs
 * a person a click"*.
 *
 * Unit by [0060](../../../doc/decisions-archive/0060-the-gate-runs-unit-tests.md) §1:
 * no process, no socket, no network. The fixtures are `test/one-pass.ts`,
 * the same harness `conduct-continuation-diffs-the-base.test.ts` uses.
 */
import { waitsOf, ticketStream } from '@lingtai/domain'
import { aResolution } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { describe, expect, it } from 'vitest'

import { fakeGitHub, fakePorts, memoryStore, once, project, runtime, PROJECT } from '../test/one-pass.ts'

/**
 * `tamper` before `approval` — the finding's own order: the pipeline stops
 * at the first failure, so `approval` is never reached while `tamper`
 * still refuses.
 */
const TWO_WAITS_AT_PROPOSED = `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps:
  proposed:
    - name: tamper
      watch: ["src/fix.ts"]
    - name: approval
      human: "Merge this?"
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`

describe('a continuation never forgets a waiver an earlier approval already granted', () => {
  it('clears both actions once both have been approved, rather than looping between them forever', async () => {
    const store = memoryStore()
    const ticketId = ticketStream(PROJECT, 7)

    // Lap 1: a fresh pass. `tamper` refuses first, so `approval` is never
    // reached this lap.
    const first = await once(
      {
        project,
        client: fakeGitHub([], TWO_WAITS_AT_PROPOSED),
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: true,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts([], store, true),
    )
    if (first.ok === false) throw new Error(`stopped at ${first.stage}: ${first.detail}`)
    if (first.ok !== 'held') throw new Error('it merged, before anybody approved anything')
    expect(first.step).toBe('proposed')

    const onSha = first.headSha
    const wait1 = waitsOf(await store.read(ticketId)).at(-1)!
    expect(wait1.reason).toMatchObject({ action: 'tamper' })

    // Approve the first wait — only `tamper`'s.
    await store.append(
      ticketId,
      (await store.read(ticketId)).length,
      aResolution(makeStream(ticketId), wait1.waitId, { _tag: 'Approve', onSha }, 'human:steven'),
    )

    // Lap 2: the continuation. `tamper` is waived, so `approval` is reached
    // and asks — a *different* wait than lap 1's.
    const second = await once(
      {
        project,
        client: fakeGitHub([], TWO_WAITS_AT_PROPOSED),
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: true,
        home: '/tmp/fake-home',
        store,
        continuing: { runId: first.runId },
      },
      fakePorts([], store, true, { at: onSha, implementerCommits: false }),
    )
    if (second.ok === false) throw new Error(`stopped at ${second.stage}: ${second.detail}`)
    if (second.ok !== 'held') throw new Error('it merged on the second lap, before the second wait was approved')
    expect(second.step).toBe('proposed')

    const wait2 = waitsOf(await store.read(ticketId)).at(-1)!
    expect(wait2.waitId).not.toBe(wait1.waitId)
    expect(wait2.reason).toMatchObject({ action: 'approval' })

    // Approve the second wait — `approval`'s.
    await store.append(
      ticketId,
      (await store.read(ticketId)).length,
      aResolution(makeStream(ticketId), wait2.waitId, { _tag: 'Approve', onSha }, 'human:steven'),
    )

    // Lap 3: the continuation this finding is about. Both `tamper` and
    // `approval` have now each been granted their own approval. A
    // continuation that forgets the first (the bug) runs `tamper` again
    // unwaived, and it refuses again on the very same diff, holding as
    // `CheckRefused{proposed, tamper}` forever. With the fix, both are
    // waived on this lap's first visit to `proposed`, and the pass lands.
    const third = await once(
      {
        project,
        client: fakeGitHub([], TWO_WAITS_AT_PROPOSED),
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: true,
        home: '/tmp/fake-home',
        store,
        continuing: { runId: first.runId },
      },
      fakePorts([], store, true, { at: onSha, implementerCommits: false }),
    )

    if (third.ok === false) throw new Error(`stopped at ${third.stage}: ${third.detail}`)
    if (third.ok === 'held') {
      throw new Error(
        `held again at ${third.step} — a continuation forgot a waiver an earlier approval already granted, ` +
          "the loop #465's blocker finding describes",
      )
    }
    expect(third.ok).toBe(true)
    expect((await store.read(ticketId)).map((e) => e.type)).toContain('TicketLanded')
  })
})
