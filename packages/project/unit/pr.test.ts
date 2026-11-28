/**
 * The PR's commands and the draft (0130 §5, #1316), on the memory store.
 */
import {
  type Envelope,
  type PrState,
  integrationStream,
  prStream,
  projectStream,
  reducePr,
  reduceProject,
  ticketStream,
} from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { ConcurrencyError, type EventStore } from '@lingtai/event-store/store'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  draftBatchFor,
  landingsInFlight,
  latestPr,
  listPrs,
  readDraftTickets,
  READ_CONCURRENCY,
  readUnheldFixLandings,
  recordPrInProgress,
  recordPrStepDone,
  draftTarget,
  openPr,
  readDraft,
  readDraftedTickets,
  readPr,
  requestPrSubmit,
} from '../src/pr.ts'
import { recordPrNumber } from '../test/pr-numbers.ts'
import { submitPr } from '../test/submit.ts'

const run = <A>(e: Effect.Effect<A, Error>) => Effect.runPromise(e)

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
  prBranch: 'lingtai-team-pr-1',
  tickets,
})

const draftTicket = (ticket: string) => ({
  type: 'PrDraftTicketAdded' as const,
  actor: 'conductor',
  data: { ticket, mergeCommit: `m${ticket}`, from: null },
})
/** A ticket joins PR `n`'s draft, through the stream so the reducer decides the state. */
const addToDraft = async (store: EventStore, n: number, ticket: string) => {
  await store.append(prStream('lingtai', n), await store.head(prStream('lingtai', n)), [draftTicket(ticket)])
  await recordPrNumber(store, 'lingtai', n)
}
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

  it('a PR read early that moves while a later one is read: the Submit reads again and is refused open-pr', async () => {
    const store = createMemoryEventStore()
    await addToDraft(store, 1, '1')
    let moved = false
    const racing: EventStore = {
      ...store,
      read: async (stream, ...rest) => {
        const events = await store.read(stream, ...rest)
        if (!moved && stream === prStream('lingtai', 1)) {
          moved = true
          // Another Submit, the freeze and a landing into a new draft, all after PR 1 was read as a draft.
          await run(requestPrSubmit('lingtai', 'team', 'human:b', store))
          await run(recordPrInProgress('lingtai', 1, frozen([{ ticket: '1', mergeCommit: 'm1', title: 't' }]), store))
          await addToDraft(store, 2, '2')
        }
        return events
      },
    }
    expect(await run(requestPrSubmit('lingtai', 'team', 'human:a', racing))).toMatchObject({
      kind: 'refused',
      reason: 'open-pr',
    })
    expect(await store.head(prStream('lingtai', 2))).toBe(1)
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

/** A store whose `read` and `head` record the stream they were asked for. */
function countingStore() {
  const inner = createMemoryEventStore()
  const asked = new Set<string>()
  const store: EventStore = Object.create(inner, {
    read: {
      value: (id: string, ...rest: unknown[]) => {
        asked.add(id)
        return (inner.read as (...a: unknown[]) => Promise<Envelope[]>)(id, ...rest)
      },
    },
    head: {
      value: (id: string) => {
        asked.add(id)
        return inner.head(id)
      },
    },
  })
  return { store, inner, asked }
}

describe('the draft (#1395)', () => {
  it('holds the tickets on the draft PR stream, each with its own title, in the order they joined', async () => {
    const store = createMemoryEventStore()
    await landed(store, '2', 'lingtai-team')
    await landed(store, '1', 'lingtai-team', true)
    await addToDraft(store, 1, '2')
    await addToDraft(store, 1, '1')
    const draft = await run(readDraftTickets('lingtai', store))
    expect(draft.map((t) => t.ticket)).toEqual(['2', '1'])
    expect(draft[0]).toMatchObject({ mergeCommit: 'm2', title: 'ticket 2' })
  })

  it('names a ticket with no title by its issue', async () => {
    const store = createMemoryEventStore()
    await addToDraft(store, 1, '7')
    expect((await run(readDraftTickets('lingtai', store)))[0]).toMatchObject({ ticket: '7', title: '#7' })
  })

  it('is empty when the highest PR is requested, and holds nothing a PR holds', async () => {
    const store = createMemoryEventStore()
    await addToDraft(store, 1, '1')
    await run(requestPrSubmit('lingtai', 'team', 'human:steven', store))
    expect(await run(readDraftTickets('lingtai', store))).toEqual([])
    await run(recordPrInProgress('lingtai', 1, frozen([{ ticket: '1', mergeCommit: 'm1', title: 't' }]), store))
    await addToDraft(store, 2, '2')
    expect((await run(readDraftTickets('lingtai', store))).map((t) => t.ticket)).toEqual(['2'])
  })

  it('reads the PR streams and the two draft tickets, and no other of fifty landed ones', async () => {
    const { store, inner, asked } = countingStore()
    for (let i = 1; i <= 50; i++) await landed(inner, String(i), 'lingtai-team')
    await addToDraft(inner, 1, '7')
    await addToDraft(inner, 1, '31')
    const draft = await run(readDraftTickets('lingtai', store))
    expect(draft.map((t) => t.ticket)).toEqual(['7', '31'])
    const tickets = [...asked].filter((id) => id.startsWith('ticket-')).sort()
    expect(tickets).toEqual([ticketStream('lingtai', '31'), ticketStream('lingtai', '7')].sort())
    expect(
      [...asked]
        .filter((id) => !id.startsWith('ticket-'))
        .every((id) => id.startsWith('pr-lingtai-') || id === projectStream('lingtai')),
    ).toBe(true)
  })

  it('reads the tickets together, at most READ_CONCURRENCY at once, and returns them in the order they joined', async () => {
    const inner = createMemoryEventStore()
    for (let i = 1; i <= 20; i++) await addToDraft(inner, 1, String(i))
    const serial = await run(readDraftTickets('lingtai', inner))
    let inFlight = 0
    let most = 0
    // Later tickets wait fewer turns, so they finish first.
    const store: EventStore = Object.create(inner, {
      read: {
        value: async (id: string) => {
          if (!id.startsWith('ticket-')) return inner.read(id)
          inFlight++
          most = Math.max(most, inFlight)
          for (let i = 0; i < 40 - Number(id.split('-').pop()); i++) await Promise.resolve()
          inFlight--
          return inner.read(id)
        },
      },
    })
    const draft = await run(readDraftTickets('lingtai', store))
    expect(draft).toEqual(serial)
    expect(draft.map((t) => t.ticket)).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)))
    expect(most).toBeGreaterThan(1)
    expect(most).toBeLessThanOrEqual(READ_CONCURRENCY)
  })

  it('fails when a ticket stream cannot be read: never an empty draft', async () => {
    const inner = createMemoryEventStore()
    await addToDraft(inner, 1, '1')
    const store: EventStore = Object.create(inner, {
      read: {
        value: (id: string) => (id.startsWith('ticket-') ? Promise.reject(new Error('boom')) : inner.read(id)),
      },
    })
    await expect(run(readDraftTickets('lingtai', store))).rejects.toThrow('boom')
  })
})

