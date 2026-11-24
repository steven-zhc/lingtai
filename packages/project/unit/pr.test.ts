/**
 * The PR's commands and the draft (0130 §5, #1316), on the memory store.
 */
import { integrationStream, prStream, projectStream, reducePr, ticketStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { EventStore } from '@lingtai/event-store/store'
import type { Recipe } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  landingsInFlight,
  latestPr,
  listPrs,
  readPrDraft,
  recordPrInProgress,
  recordPrRefused,
  recordPrStepDone,
  recordPrWaiting,
  draftTarget,
  openPr,
  readDraft,
  requestPrSubmit,
} from '../src/pr.ts'
import { submitPr } from '../test/submit.ts'

const run = <A>(e: Effect.Effect<A, Error>) => Effect.runPromise(e)

const team = { mode: 'team', branch: { main: 'main', personal: 'lingtai-team' } } as unknown as Recipe
const solo = { branch: { main: 'main', personal: 'lingtai-team' } } as unknown as Recipe

const recipeChanged = (store: EventStore, source: string, version: number) =>
  store.append(projectStream('lingtai'), version, [
    { type: 'ProjectRecipeChanged', actor: 'conductor', data: { sourceHash: `h${version}`, source, by: 'file' } },
  ])

/** One ticket stream: discovered, landed on `base`, and optionally closed afterwards by a person. */
async function landed(store: EventStore, issue: string, base: string, closed = false) {
  await store.append(ticketStream('lingtai', issue), 0, [
    {
      type: 'TicketDiscovered',
      actor: 'conductor',
      data: {
        project: 'lingtai',
        source: 'github-issue',
        externalRef: issue,
        title: `ticket ${issue}`,
        kind: 'bug',
        labels: [],
      },
    },
    { type: 'TicketLanded', actor: 'conductor', data: { mergeCommit: `m${issue}`, base } },
    ...(closed ? [{ type: 'TicketClosed', actor: 'human:steven', data: { by: 'human:steven', reason: 'done' } }] : []),
  ])
}

const frozen = (tickets: { ticket: string; mergeCommit: string; title: string }[]) => ({
  branch: 'lingtai-team',
  main: 'main',
  frozenSha: 'f'.repeat(40),
  tickets,
})

const draftTicket = (ticket: string) => ({
  type: 'PrDraftTicketAdded' as const,
  actor: 'conductor',
  data: { ticket, mergeCommit: `m${ticket}`, from: null },
})
/** A ticket joins PR `n`'s draft, through the stream so the reducer decides the state. */
const addToDraft = async (store: EventStore, n: number, ticket: string) =>
  store.append(prStream('lingtai', n), await store.head(prStream('lingtai', n)), [draftTicket(ticket)])
const heads = async (store: EventStore, upTo = 3) =>
  Promise.all(Array.from({ length: upTo }, (_, i) => store.head(prStream('lingtai', i + 1))))
const close = async (store: EventStore, n: number) =>
  store.append(prStream('lingtai', n), await store.head(prStream('lingtai', n)), [
    { type: 'PrClosed', actor: 'conductor', data: { headSha: 'a'.repeat(40) } },
  ])
/** PR 1 in progress, PR 2 a draft. */
const reviewBelowDraft = async (store: EventStore) => {
  await addToDraft(store, 1, '1')
  await run(requestPrSubmit('lingtai', 'team', 'human:steven', store))
  await run(recordPrInProgress('lingtai', 1, frozen([{ ticket: '1', mergeCommit: 'm1', title: 't' }]), store))
  await addToDraft(store, 2, '2')
}

