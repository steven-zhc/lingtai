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

import { Standing } from '../src/app/standing.tsx'
import type { OutgoingView } from '../src/lib/prompt.ts'
import { foldRun, standingOf, type Claim, type StandingView } from '../src/lib/task.ts'
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

const render = (fx: WaitFixture, outgoing: OutgoingView | null, extra: Partial<StandingView> = {}) =>
  renderToStaticMarkup(
    <Standing
      subject={null}
      standing={{ ...standingFor(fx), ...extra }}
      project="lingtai"
      issue={1}
      taskId={fx.taskId}
      discussions={[]}
      outgoing={outgoing}
      queued={null}
    />,
  )

/** Just the row of moves. */
const movesOf = (html: string) => html.slice(html.indexOf('class="sresolutiongrid"'), html.indexOf('data-rank="pair"'))
const cardsOf = (html: string) =>
  [...html.matchAll(/<article([^>]*)>(.*?)<\/article>/gs)]
    .map((match) => ({ attrs: match[1] ?? '', body: match[2] ?? '' }))
    .filter(
      ({ attrs, body }) =>
        !attrs.includes('hidden=""') &&
        !attrs.includes('sresolution--draft') &&
        !(attrs.includes('data-resolution="EditBodyAndRequeue"') && body.includes('class="sresolutionaction"></div>')),
    )
    .map(({ attrs }) => attrs.match(/data-resolution="([^"]+)"/)?.[1])

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
      expect(allowedResolutions(reason).includes('EditBodyAndRequeue')).toBe(offered)
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
      // no card for Split until #563 draws its editor
      const allowed = allowedResolutions(standing.reason!).filter((tag) => tag !== 'Split')
      const html = render(fx, null)
      const row = movesOf(html)
      const buttons = buttonsOf(row)
      expect(cardsOf(row)).toEqual(allowed)

      const approveBtn = allowed.includes('Approve') && standing.awaitingSha !== null
      const approveSentence = allowed.includes('Approve') && standing.awaitingSha === null
      const answering = allowed.includes('AnswerQuestion')
      const requeuing = allowed.includes('Requeue')
      const closing = allowed.includes('Close')
      const editingBody = allowed.includes('EditBodyAndRequeue')
      const stepQuestion =
        standing.reason?._tag === 'AgentQuestion' ||
        (standing.reason?._tag === 'ProposedEscalated' && standing.reason.proposal._tag === 'InputNeeded')

      expect(buttons.includes('Approve')).toBe(approveBtn)
      expect(row.includes(SENTENCE)).toBe(approveSentence)
      expect(buttons.includes('Answer')).toBe(answering || stepQuestion)
      expect(buttons.includes('Withdraw')).toBe(answering)
      expect(buttons.includes('Start over from base')).toBe(requeuing)
      expect(buttons.includes('Close')).toBe(closing)
      expect(buttons.includes('Write it into the body &amp; requeue')).toBe(editingBody && !stepQuestion)
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
    expect(buttonsOf(html)).toContain(`Send attempt ${OUTGOING.attempt} from base`)
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

  describe('ContinueConflict (#559)', () => {
    const fx = WAIT_FIXTURES.find((f) => f.name === 'proposedescalated-mergeconflict')!
    const where = { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), ref: 'agent/1', baseBranch: 'main' }
    const row = (line: number) => ({
      path: 'a.ts',
      line,
      question: null,
      suggested: null,
      text: '<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs',
    })
    const moves = (extra: Partial<StandingView>) => movesOf(render(fx, null, extra))

    it('draws the form with base, head and one fieldset per counted hunk, and never a merge button', () => {
      const html = moves({
        conflictWork: { ...where, paths: ['a.ts'], rows: [row(3), row(9)], roundsExhausted: false },
      })
      expect(buttonsOf(html)).toContain('Confirm and continue the conflict')
      expect(buttonsOf(html).join(' ')).not.toMatch(/merge/i)
      expect(html).toContain('a.ts:3')
      expect(html).toContain('a.ts:9')
      expect(html).toContain('No advice for this hunk')
      expect(html).toContain('uses one of the run’s remaining automatic rounds')
      expect(html).toContain('Start over from base')
    })

    it('badges the recommendation and checks nothing, so a choice is always the person’s own click', () => {
      const question = {
        id: 'q',
        text: 'which behavior?',
        answers: [
          { id: 'a', text: 'keep A' },
          { id: 'b', text: 'keep B' },
        ],
        recommended: 'b',
      }
      const html = moves({
        conflictWork: {
          ...where,
          paths: ['a.ts'],
          rows: [
            { ...row(3), question, suggested: { _tag: 'Answer' as const, answerId: 'b' } },
            { ...row(9), suggested: { _tag: 'Mechanical' as const } },
          ],
          roundsExhausted: false,
        },
      })
      expect(html).toContain('Recommended')
      // only the mechanical row triage classed is pre-shown as chosen
      expect(html.match(/checked=""/g)).toHaveLength(1)
      expect(html).toContain('Still to choose: a.ts:3.')
      expect(html).toMatch(/aria-describedby="conflict-unset-[^"]*"/)
      expect(html).toContain('disabled=""')
    })

    it('asks for an expressly granted extra round when the rounds are spent', () => {
      const html = moves({
        conflictWork: { ...where, paths: ['a.ts'], rows: [row(3)], roundsExhausted: true },
      })
      expect(html).toContain('Grant one')
      expect(html).toContain('extra paid round')
    })

    it('draws a refusal in place of the form, with requeue and close still there', () => {
      const html = moves({ conflictWork: { refusal: 'The base moved since this conflict was recorded' } })
      expect(html).toContain('The base moved since this conflict was recorded')
      expect(buttonsOf(html)).not.toContain('Confirm and continue the conflict')
      expect(buttonsOf(html)).toContain('Close')
    })

    it('draws no form for a conflict past one-by-one', () => {
      const html = moves({ conflictWork: { ...where, tooMany: 41 } })
      expect(html).toContain('41 hunks')
      expect(buttonsOf(html)).not.toContain('Confirm and continue the conflict')
      expect(buttonsOf(html)).toContain('Close')
    })
  })
})
