/**
 * **A continuation's "what changed" reads diff against the run's own base,
 * never the sha it was approved at** (#465).
 *
 * `provisionWorktree` cuts a continuation's worktree `at: continuation.onSha`
 * so the agent's own prior commits are there — but that same sha is not what
 * `watch:`'s `changedFiles()`, the cold reviewer's `diff` port, or a fixing
 * agent's own briefing should diff against: on the continuation's first lap
 * `HEAD` *is* that sha, so a `from...HEAD` range built from it is empty, and a
 * `watch:` declared beside the approval it is answering clears a diff it never
 * read.
 *
 * Unit by [0060](../../../doc/decisions-archive/0060-the-gate-runs-unit-tests.md) §1:
 * no process, no socket, no network. The fixtures are `test/one-pass.ts`.
 */
import { waitWords, reduceRun, waitsOf, ticketStream } from '@lingtai/domain'
import { aResolution } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { describe, expect, it } from 'vitest'

import { fakeGitHub, fakePorts, memoryStore, once, project, runtime, PROJECT } from '../test/one-pass.ts'

/**
 * `human:` at `proposed`, with a `watch:` declared right after it — the
 * finding's own reproduction: a recipe that asks a person before the lane and
 * also watches a path, so the watch is still unjudged when the approval is
 * the only thing granted.
 */
const WATCH_AFTER_APPROVAL = `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps:
  proposed:
    - name: approval
      human: "Merge this? It is Lingtai's own code."
    - name: tamper
      watch: ["src/fix.ts"]
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`

describe('a continuation never diffs against the sha it was approved at', () => {
  it('holds again on the watch rather than landing, once the real base is what it diffs against', async () => {
    const store = memoryStore()
    const did: string[] = []

    const first = await once(
      {
        project,
        client: fakeGitHub([], WATCH_AFTER_APPROVAL),
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: true,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts(did, store, true),
    )

    if (first.ok === false) throw new Error(`stopped at ${first.stage}: ${first.detail}`)
    if (first.ok !== 'held') throw new Error('it merged, before anybody approved anything')
    expect(first.step).toBe('proposed')

    const ticketId = ticketStream(PROJECT, 7)
    const wait = waitsOf(await store.read(ticketId)).at(-1)!
    const onSha = first.headSha

    // The run's own base, read the same way `conduct.ts`'s `continuation`
    // computation does — never the approved sha, which is a different
    // commit on this fixture (`provision` cuts at `a`*40, `implement`
    // commits to `b`*40).
    const run = reduceRun(await store.read(first.runId))
    expect(run.baseSha).toBe('a'.repeat(40))
    expect(onSha).not.toBe(run.baseSha)

    // The approval — one `WaitResolved{Approve}`, the same event
    // `resolveWaitHolding` would append.
    const ticketEvents = await store.read(ticketId)
    await store.append(
      ticketId,
      ticketEvents.length,
      aResolution(makeStream(ticketId), wait.waitId, { _tag: 'Approve', onSha }, 'human:steven'),
    )

    const did2: string[] = []
    const second = await once(
      {
        project,
        client: fakeGitHub([], WATCH_AFTER_APPROVAL),
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: true,
        home: '/tmp/fake-home',
        store,
        continuing: { runId: first.runId },
      },
      // The continuation's re-cut: `HEAD` is already the approved sha —
      // nothing dispatches on the way to `proposed`, so it never moves.
      fakePorts(did2, store, true, { at: onSha, implementerCommits: false }),
    )

    // With the fix, `tamper` reads the diff against the run's own base and
    // still sees `src/fix.ts` there, so it holds again rather than letting
    // the lane run. Landing here is exactly the failure scenario #465's
    // blocker finding describes: a gate that exists so an agent cannot
    // weaken its own checks recorded as having cleared a diff it never saw.
    if (second.ok === true) {
      throw new Error('landed — the continuation diffed against the sha it was approved at, not its own base')
    }
    if (second.ok !== 'held') throw new Error(`stopped at ${second.stage}: ${second.detail}`)
    expect(second.step).toBe('proposed')
    expect(did2).not.toContain('integrate')
    expect((await store.read(ticketId)).map((e) => e.type)).not.toContain('TicketLanded')

    const secondReason = waitsOf(await store.read(ticketId)).at(-1)!.reason
    expect(waitWords(secondReason).line).toContain('tamper')
  })
})