describe('readUnheldFixLandings (#1395)', () => {
  const branch = 'lingtai-team-pr-1'
  const lane = integrationStream('lingtai', branch)
  const prWith = (tickets: string[]) =>
    ({ prBranch: branch, tickets: tickets.map((ticket) => ({ ticket })) }) as unknown as PrState
  const onLane = (
    store: EventStore,
    issue: string,
    type: 'IntegrationAttempted' | 'IntegrationSucceeded' | 'IntegrationRefused',
  ) =>
    store.head(lane).then((v) =>
      store.append(lane, v, [
        {
          type,
          actor: 'conductor',
          data:
            type === 'IntegrationAttempted'
              ? { ticketId: ticketStream('lingtai', issue), branch: 'b', headSha: `h${issue}` }
              : type === 'IntegrationSucceeded'
                ? { ticketId: ticketStream('lingtai', issue), branch: 'b', base: branch, mergeCommit: `m${issue}` }
                : { ticketId: ticketStream('lingtai', issue), branch: 'b', reason: 'no-commits', detail: 'x' },
        },
      ] as never),
    )

  it('reads only the tickets the PR branch lane names', async () => {
    const { store, inner, asked } = countingStore()
    for (let i = 1; i <= 20; i++) await landed(inner, String(i), branch)
    await onLane(inner, '4', 'IntegrationSucceeded')
    await onLane(inner, '9', 'IntegrationSucceeded')
    const owed = await run(readUnheldFixLandings('lingtai', prWith(['9']), store))
    expect(owed.map((o) => o.ticket)).toEqual(['4'])
    expect([...asked].filter((id) => id.startsWith('ticket-')).sort()).toEqual([ticketStream('lingtai', '4')])
  })

  it('still finds a ticket that landed on the branch and was later refused again', async () => {
    const store = createMemoryEventStore()
    await landed(store, '4', branch)
    await onLane(store, '4', 'IntegrationSucceeded')
    await onLane(store, '4', 'IntegrationAttempted')
    await onLane(store, '4', 'IntegrationRefused')
    const owed = await run(readUnheldFixLandings('lingtai', prWith([]), store))
    expect(owed.map((o) => o.ticket)).toEqual(['4'])
  })

  it('skips a ticket that was refused and never landed there, and one in flight', async () => {
    const store = createMemoryEventStore()
    await landed(store, '5', 'main')
    await onLane(store, '5', 'IntegrationRefused')
    await landed(store, '6', 'main')
    await onLane(store, '6', 'IntegrationAttempted')
    expect(await run(readUnheldFixLandings('lingtai', prWith([]), store))).toEqual([])
  })

  it('has nothing for a PR with no branch', async () => {
    const store = createMemoryEventStore()
    expect(
      await run(readUnheldFixLandings('lingtai', { prBranch: null, tickets: [] } as unknown as PrState, store)),
    ).toEqual([])
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

describe('readDraftedTickets (#1423)', () => {
  it('a ticket that joined a draft stays found once the PR is in progress, which empties its draft', async () => {
    const store = createMemoryEventStore()
    await reviewBelowDraft(store)
    expect((await run(readDraft('lingtai', store))).map((t) => t.ticket)).toEqual(['2'])
    expect([...(await run(readDraftedTickets('lingtai', store)))].sort()).toEqual(['1', '2'])
  })

  it('a PR merged still counts; a PR closed without merging does not', async () => {
    const store = createMemoryEventStore()
    await reviewBelowDraft(store)
    await store.append(prStream('lingtai', 1), await store.head(prStream('lingtai', 1)), [
      {
        type: 'PrMerged',
        actor: 'conductor',
        data: { how: 'host', headSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40) },
      },
    ])
    expect((await run(listPrs('lingtai', store))).map((p) => p.status)).toEqual(['merged', 'draft'])
    expect([...(await run(readDraftedTickets('lingtai', store)))].sort()).toEqual(['1', '2'])

    const closed = createMemoryEventStore()
    await reviewBelowDraft(closed)
    await close(closed, 1)
    expect([...(await run(readDraftedTickets('lingtai', closed)))]).toEqual(['2'])
  })

  it('a pr-fix landing is a ticket of the PR and not of the personal branch', async () => {
    const store = createMemoryEventStore()
    await reviewBelowDraft(store)
    await store.append(prStream('lingtai', 1), await store.head(prStream('lingtai', 1)), [
      { type: 'PrFixLanded', actor: 'conductor', data: { ticket: '9', mergeCommit: 'm9', title: 'fix' } },
    ])
    expect((await run(readPr('lingtai', 1, store)))?.tickets.map((t) => t.ticket)).toContain('9')
    expect([...(await run(readDraftedTickets('lingtai', store)))].sort()).toEqual(['1', '2'])
  })

  it('a pr-fix whose merge back reached the personal branch is found, though the PR is still open', async () => {
    const store = createMemoryEventStore()
    await reviewBelowDraft(store)
    await store.append(prStream('lingtai', 1), await store.head(prStream('lingtai', 1)), [
      { type: 'PrFixLanded', actor: 'conductor', data: { ticket: '9', mergeCommit: 'm9', title: 'fix' } },
    ])
    await store.append(prStream('lingtai', 1), await store.head(prStream('lingtai', 1)), [
      { type: 'PrMergedBack', actor: 'conductor', data: { prHead: 'm9', mergeCommit: 'mb', how: 'clean' } },
    ])
    expect((await run(readPr('lingtai', 1, store)))?.mergedBackTickets).toContain('9')
    expect([...(await run(readDraftedTickets('lingtai', store)))].sort()).toEqual(['1', '2', '9'])
  })

  it('no PR at all: nothing drafted', async () => {
    expect([...(await run(readDraftedTickets('lingtai', createMemoryEventStore())))]).toEqual([])
  })

  it('reads the PR streams together, at most READ_CONCURRENCY at once, and finds what a serial read finds (#1509)', async () => {
    const inner = createMemoryEventStore()
    await reviewBelowDraft(inner)
    await recordPrNumber(inner, 'lingtai', 9)
    const serial = [...(await run(readDraftedTickets('lingtai', inner)))].sort()
    let inFlight = 0
    let most = 0
    const store: EventStore = Object.create(inner, {
      read: {
        value: async (id: string) => {
          if (!id.startsWith('pr-lingtai-')) return inner.read(id)
          inFlight++
          most = Math.max(most, inFlight)
          for (let i = 0; i < 10; i++) await Promise.resolve()
          inFlight--
          return inner.read(id)
        },
      },
    })
    expect([...(await run(readDraftedTickets('lingtai', store)))].sort()).toEqual(serial)
    expect(serial).toEqual(['1', '2'])
    expect(most).toBeGreaterThan(1)
    expect(most).toBeLessThanOrEqual(READ_CONCURRENCY)
  })

  it('fails when one PR stream cannot be read: never a partial set (#1509)', async () => {
    const inner = createMemoryEventStore()
    await reviewBelowDraft(inner)
    await recordPrNumber(inner, 'lingtai', 9)
    const store: EventStore = Object.create(inner, {
      read: {
        value: (id: string) => (id === prStream('lingtai', 5) ? Promise.reject(new Error('boom')) : inner.read(id)),
      },
    })
    await expect(run(readDraftedTickets('lingtai', store))).rejects.toThrow('boom')
  })
})

/** A store that remembers which streams `head` was asked about. */
const headCounting = (inner: EventStore) => {
  const heads: string[] = []
  const store: EventStore = {
    ...inner,
    head: async (id) => {
      heads.push(id)
      return inner.head(id)
    },
  }
  return { store, heads, probes: () => heads.filter((id) => id.startsWith('pr-')) }
}

/** A PR stream built by hand with one draft ticket, and nothing recorded on the project. */
const unrecorded = async (store: EventStore, n: number, tickets: string[], ending?: 'merged') => {
  await store.append(
    prStream('lingtai', n),
    0,
    tickets.map((t) => draftTicket(t)),
  )
  if (ending === 'merged') {
    const at = await store.head(prStream('lingtai', n))
    await store.append(prStream('lingtai', n), at, [
      { type: 'PrSubmitRequested', actor: 'human:steven', data: { by: 'human:steven' } },
      {
        type: 'PrInProgress',
        actor: 'conductor',
        data: { ...frozen(tickets.map((t) => ({ ticket: t, mergeCommit: `m${t}`, title: t }))), because: 'submit' },
      },
      {
        type: 'PrMerged',
        actor: 'conductor',
        data: { how: 'host', headSha: 'f'.repeat(40), mergeSha: 'c'.repeat(40) },
      },
    ] as never)
  }
}
const types = async (store: EventStore, id: string) => (await store.read(id)).map((e) => e.type)

describe('the project records its PRs’ numbers (#1446)', () => {
  it('a landing into a project with no record probes once and records the highest it found', async () => {
    const inner = createMemoryEventStore()
    for (const n of [1, 2, 3]) await unrecorded(inner, n, [String(n)], n < 3 ? 'merged' : undefined)
    const { store, probes } = headCounting(inner)
    // A reader sees no PRs, and never probes to look.
    expect(await run(listPrs('lingtai', store))).toEqual([])
    expect(await run(openPr('lingtai', store))).toBeNull()
    expect([...(await run(readDraftedTickets('lingtai', store)))]).toEqual([])
    expect(probes()).toEqual([])
    // A writer neither starts at 1 nor collides: PR 3 is the draft, and the highest, 3, is recorded with it.
    const batches = await run(draftBatchFor('lingtai', { ticket: '9', mergeCommit: 'm9', from: null }, store))
    expect(probes()).toEqual([1, 2, 3, 4].map((n) => prStream('lingtai', n)))
    expect(batches.map((b) => b.streamId)).toEqual([prStream('lingtai', 3), projectStream('lingtai')])
    expect(batches[1]!.events).toMatchObject([{ type: 'ProjectPrNumbered', data: { n: 3 } }])
    await store.appendAll(batches)
    expect((await run(listPrs('lingtai', store))).map((p) => p.n)).toEqual([1, 2, 3])
    // A second landing into the same draft records nothing and walks nothing.
    const walked = probes().length
    const second = await run(draftBatchFor('lingtai', { ticket: '10', mergeCommit: 'm10', from: null }, store))
    expect(second.map((b) => b.streamId)).toEqual([prStream('lingtai', 3)])
    expect(probes().length).toBe(walked)
  })

  it('a landing past a merged highest opens the next number and records it', async () => {
    const inner = createMemoryEventStore()
    for (const n of [1, 2, 3]) await unrecorded(inner, n, [String(n)], 'merged')
    const batches = await run(draftBatchFor('lingtai', { ticket: '9', mergeCommit: 'm9', from: null }, inner))
    expect(batches.map((b) => b.streamId)).toEqual([prStream('lingtai', 4), projectStream('lingtai')])
    expect(batches[1]!.events).toMatchObject([{ type: 'ProjectPrNumbered', data: { n: 4 } }])
  })

  it('with a number recorded, no reader asks head about any pr- stream', async () => {
    const inner = createMemoryEventStore()
    for (const n of [1, 2, 3]) await unrecorded(inner, n, [String(n)])
    await recordPrNumber(inner, 'lingtai', 3)
    const { store, heads } = headCounting(inner)
    expect((await run(listPrs('lingtai', store))).map((p) => p.n)).toEqual([1, 2, 3])
    await run(openPr('lingtai', store))
    await run(readDraft('lingtai', store))
    await run(draftTarget('lingtai', store))
    await run(latestPr('lingtai', store))
    await run(readDraftedTickets('lingtai', store))
    expect(heads).toEqual([])
  })

  it('the freeze hand-off that opens n + 1 records n + 1', async () => {
    const store = createMemoryEventStore()
    await addToDraft(store, 1, '1')
    await run(requestPrSubmit('lingtai', 'team', 'human:steven', store))
    const state = await run(readPr('lingtai', 1, store))
    const handed = [{ ticket: '2', mergeCommit: 'm2', from: null }]
    await run(
      recordPrInProgress('lingtai', 1, frozen([{ ticket: '1', mergeCommit: 'm1', title: 't' }]), store, {
        state: state!,
        notKept: handed,
      }),
    )
    expect(reduceProject(await store.read(projectStream('lingtai'))).highestPr).toBe(2)
    expect((await run(listPrs('lingtai', store))).map((p) => p.n)).toEqual([1, 2])
  })

  it('two writers racing for the next number: one records it, the other conflicts on the project and lands on retry', async () => {
    const store = createMemoryEventStore()
    for (const n of [1, 2]) await unrecorded(store, n, [String(n)], 'merged')
    const first = await run(draftBatchFor('lingtai', { ticket: '8', mergeCommit: 'm8', from: null }, store))
    const second = await run(draftBatchFor('lingtai', { ticket: '9', mergeCommit: 'm9', from: null }, store))
    await store.appendAll(first)
    const lost = await store.appendAll(second).then(
      () => null,
      (e: unknown) => e,
    )
    expect(lost).toBeInstanceOf(ConcurrencyError)
    expect((lost as ConcurrencyError).streamId).toBe(prStream('lingtai', 3))
    const again = await run(draftBatchFor('lingtai', { ticket: '9', mergeCommit: 'm9', from: null }, store))
    expect(again.map((b) => b.streamId)).toEqual([prStream('lingtai', 3)])
    await store.appendAll(again)
    expect(await types(store, prStream('lingtai', 3))).toEqual(['PrDraftTicketAdded', 'PrDraftTicketAdded'])
    expect(reduceProject(await store.read(projectStream('lingtai'))).highestPr).toBe(3)
  })

  it('the freeze of a requested legacy PR with nothing to hand over records the highest', async () => {
    const store = createMemoryEventStore()
    for (const n of [1, 2]) await unrecorded(store, n, [String(n)], 'merged')
    await unrecorded(store, 3, ['3'])
    await store.append(prStream('lingtai', 3), 1, [
      { type: 'PrSubmitRequested', actor: 'human:steven', data: { by: 'human:steven' } },
    ])
    const state = await run(readPr('lingtai', 3, store))
    const ok = await run(
      recordPrInProgress('lingtai', 3, frozen([{ ticket: '3', mergeCommit: 'm3', title: 't' }]), store, {
        state: state!,
        notKept: [],
      }),
    )
    expect(ok).toBe(true)
    expect(reduceProject(await store.read(projectStream('lingtai'))).highestPr).toBe(3)
    expect((await run(listPrs('lingtai', store))).map((p) => p.n)).toEqual([1, 2, 3])
  })

  it('an unpinned write to a legacy PR records the highest, and a recorded project appends only the PR event', async () => {
    const store = createMemoryEventStore()
    for (const n of [1, 2]) await unrecorded(store, n, [String(n)], 'merged')
    await unrecorded(store, 3, ['3'])
    await store.append(prStream('lingtai', 3), 1, [
      { type: 'PrSubmitRequested', actor: 'human:steven', data: { by: 'human:steven' } },
    ])
    await run(recordPrInProgress('lingtai', 3, frozen([{ ticket: '3', mergeCommit: 'm3', title: 't' }]), store))
    expect(reduceProject(await store.read(projectStream('lingtai'))).highestPr).toBe(3)
    const version = reduceProject(await store.read(projectStream('lingtai'))).version
    await run(recordPrStepDone('lingtai', 3, { step: 'build', headSha: 'a'.repeat(40) }, store))
    expect(reduceProject(await store.read(projectStream('lingtai'))).version).toBe(version)
  })

  it('a request on a legacy PR records the highest', async () => {
    const store = createMemoryEventStore()
    await unrecorded(store, 1, ['1'])
    await unrecorded(store, 2, ['2'])
    await run(requestPrSubmit('lingtai', 'team', 'human:steven', store))
    expect(reduceProject(await store.read(projectStream('lingtai'))).highestPr).toBe(2)
  })
})