describe('openPr, draftTarget and readDraft', () => {
  it('no PR at all: nothing open, the draft is number 1 in no state, and it is empty', async () => {
    const store = createMemoryEventStore()
    expect(await run(openPr('lingtai', store))).toBeNull()
    expect(await run(draftTarget('lingtai', store))).toEqual({ n: 1, version: 0, state: null })
    expect(await run(readDraft('lingtai', store))).toEqual([])
  })

  it('a draft above an open PR: the open PR is the one below, the draft is the highest', async () => {
    const store = createMemoryEventStore()
    await reviewBelowDraft(store)
    expect((await run(listPrs('lingtai', store))).map((p) => p.status)).toEqual(['in-progress', 'draft'])
    expect((await run(openPr('lingtai', store)))?.n).toBe(1)
    expect(await run(draftTarget('lingtai', store))).toEqual({ n: 2, version: 1, state: 'draft' })
    expect((await run(readDraft('lingtai', store))).map((t) => t.ticket)).toEqual(['2'])
  })

  it('a draft asked to submit is still the draft stream, and is the open PR; no tickets are readable', async () => {
    const store = createMemoryEventStore()
    await addToDraft(store, 1, '1')
    await run(requestPrSubmit('lingtai', 'team', 'human:steven', store))
    expect(await run(draftTarget('lingtai', store))).toEqual({ n: 1, version: 2, state: 'requested' })
    expect((await run(openPr('lingtai', store)))?.status).toBe('requested')
    expect(await run(readDraft('lingtai', store))).toEqual([])
  })

  it('a highest PR that ended: nothing open, and the draft is the next number', async () => {
    const store = createMemoryEventStore()
    await addToDraft(store, 1, '1')
    await run(requestPrSubmit('lingtai', 'team', 'human:steven', store))
    await close(store, 1)
    expect(await run(openPr('lingtai', store))).toBeNull()
    expect(await run(draftTarget('lingtai', store))).toEqual({ n: 2, version: 0, state: null })
    expect(await run(readDraft('lingtai', store))).toEqual([])
  })
})

describe('requestPrSubmit', () => {
  it('is refused solo, and appends nothing', async () => {
    const store = createMemoryEventStore()
    const answer = await run(requestPrSubmit('lingtai', 'solo', 'human:steven', store))
    expect(answer).toMatchObject({ kind: 'refused', reason: 'solo' })
    expect(await heads(store)).toEqual([0, 0, 0])
  })

  it('is refused nothing-landed with no draft stream, and appends nothing', async () => {
    const store = createMemoryEventStore()
    expect(await run(requestPrSubmit('lingtai', 'team', 'human:steven', store))).toMatchObject({
      kind: 'refused',
      reason: 'nothing-landed',
    })
    expect(await heads(store)).toEqual([0, 0, 0])
  })

  it('appends PrSubmitRequested to the draft stream, and the number does not change', async () => {
    const store = createMemoryEventStore()
    await addToDraft(store, 1, '1')
    expect(await run(requestPrSubmit('lingtai', 'team', 'human:steven', store))).toEqual({ kind: 'requested', n: 1 })
    expect((await store.read(prStream('lingtai', 1))).map((e) => e.type)).toEqual([
      'PrDraftTicketAdded',
      'PrSubmitRequested',
    ])
    expect(await heads(store)).toEqual([2, 0, 0])
  })

  it('is refused open-pr, naming it, while a PR is open below a draft or the draft is requested', async () => {
    const store = createMemoryEventStore()
    await reviewBelowDraft(store)
    const before = await heads(store)
    expect(await run(requestPrSubmit('lingtai', 'team', 'human:steven', store))).toMatchObject({
      kind: 'refused',
      reason: 'open-pr',
      detail: expect.stringContaining('PR 1 of lingtai'),
    })
    expect(await heads(store)).toEqual(before)

    const other = createMemoryEventStore()
    await addToDraft(other, 1, '1')
    await run(requestPrSubmit('lingtai', 'team', 'human:steven', other))
    expect(await run(requestPrSubmit('lingtai', 'team', 'human:steven', other))).toMatchObject({ reason: 'open-pr' })
    expect(await heads(other)).toEqual([2, 0, 0])
  })

  it('numbers past a closed PR: a closed one is not open, and the draft above it is the next number', async () => {
    const store = createMemoryEventStore()
    await addToDraft(store, 1, '1')
    await run(requestPrSubmit('lingtai', 'team', 'human:steven', store))
    await close(store, 1)
    expect(await run(requestPrSubmit('lingtai', 'team', 'human:steven', store))).toMatchObject({
      reason: 'nothing-landed',
    })
    await addToDraft(store, 2, '2')
    expect(await run(requestPrSubmit('lingtai', 'team', 'human:steven', store))).toEqual({ kind: 'requested', n: 2 })
  })

  it('two requests racing produce one PrSubmitRequested', async () => {
    const store = createMemoryEventStore()
    await addToDraft(store, 1, '1')
    const [a, b] = await Promise.all([
      run(requestPrSubmit('lingtai', 'team', 'human:a', store)),
      run(requestPrSubmit('lingtai', 'team', 'human:b', store)),
    ])
    expect([a.kind, b.kind].sort()).toEqual(['refused', 'requested'])
    const events = await store.read(prStream('lingtai', 1))
    expect(events.filter((e) => e.type === 'PrSubmitRequested')).toHaveLength(1)
  })

  it('a landing between the read and the append: the Submit reads again and appends at the new version', async () => {
    const store = createMemoryEventStore()
    await addToDraft(store, 1, '1')
    let landed = false
    const racing: EventStore = {
      ...store,
      append: async (stream, version, events) => {
        if (!landed) {
          landed = true
          await store.append(stream, version, [draftTicket('2')])
        }
        return store.append(stream, version, events)
      },
    }
    expect(await run(requestPrSubmit('lingtai', 'team', 'human:steven', racing))).toEqual({ kind: 'requested', n: 1 })
    expect((await store.read(prStream('lingtai', 1))).map((e) => e.type)).toEqual([
      'PrDraftTicketAdded',
      'PrDraftTicketAdded',
      'PrSubmitRequested',
    ])
  })

  it('does not take a project stream for a PR: prj- and pr- share two letters', async () => {
    const store = createMemoryEventStore()
    await recipeChanged(store, 'mode: team\n', 0)
    expect(await run(listPrs('lingtai', store))).toEqual([])
    expect(await run(latestPr('lingtai', store))).toBeNull()
  })
})

