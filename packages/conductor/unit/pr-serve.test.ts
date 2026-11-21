/**
 * Serving a PR (0130 §5, #1316): the freeze against a fake git that answers by exit code, and the walk through
 * In progress's steps.
 */
import { integrationStream, prStepRows, prStream, reducePr, ticketStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { EventStore } from '@lingtai/event-store/store'
import { requestPrSubmit } from '@lingtai/project'
import type { Recipe } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  IN_PROGRESS_STEPS,
  type PrPorts,
  type PrStep,
  inProgressStepNames,
  makePrHandlers,
  servePr,
} from '../src/pr.ts'

const team = { mode: 'team', branch: { main: 'main', personal: 'lingtai-team' } } as unknown as Recipe
const solo = { branch: { main: 'main', personal: 'lingtai-team' } } as unknown as Recipe
const FROZEN = 'f'.repeat(40)

async function landed(store: EventStore, issue: string, base = 'lingtai-team') {
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
  ])
}

/** A fake mirror: `personal` resolves to FROZEN (or does not), and `reachable` are the merge commits it holds. */
function ports(
  store: EventStore,
  options: { recipe?: Recipe; personal?: boolean; reachable?: string[]; mergeBase?: number } = {},
): PrPorts & { calls: string[] } {
  const calls: string[] = []
  return {
    store,
    calls,
    recipe: () => Effect.succeed(options.recipe ?? team),
    candidates: () => Effect.succeed([{ issue: '1' }, { issue: '2' }, { issue: '3' }]),
    fetch: () => Effect.sync(() => void calls.push('fetch')),
    projects: () => Effect.succeed(['lingtai']),
    merge: () => Effect.succeed({ kind: 'failed', text: 'this test never merges' }),
    sweep: () => Effect.void,
    build: () => Effect.succeed({ kind: 'unknown', why: 'this test never builds' }),
    checkedOut: () => Effect.succeed(null),
    remote: () => Effect.fail(new Error('the freeze never reaches the remote')),
    github: () => Effect.fail(new Error('the freeze never reaches GitHub')),
    facts: () => Effect.succeed([]),
    git: (_project, args) =>
      Effect.sync(() => {
        calls.push(args.join(' '))
        if (args[0] === 'rev-parse') {
          return options.personal === false ? { code: 1, stdout: '' } : { code: 0, stdout: `${FROZEN}\n` }
        }
        if (options.mergeBase !== undefined) return { code: options.mergeBase, stdout: '' }
        return { code: (options.reachable ?? []).includes(args[2]!) ? 0 : 1, stdout: '' }
      }),
  }
}

const state = async (store: EventStore, n = 1) => reducePr(await store.read(prStream('lingtai', n)))
const request = (store: EventStore) => Effect.runPromise(requestPrSubmit('lingtai', 'team', 'human:steven', store))
const serve = (p: PrPorts, steps: readonly PrStep[] = []) => Effect.runPromise(servePr(p, 'lingtai', 1, steps))

describe('the freeze', () => {
  it('walks PrSubmitRequested to PrInProgress with the branch, the frozen sha and the tickets the commit holds', async () => {
    const store = createMemoryEventStore()
    await landed(store, '1')
    await landed(store, '2')
    await landed(store, '3')
    await request(store)
    // #3 landed after the freeze: its merge commit is not an ancestor of what the branch was.
    await serve(ports(store, { reachable: ['m1', 'm2'] }))

    const pr = await state(store)
    expect(pr.status).toBe('in-progress')
    expect(pr.prBranch).toBe('lingtai-team-pr-1')
    expect(pr.frozenSha).toBe(FROZEN)
    expect(pr.tickets.map((t) => t.ticket)).toEqual(['1', '2'])
    expect(pr.tickets[0]).toEqual({ ticket: '1', mergeCommit: 'm1', title: 'ticket 1' })
    const types = (await store.read(prStream('lingtai', 1))).map((e) => e.type)
    expect(types).toEqual(['PrSubmitRequested', 'PrInProgress'])
  })

  it('refuses nothing-landed when no ticket is held by the frozen commit', async () => {
    const store = createMemoryEventStore()
    await landed(store, '1')
    await request(store)
    await serve(ports(store, { reachable: [] }))
    const pr = await state(store)
    expect(pr.status).toBe('refused')
    expect(pr.refusal?.reason).toBe('nothing-landed')
  })

  it('refuses personal-missing when the branch does not resolve', async () => {
    const store = createMemoryEventStore()
    await landed(store, '1')
    await request(store)
    await serve(ports(store, { personal: false }))
    expect((await state(store)).refusal?.reason).toBe('personal-missing')
  })

  it('a merge-base exit other than 0 or 1 is git, never not-an-ancestor', async () => {
    const store = createMemoryEventStore()
    await landed(store, '1')
    await request(store)
    await serve(ports(store, { mergeBase: 128 }))
    expect((await state(store)).refusal?.reason).toBe('git')
  })

  it('refuses solo when the recipe changed since the request', async () => {
    const store = createMemoryEventStore()
    await request(store)
    await serve(ports(store, { recipe: solo }))
    expect((await state(store)).refusal?.reason).toBe('solo')
  })

  it('a read that fails records nothing, and is served again', async () => {
    const store = createMemoryEventStore()
    await landed(store, '1')
    await request(store)
    const broken: PrPorts = { ...ports(store, { reachable: ['m1'] }), fetch: () => Effect.fail(new Error('offline')) }
    await expect(serve(broken)).rejects.toThrow('offline')
    expect((await state(store)).status).toBe('requested')
    await serve(ports(store, { reachable: ['m1'] }))
    expect((await state(store)).status).toBe('in-progress')
  })

  it('serving twice appends nothing the second time', async () => {
    const store = createMemoryEventStore()
    await landed(store, '1')
    await request(store)
    const p = ports(store, { reachable: ['m1'] })
    await serve(p)
    const head = await store.head(prStream('lingtai', 1))
    await serve(p)
    expect(await store.head(prStream('lingtai', 1))).toBe(head)
  })
})

