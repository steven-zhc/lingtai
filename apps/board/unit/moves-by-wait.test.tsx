/**
 * #442: the task page's moves row draws exactly the controls
 * `allowedResolutions(standing.reason)` offers, and none it does not.
 *
 * Each wait is `test/waits.ts`'s own fixture — the same events
 * `waiting-card.test.tsx` pins the card against — split by stream (envelopes
 * on the ticket's own stream are `own`, everything else is a run's) and
 * folded through the real `standingOf`/`foldRun` the task page itself reads,
 * then rendered with `<Standing>`. What is pinned here is *which* controls
 * are on the row, checked against `allowedResolutions` directly: a mismatch
 * between what the domain says a wait allows and what the row actually draws
 * is the bug this ticket exists to make impossible.
 */
import type { Envelope } from '@lingtai/domain'
import { WaitReason, allowedResolutions } from '@lingtai/domain/wait'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Standing, movesOf as allowedMoves } from '../src/app/standing.tsx'
import type { OutgoingView } from '../src/lib/prompt.ts'
import { foldRun, standingOf, type Claim } from '../src/lib/task.ts'
import { WAIT_FIXTURES, type WaitFixture } from '../test/waits.ts'

const OUTGOING: OutgoingView = {
  text: '#1 — the ticket\n\nthe body\n',
  version: 'ticket@1',
  basedOn: 'ticket@1',
  attempt: 2,
  edit: null,
  delta: { added: 0, removed: 0 },
  problem: null,
}

/** Envelopes on the ticket's own stream, and every other stream, each a run's. */
function splitByStream(
  taskId: string,
  events: readonly Envelope[],
): { own: Envelope[]; runs: Map<string, Envelope[]> } {
  const own: Envelope[] = []
  const runs = new Map<string, Envelope[]>()
  for (const e of events) {
    if (e.streamId === taskId) {
      own.push(e)
      continue
    }
    const list = runs.get(e.streamId) ?? []
    list.push(e)
    runs.set(e.streamId, list)
  }
  return { own, runs }
}

/** `standingOf`, fed exactly what `loadTask` would fold for this fixture's events. */
function standingFor(fx: WaitFixture) {
  const { own, runs } = splitByStream(fx.taskId, fx.events)
  const folded = [...runs.entries()].map(([runId, events], i) => {
    const claim: Claim = { runId, at: (events[0]?.at ?? new Date(0)).toISOString(), repair: false, released: null }
    return foldRun(claim, i + 1, events)
  })
  return standingOf(own, folded)
}

const render = (fx: WaitFixture, outgoing: OutgoingView | null) =>
  renderToStaticMarkup(
    <Standing
      subject={null}
      standing={standingFor(fx)}
      project="lingtai"
      issue={1}
      taskId={fx.taskId}
      discussions={[]}
      outgoing={outgoing}
      queued={null}
    />,
  )

/** Just the row of moves. */
const movesOf = (html: string) => html.slice(html.indexOf('class="btnrow smoves"'), html.indexOf('class="spair"'))

/** Every `<button>`'s own text, in document order. */
const buttonsOf = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1] ?? '')

const SENTENCE = 'nothing to approve — this run recorded no sha to continue from'