describe('the transitions record each step once', () => {
  it('a step recorded since the latest PrInProgress is answered from the state, and a new freeze starts again', async () => {
    const store = createMemoryEventStore()
    await run(submitPr('lingtai', 'team', 'human:steven', store))
    await run(recordPrInProgress('lingtai', 1, frozen([{ ticket: '1', mergeCommit: 'm1', title: 't' }]), store))
    expect(await run(recordPrStepDone('lingtai', 1, { step: 'build', headSha: 'a'.repeat(40) }, store))).toBe(true)
    expect(await run(recordPrStepDone('lingtai', 1, { step: 'build', headSha: 'a'.repeat(40) }, store))).toBe(false)
    const state = reducePr(await store.read(prStream('lingtai', 1)))
    expect(state.steps).toEqual([{ step: 'build', headSha: 'a'.repeat(40) }])
    expect(state.prBranch).toBe('lingtai-team-pr-1')
    expect(state.target).toBe('f'.repeat(40))
  })

  it('a done step without a headSha does not decode', async () => {
    const store = createMemoryEventStore()
    await expect(
      store.append(prStream('lingtai', 1), 0, [{ type: 'PrStepDone', actor: 'conductor', data: { step: 'build' } }]),
    ).rejects.toThrow()
  })
})

describe('the draft', () => {
  it('holds a ticket landed on branch.personal long ago, and one a person closed after it landed', async () => {
    const store = createMemoryEventStore()
    await recipeChanged(store, 'mode: team\n', 0)
    await landed(store, '1', 'lingtai-team')
    await landed(store, '2', 'lingtai-team', true)
    await landed(store, '3', 'main')
    const draft = await run(readPrDraft('lingtai', team, [{ issue: '1' }, { issue: '2' }, { issue: '3' }], store))
    expect(draft.map((t) => t.ticket)).toEqual(['1', '2'])
    expect(draft[0]).toMatchObject({ mergeCommit: 'm1', title: 'ticket 1' })
  })

  it('does not hold a ticket that landed on the same branch name while the project was solo', async () => {
    const store = createMemoryEventStore()
    await recipeChanged(store, 'mode: solo\n', 0)
    await landed(store, '1', 'lingtai-team')
    await recipeChanged(store, 'mode: team\n', 1)
    await landed(store, '2', 'lingtai-team')
    const draft = await run(readPrDraft('lingtai', team, [{ issue: '1' }, { issue: '2' }], store))
    expect(draft.map((t) => t.ticket)).toEqual(['2'])
  })

  it('is empty in a solo project', async () => {
    const store = createMemoryEventStore()
    await landed(store, '1', 'lingtai-team')
    expect(await run(readPrDraft('lingtai', solo, [{ issue: '1' }], store))).toEqual([])
  })

  it('leaves out what a PR holds, and holds what a refused PR was asked for', async () => {
    const store = createMemoryEventStore()
    await recipeChanged(store, 'mode: team\n', 0)
    await landed(store, '1', 'lingtai-team')
    await landed(store, '2', 'lingtai-team')
    await run(submitPr('lingtai', 'team', 'human:steven', store))
    await run(recordPrInProgress('lingtai', 1, frozen([{ ticket: '1', mergeCommit: 'm1', title: 't' }]), store))
    const open = await run(readPrDraft('lingtai', team, [{ issue: '1' }, { issue: '2' }], store))
    expect(open.map((t) => t.ticket)).toEqual(['2'])
  })

  it('a ticket held by a refused PR is in the draft', async () => {
    const store = createMemoryEventStore()
    await recipeChanged(store, 'mode: team\n', 0)
    await landed(store, '1', 'lingtai-team')
    await run(submitPr('lingtai', 'team', 'human:steven', store))
    await run(recordPrRefused('lingtai', 1, { reason: 'git', detail: 'x' }, store))
    expect((await run(readPrDraft('lingtai', team, [{ issue: '1' }], store))).map((t) => t.ticket)).toEqual(['1'])
  })
})

