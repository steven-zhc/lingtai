/**
 * **The path `conduct-continuation-remembers-every-waiver.test.ts` does not
 * reach** (#465's blocker finding, fix round 3). That file's `tamper` has no
 * `then:`, so it defaults to `then: request-approval` and yields `signoff` —
 * a `SignoffRequired` wait, which already carries its own `action` directly
 * (`WaitReason.SignoffRequired.action`) and never touches `continuationOf`'s
 * `ProposedEscalated{CheckRefused}` branch at all. The finding's own note:
 * *"the diff's own `conduct-continuation-remembers-every-waiver.test.ts`
 * passes only because a bare `watch:` defaults to `then: request-approval`,
 * which yields `signoff` … and never consults `runOutcomes`."*
 *
 * Two `watch:` actions with `then: fail` both yield `verdict`, so a refusal
 * routes through `pass-next.ts`'s `checkRefused` and — with no judge
 * declared — the router escalates by default as
 * `ProposedEscalated{CheckRefused}`, the proposal that used to carry no
 * action name of its own. Before #465's fix, `continuationOf` re-derived one
 * from the run's own *last* `StepEnded` at `proposed`, read fresh every time
 * a continuation asked — so the first approval's own waiver read correctly
 * on the lap right after it, but by the third lap (both checks approved) the
 * first wait's name had drifted to whichever check decided the *second*
 * visit, and `checkA` ran again unwaived, refusing on the identical diff
 * forever: the alternating-cards loop the finding describes verbatim.
 *
 * Unit by [0060](../../../doc/decisions-archive/0060-the-gate-runs-unit-tests.md) §1:
 * no process, no socket, no network. The fixtures are `test/one-pass.ts`,
 * the same harness `conduct-continuation-remembers-every-waiver.test.ts` uses.
 */
import { waitsOf, ticketStream } from '@lingtai/domain'
import { aResolution } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { describe, expect, it } from 'vitest'

import { fakeGitHub, fakePorts, memoryStore, once, project, runtime, PROJECT } from '../test/one-pass.ts'

/** `checkA` before `checkB` — the pipeline stops at the first refusal, so `checkB` is never reached this lap. */
const TWO_CHECKS_REFUSE_AT_PROPOSED = `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps:
  proposed:
    - name: checkA
      watch: ["src/fix.ts"]
      then: fail
    - name: checkB
      watch: ["src/fix.ts"]
      then: fail
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`

describe('a continuation never forgets a ProposedEscalated{CheckRefused} waiver an earlier approval already granted', () => {
  it('clears both checks once both have been approved, rather than alternating between them forever', async () => {
    const store = memoryStore()
    const ticketId = ticketStream(PROJECT, 7)

    // Lap 1: a fresh pass. `checkA` refuses first, so `checkB` is never
    // reached this lap, and with no judge declared the router escalates by
    // default — `ProposedEscalated{CheckRefused}`, naming `checkA`.
    const first = await once(
      {
        project,
        client: fakeGitHub([], TWO_CHECKS_REFUSE_AT_PROPOSED),
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
    expect(wait1.reason).toMatchObject({
      _tag: 'ProposedEscalated',
      proposal: { _tag: 'CheckRefused', action: 'checkA' },
    })

    // Approve the first wait — only `checkA`'s.
    await store.append(
      ticketId,
      (await store.read(ticketId)).length,
      aResolution(makeStream(ticketId), wait1.waitId, { _tag: 'Approve', onSha }, 'human:steven'),
    )

    // Lap 2: the continuation. `checkA` is waived, so `checkB` is reached
    // and refuses in its turn — a *different* wait than lap 1's, naming
    // `checkB`.
    const second = await once(
      {
        project,
        client: fakeGitHub([], TWO_CHECKS_REFUSE_AT_PROPOSED),
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
    expect(wait2.reason).toMatchObject({
      _tag: 'ProposedEscalated',
      proposal: { _tag: 'CheckRefused', action: 'checkB' },
    })

    // Approve the second wait — `checkB`'s.
    await store.append(
      ticketId,
      (await store.read(ticketId)).length,
      aResolution(makeStream(ticketId), wait2.waitId, { _tag: 'Approve', onSha }, 'human:steven'),
    )

    // Lap 3: the finding's own failure scenario. Both `checkA` and `checkB`
    // have now each been granted their own approval. Before the fix,
    // `wait1`'s own waiver name had already drifted — recomputed at this
    // call, off the run's own *last* visit to `proposed`, which by now is
    // `checkB`'s — so `waivedActionsAt` returned `checkB` twice and `checkA`
    // ran again unwaived, refusing on the identical diff: `CheckRefused`
    // held at `proposed` forever, the alternating cards the finding
    // describes. With the fix, each wait's own proposal already names the
    // check it was about, so both come back and the pass lands.
    const third = await once(
      {
        project,
        client: fakeGitHub([], TWO_CHECKS_REFUSE_AT_PROPOSED),
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
        `held again at ${third.step} — a continuation forgot a ProposedEscalated{CheckRefused} waiver an ` +
          "earlier approval already granted, the alternating-cards loop #465's blocker finding describes",
      )
    }
    expect(third.ok).toBe(true)
    expect((await store.read(ticketId)).map((e) => e.type)).toContain('TicketLanded')
  })
})