describe('the moves row draws exactly allowedResolutions (#442)', () => {
  it('offers the body edit for the six named wait reasons exactly where allowed', () => {
    for (const [name, offered] of [
      ['agentquestion', true],
      ['fixerdisagrees', true],
      ['proposedescalated-buildred', true],
      ['ownquestion', false],
      ['mergerefused', false],
      ['setuprefused', false],
    ] as const) {
      const fixture = WAIT_FIXTURES.find((f) => f.name === name)!
      const reason = standingFor(fixture).reason!
      expect(allowedMoves(allowedResolutions(reason), null, null).includes('edit-body')).toBe(offered)
    }
  })

  it('pins one fixture per WaitReason tag — a thirteenth variant fails here, not silently', () => {
    const pinned = new Set(WAIT_FIXTURES.map((f) => f.tag))
    const declared = new Set(WaitReason.options.map((o) => o.shape._tag.value))
    expect([...pinned].sort()).toEqual([...declared].sort())
  })

  for (const fx of WAIT_FIXTURES) {
    it(`${fx.tag} — ${fx.name}`, () => {
      const standing = standingFor(fx)
      expect(standing.reason).not.toBeNull()
      const allowed = allowedResolutions(standing.reason!)
      const html = render(fx, null)
      const row = movesOf(html)
      const buttons = buttonsOf(row)

      const approveBtn = allowed.includes('Approve') && standing.awaitingSha !== null
      const approveSentence = allowed.includes('Approve') && standing.awaitingSha === null
      const answering = allowed.includes('AnswerQuestion')
      const requeuing = !answering && allowed.includes('Requeue')
      const closing = allowed.includes('Close')
      const editingBody = allowed.includes('EditBodyAndRequeue')

      expect(buttons.includes('Approve')).toBe(approveBtn)
      expect(row.includes(SENTENCE)).toBe(approveSentence)
      expect(buttons.includes('Answer')).toBe(answering)
      expect(buttons.includes('Withdraw')).toBe(answering)
      expect(buttons.includes('Back to the queue')).toBe(requeuing)
      expect(buttons.includes('Close')).toBe(closing)
      expect(buttons.includes('Write it into the body &amp; requeue')).toBe(editingBody)
      const expectedCount =
        (approveBtn ? 1 : 0) + (answering ? 2 : 0) + (requeuing ? 1 : 0) + (editingBody ? 1 : 0) + (closing ? 1 : 0)
      expect(buttons.length).toBe(expectedCount)
    })
  }

  /**
   * `ProposedEscalated` over `ReviewFindings` allows `Approve`; over `BuildRed`
   * it does not (`wait.ts`'s own table). Both are in `WAIT_FIXTURES` and both
   * run through the loop above — this names the two outcomes explicitly so a
   * future edit that drops one of the two fixtures fails here rather than
   * only in the loop's aggregate count.
   */
  it('draws Approve for ReviewFindings and not for BuildRed, both ProposedEscalated', () => {
    const findings = WAIT_FIXTURES.find((f) => f.name === 'proposedescalated-reviewfindings')!
    const buildRed = WAIT_FIXTURES.find((f) => f.name === 'proposedescalated-buildred')!
    expect(buttonsOf(movesOf(render(findings, null)))).toContain('Approve')
    expect(buttonsOf(movesOf(render(buildRed, null)))).not.toContain('Approve')
  })

  /**
   * A fixture whose wait allows `Requeue` and not `AnswerQuestion`, rendered
   * with a document to send: `Send`, not `Back to the queue`.
   */
  it('draws Send rather than Back to the queue wherever there is a prompt to send', () => {
    const fx = WAIT_FIXTURES.find((f) => f.name === 'checkrefused')!
    const html = movesOf(render(fx, OUTGOING))
    expect(buttonsOf(html)).toContain(`Send attempt ${OUTGOING.attempt}`)
    expect(html).not.toContain('Back to the queue')
  })

  /**
   * `allowedResolutions` drops `Approve` for a run that is `unpushed`
   * (`wait.ts:299-303`), whatever the sha on the wait itself — built as the
   * `signoffrequired` fixture's own events with `unpushed` added to the
   * `WaitStarted` it carries, never a new fixture from scratch.
   */
  it('draws no Approve, and no sentence either, for an unpushed run', () => {
    const base = WAIT_FIXTURES.find((f) => f.name === 'signoffrequired')!
    const unpushed: WaitFixture = {
      ...base,
      events: base.events.map((e) => {
        if (e.type !== 'WaitStarted') return e
        const d = e.data as { waitId: string; reason: { run: { runId: string } } & Record<string, unknown> }
        return {
          ...e,
          data: {
            ...d,
            reason: {
              ...d.reason,
              run: { ...d.reason.run, unpushed: { branch: 'agent/473', said: 'remote rejected the push' } },
            },
          },
        }
      }),
    }
    const standing = standingFor(unpushed)
    expect(standing.awaitingSha).not.toBeNull()
    const html = movesOf(render(unpushed, null))
    expect(buttonsOf(html)).not.toContain('Approve')
    expect(html).not.toContain(SENTENCE)
  })
})