describe('a landing in flight', () => {
  it('is waited for: a pushed ticket whose TicketLanded is not yet recorded is in the freeze, not in the draft later', async () => {
    const store = createMemoryEventStore()
    await landed(store, '1')
    await store.append(ticketStream('lingtai', '2'), 0, [
      {
        type: 'TicketDiscovered',
        actor: 'conductor',
        data: {
          project: 'lingtai',
          source: 'github-issue',
          externalRef: '2',
          title: 'ticket 2',
          kind: 'bug',
          labels: [],
        },
      },
    ])
    const lane = integrationStream('lingtai', 'lingtai-team')
    const ticketId = ticketStream('lingtai', '2')
    await store.append(lane, 0, [
      { type: 'IntegrationAttempted', actor: 'conductor', data: { ticketId, branch: 'b', headSha: 'h' } },
      {
        type: 'IntegrationSucceeded',
        actor: 'conductor',
        data: { ticketId, branch: 'b', base: 'lingtai-team', mergeCommit: 'm2' },
      },
    ])
    await request(store)
    const p = ports(store, { reachable: ['m1', 'm2'] })
    let looks = 0
    const waiting: PrPorts = {
      ...p,
      landingWaitMs: 0,
      // The landing records itself on the second look, as conduct.ts does after the push.
      fetch: () =>
        Effect.promise(async () => {
          if (++looks === 2) {
            await store.append(ticketId, 1, [
              { type: 'TicketLanded', actor: 'conductor', data: { mergeCommit: 'm2', base: 'lingtai-team' } },
            ])
          }
        }),
    }
    await serve(waiting)
    expect(looks).toBe(2)
    expect((await state(store)).tickets.map((t) => t.ticket)).toEqual(['1', '2'])
  })
})

describe('a push whose landing was never recorded', () => {
  it('is waited for even when its ticket was released, and ignored when the frozen commit does not hold its head', async () => {
    const store = createMemoryEventStore()
    await landed(store, '1')
    await store.append(ticketStream('lingtai', '2'), 0, [
      {
        type: 'TicketDiscovered',
        actor: 'conductor',
        data: {
          project: 'lingtai',
          source: 'github-issue',
          externalRef: '2',
          title: 'ticket 2',
          kind: 'bug',
          labels: [],
        },
      },
    ])
    const ticketId = ticketStream('lingtai', '2')
    await store.append(integrationStream('lingtai', 'lingtai-team'), 0, [
      { type: 'IntegrationAttempted', actor: 'conductor', data: { ticketId, branch: 'b', headSha: 'h2' } },
    ])
    await store.append(ticketId, 1, [
      { type: 'TicketReleased', actor: 'conductor', data: { runId: 'r', reason: 'restart', cause: null } },
    ])
    await request(store)

    // The frozen commit holds h2: the push happened, its landing is owed, and the freeze will not omit the ticket.
    const pushed = { ...ports(store, { reachable: ['m1', 'h2'] }), landingWaitMs: 0 }
    await expect(serve({ ...pushed })).rejects.toThrow(/still in flight/)
    expect((await state(store)).status).toBe('requested')

    // Not an ancestor: it never pushed, so the PR freezes with what landed.
    await serve({ ...ports(store, { reachable: ['m1'] }), landingWaitMs: 0 })
    expect((await state(store)).tickets.map((t) => t.ticket)).toEqual(['1'])
  })
})