describe('landings in flight', () => {
  const lane = integrationStream('lingtai', 'lingtai-team')
  const discovered = (store: EventStore, issue: string) =>
    store.append(ticketStream('lingtai', issue), 0, [
      {
        type: 'TicketDiscovered',
        actor: 'conductor',
        data: { project: 'lingtai', source: 'github-issue', externalRef: issue, title: 't', kind: 'bug', labels: [] },
      },
    ])
  const attempted = (store: EventStore, issue: string, version: number) =>
    store.append(lane, version, [
      {
        type: 'IntegrationAttempted',
        actor: 'conductor',
        data: { ticketId: ticketStream('lingtai', issue), branch: 'b', headSha: 'h' },
      },
    ])

  it('an unexpected refusal may be a push whose record failed: it stays owed whatever becomes of the ticket', async () => {
    const store = createMemoryEventStore()
    await discovered(store, '2')
    await attempted(store, '2', 0)
    await store.append(lane, 1, [
      {
        type: 'IntegrationRefused',
        actor: 'conductor',
        data: { ticketId: ticketStream('lingtai', '2'), branch: 'b', reason: 'unexpected', detail: 'log down' },
      },
    ])
    const owed = [{ ticketId: ticketStream('lingtai', '2'), headSha: 'h' }]
    expect(await run(landingsInFlight('lingtai', 'lingtai-team', store))).toEqual(owed)
    // Closing a ticket does not take back what was pushed: git, not the lifecycle, says whether it is in the commit.
    await store.append(ticketStream('lingtai', '2'), 1, [
      { type: 'TicketClosed', actor: 'human:steven', data: { by: 'human:steven', reason: 'done' } },
    ])
    expect(await run(landingsInFlight('lingtai', 'lingtai-team', store))).toEqual(owed)
  })

  it('an attempt nobody finished stays owed after its ticket is released, carrying the head git is asked about', async () => {
    const store = createMemoryEventStore()
    await discovered(store, '3')
    await attempted(store, '3', 0)
    await store.append(ticketStream('lingtai', '3'), 1, [
      { type: 'TicketReleased', actor: 'conductor', data: { runId: 'r', reason: 'restart', cause: null } },
    ])
    expect(await run(landingsInFlight('lingtai', 'lingtai-team', store))).toEqual([
      { ticketId: ticketStream('lingtai', '3'), headSha: 'h' },
    ])
  })

  it('an earlier push whose terminals were lost stays owed after the retry is refused no-commits', async () => {
    const store = createMemoryEventStore()
    await discovered(store, '4')
    const ticketId = ticketStream('lingtai', '4')
    await attempted(store, '4', 0)
    await store.append(lane, 1, [
      { type: 'IntegrationAttempted', actor: 'conductor', data: { ticketId, branch: 'b', headSha: 'h' } },
      {
        type: 'IntegrationRefused',
        actor: 'conductor',
        data: { ticketId, branch: 'b', reason: 'no-commits', detail: 'x' },
      },
    ])
    expect(await run(landingsInFlight('lingtai', 'lingtai-team', store))).toEqual([{ ticketId, headSha: 'h' }])
  })

  it('two earlier pushes both stay owed when a later attempt fails unexpectedly', async () => {
    const store = createMemoryEventStore()
    await discovered(store, '5')
    const ticketId = ticketStream('lingtai', '5')
    const attempt = (headSha: string) => ({
      type: 'IntegrationAttempted',
      actor: 'conductor',
      data: { ticketId, branch: 'b', headSha },
    })
    await store.append(lane, 0, [
      attempt('h1'),
      attempt('h2'),
      {
        type: 'IntegrationRefused',
        actor: 'conductor',
        data: { ticketId, branch: 'b', reason: 'unexpected', detail: 'x' },
      },
    ])
    const owed = await run(landingsInFlight('lingtai', 'lingtai-team', store))
    expect(owed.map((o) => o.headSha).sort()).toEqual(['h1', 'h2'])
  })
})
