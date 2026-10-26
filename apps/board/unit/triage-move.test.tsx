/**
 * #647. A waiting card carries triage's advised resolution as one button, and
 * only triage's: a wait's own default orders the task page's cards and is not a
 * recommendation.
 */
import { approveHolding } from '@lingtai/conductor/decide'
import { reduceTicket, ticketStream, waitsOf, type WaitId } from '@lingtai/domain'
import { aClaim, aRunRef, aWait } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { acceptedTriageNote, type Resolution, type WaitReason } from '@lingtai/domain/wait'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { TaskCard } from '@lingtai/projector/task-view'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { TriageMove } from '../src/app/decide.tsx'
import { toCard, triageContextOf, type BoardCard } from '../src/lib/board.ts'

const waitId = 'wait-647' as WaitId
const SHA = 'b'.repeat(40)
const HEAD = 'c'.repeat(40)
const daemon = { startedAt: new Date('2026-10-20T12:00:00Z') }

const checkRefused = {
  _tag: 'CheckRefused',
  run: aRunRef('run-647'),
  step: 'build',
  action: 'test',
  evidence: 'two tests red',
  findings: [],
} as unknown as WaitReason

function result(resolution: Resolution['_tag'], cause = 'FixableLines'): TaskCard['triage'] {
  return {
    started: null,
    result: {
      _tag: 'TriageAdvised',
      cause: { _tag: cause, lines: [] },
      resolution,
      summary: 'the sentence <triage> wrote',
      want: null,
    } as unknown as NonNullable<TaskCard['triage']['result']>,
  }
}

function waiting(triage: TaskCard['triage'], reason: WaitReason = checkRefused, awaitingSha: string | null = SHA) {
  return {
    taskId: 'ticket-lingtai-647',
    project: 'lingtai',
    issue: '647',
    title: 'a waiting card',
    kind: 'feature',
    state: 'waiting',
    tier: 'guarded',
    runId: 'run-647',
    turns: null,
    passed: 0,
    failed: 0,
    waived: 0,
    approved: 0,
    baseSha: null,
    headSha: null,
    files: null,
    insertions: null,
    deletions: null,
    note: null,
    updatedAt: new Date('2026-10-20T00:00:00Z'),
    closedAt: null,
    attempts: 1,
    restarts: 0,
    restartsOf: 0,
    lastAttemptAt: null,
    awaitingSha,
    awaitingApproval: false,
    wait: { waitId, reason },
    answer: null,
    split: null,
    triage,
    triageHeadSha: null,
    repairPending: false,
  } as TaskCard
}

function card(t: TaskCard, fixHead: string | null = HEAD, declared = true): BoardCard {
  return toCard(t, null, null, null, null, undefined, undefined, triageContextOf(declared, daemon), fixHead)
}

describe('a card’s move', () => {
  it('carries the saved head for an advised GrantFixRound', () => {
    expect(card(waiting(result('GrantFixRound'))).move).toEqual({
      resolution: 'GrantFixRound',
      onSha: HEAD,
      note: null,
    })
  })

  it('has no GrantFixRound where the log has no saved head, and swaps nothing in', () => {
    expect(card(waiting(result('GrantFixRound')), null).move).toBeNull()
  })

  it('carries an advised Requeue with nothing to send', () => {
    expect(card(waiting(result('Requeue'))).move).toEqual({ resolution: 'Requeue', onSha: null, note: null })
  })

  it('carries the awaited sha and the accepted-triage note for an advised Approve', () => {
    expect(card(waiting(result('Approve', 'Other'))).move).toEqual({
      resolution: 'Approve',
      onSha: SHA,
      note: "accepted triage's recommendation: the sentence <triage> wrote",
    })
    expect(card(waiting(result('Approve', 'Other'), checkRefused, null)).move).toBeNull()
  })

  it('pins the note', () => {
    expect(acceptedTriageNote(' one sentence. ')).toBe("accepted triage's recommendation: one sentence.")
  })

  it('is absent for every triage status but Advised, though the wait has a default', () => {
    expect(card(waiting({ started: null, result: null })).move).toBeNull()
    expect(
      card(waiting({ started: { attempt: 1, at: new Date('2026-10-20T13:00:00Z') }, result: null })).move,
    ).toBeNull()
    expect(
      card(waiting({ started: { attempt: 1, at: new Date('2026-10-20T11:00:00Z') }, result: null })).move,
    ).toBeNull()
    expect(
      card(waiting({ started: null, result: { _tag: 'TriageFailed', why: 'x' } as TaskCard['triage']['result'] })).move,
    ).toBeNull()
    expect(card(waiting(result('Requeue')), HEAD, false).move).not.toBeNull()
    expect(card(waiting({ started: null, result: null }), HEAD, false).move).toBeNull()
  })

  it('is absent for advice the wait does not allow', () => {
    expect(card(waiting(result('Split'))).move).toBeNull()
  })
})

describe('the button', () => {
  const props = { project: 'lingtai', issue: 647, taskId: 'ticket-lingtai-647', waitId }

  it.each([
    ['EditBodyAndRequeue', 'resolution-EditBodyAndRequeue'],
    ['AnswerQuestion', 'resolution-AnswerQuestion'],
    ['Close', 'resolution-Close'],
    ['Split', 'triage'],
  ] as const)('%s opens the task page and is not a button', (resolution, anchor) => {
    const html = renderToStaticMarkup(<TriageMove {...props} move={{ resolution, onSha: null, note: null }} />)
    expect(html).toContain(`href="/task/ticket-lingtai-647#${anchor}"`)
    expect(html).not.toContain('<button')
  })

  it.each(['GrantFixRound', 'Requeue', 'Approve'] as const)('%s is one button', (resolution) => {
    const html = renderToStaticMarkup(
      <TriageMove {...props} move={{ resolution, onSha: SHA, note: resolution === 'Approve' ? 'n' : null }} />,
    )
    expect(html).toContain('<button')
    expect(html).not.toContain('href=')
  })
})

describe('a stale card', () => {
  it('refuses the approve it posts, note and all, once the wait has moved', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream('lingtai', 647)
    const item = makeStream(ticketId)
    const signoff = (question: string) =>
      ({
        _tag: 'SignoffRequired',
        run: aRunRef('pass-647'),
        step: 'proposed',
        action: 'unfixed',
        question,
      }) as const
    const seed = async (events: Parameters<typeof store.append>[2]) =>
      store.append(ticketId, (await store.read(ticketId)).length, events)
    await seed([...aClaim(item, 'pass-647'), ...aWait(item, signoff('first?'))])
    const shown = waitsOf(await store.read(ticketId)).at(-1)!.waitId
    await seed(aWait(item, signoff('second?')))
    const current = waitsOf(await store.read(ticketId)).at(-1)!.waitId
    expect(current).not.toBe(shown)

    const stale = await approveHolding(
      {
        project: 'lingtai',
        issue: 647,
        by: 'human:steven',
        waitId: shown,
        onSha: SHA,
        note: acceptedTriageNote('a sentence'),
        client: { refSha: async () => SHA },
        store,
      },
      ticketId,
    )
    expect(stale).toMatchObject({ ok: false, reason: 'stale' })
    expect(reduceTicket(await store.read(ticketId)).lifecycle).toMatchObject({ status: 'blocked', waitId: current })
  })
})