describe('resuming', () => {
  it('a failure serving one PR does not leave the others unserved', async () => {
    const store = createMemoryEventStore()
    await landed(store, '1')
    await Effect.runPromise(requestPrSubmit('a', 'team', 'human:steven', store))
    await Effect.runPromise(requestPrSubmit('lingtai', 'team', 'human:steven', store))
    const p = ports(store, { reachable: ['m1'] })
    const flaky: PrPorts = {
      ...p,
      projects: () => Effect.succeed(['a', 'lingtai']),
      fetch: (project) => (project === 'a' ? Effect.fail(new Error('offline')) : p.fetch(project)),
    }
    await Effect.runPromise(makePrHandlers(flaky, []).resume())
    expect((await state(store)).status).toBe('in-progress')
    expect(reducePr(await store.read(prStream('a', 1))).status).toBe('requested')
  })
})

describe('the walk', () => {
  const done = (name: string): PrStep => ({
    name,
    run: ({ state }) => Effect.succeed({ kind: 'done', headSha: state.target ?? 'x' }),
  })

  it('lists In progress’s steps in 0130 §5’s order, sync and build first', () => {
    expect(inProgressStepNames(IN_PROGRESS_STEPS)).toEqual(['sync', 'build', 'push', 'open'])
  })

  it('records each step with the head sha it ran on, and a second serve runs none of them again', async () => {
    const store = createMemoryEventStore()
    await landed(store, '1')
    await request(store)
    const ran: string[] = []
    const steps: PrStep[] = ['sync', 'build'].map((name) => ({
      name,
      run: ({ state }) => Effect.sync(() => (ran.push(name), { kind: 'done' as const, headSha: state.target! })),
    }))
    const p = ports(store, { reachable: ['m1'] })
    await serve(p, steps)
    await serve(p, steps)
    expect(ran).toEqual(['sync', 'build'])
    expect((await state(store)).steps).toEqual([
      { step: 'sync', headSha: FROZEN },
      { step: 'build', headSha: FROZEN },
    ])
  })

  it('a wait stops the walk and records the step and the reason; again records nothing', async () => {
    const store = createMemoryEventStore()
    await landed(store, '1')
    await request(store)
    const steps: PrStep[] = [
      done('first'),
      {
        name: 'second',
        run: ({ state }) => Effect.succeed({ kind: 'wait', reason: 'denied', detail: 'no', headSha: state.target! }),
      },
      done('third'),
    ]
    await serve(ports(store, { reachable: ['m1'] }), steps)
    const pr = await state(store)
    expect(pr.status).toBe('waiting')
    expect(pr.wait).toMatchObject({ step: 'second', reason: 'denied', headSha: FROZEN })
    expect(pr.steps.map((s) => s.step)).toEqual(['first'])

    const again = createMemoryEventStore()
    await landed(again, '1')
    await request(again)
    await serve(ports(again, { reachable: ['m1'] }), [{ name: 'later', run: () => Effect.succeed({ kind: 'again' }) }])
    expect((await state(again)).steps).toEqual([])
  })

  it('draws a row per step from the list, and a dummy step is one more row', async () => {
    const store = createMemoryEventStore()
    await landed(store, '1')
    await request(store)
    await serve(ports(store, { reachable: ['m1'] }))
    const pr = await state(store)
    const names = inProgressStepNames()
    expect(prStepRows([...names, 'dummy'], pr)).toHaveLength(prStepRows(names, pr).length + 1)
    expect(prStepRows(['dummy'], pr)).toEqual([{ step: 'dummy', status: 'pending', headSha: null }])
  })
})

describe('a ticket that ends a landing serves the PR again', () => {
  it('a TicketLanded on the project serves its requested PR, and a ticket of no PR stream is ignored', async () => {
    const store = createMemoryEventStore()
    await landed(store, '1')
    await request(store)
    const handlers = makePrHandlers(ports(store, { reachable: ['m1'] }), [])
    const event = (await store.read(ticketStream('lingtai', '1')))[1]!
    await Effect.runPromise(handlers.serve(event))
    expect((await state(store)).status).toBe('in-progress')
  })
})
