import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { applyWorkItem, reduceWorkItem, type Envelope } from '@lingtai/domain'
import { createSqliteTicketSql, openSqliteLog } from '@lingtai/event-store/sqlite'
import type { GitHubClient } from '@lingtai/github'
import { RECIPE_PATH, resolveRecipe } from '@lingtai/recipe'
/**
 * Closing a ticket nobody is going to do (#151).
 *
 * The properties worth pinning are not that an event can be appended — every
 * event can — but the three claims the decision rests on: it is a **terminal**,
 * **nothing lifts it**, and the **queue stops offering it because the log says
 * so** rather than because GitHub stopped listing it.
 */
import { describe, expect, it } from 'vitest'

import { close } from '../src/close.ts'
import { dbTickets } from '../src/db-tickets.ts'
import { passClientOf } from '../src/ticket-store.ts'
import { fakeGitHub as fullFakeGitHub } from '../test/one-pass.ts'

const at = (n: number) => new Date(Date.UTC(2026, 8, 14, 12, n)).toISOString()

/** The shape the store hands a reducer, with only what these tests read. */
const event = (n: number, type: string, data: object): Envelope =>
  ({
    seq: n,
    streamId: 'wi-lingtai-32',
    type,
    data,
    at: at(n),
    version: n,
    actor: 'human:steven',
  }) as unknown as Envelope

const closed = event(2, 'WorkItemClosed', { by: 'human:steven', reason: 'over-built for the need' })

describe('a closed work item', () => {
  it('is a terminal that carries who and why', () => {
    const state = reduceWorkItem([
      event(1, 'WorkItemBlocked', {
        question: 'merge over the refusal?',
        needsFrom: 'human',
        runId: 'run-1',
        needs: 'judgement',
        diagnosis: null,
      }),
      closed,
    ])

    expect(state.lifecycle).toEqual({
      status: 'closed',
      by: 'human:steven',
      reason: 'over-built for the need',
    })
  })

  /**
   * The whole of why the queue passes over it. `queue.ts` subtracts every row
   * the fold does not call `backlog`, so this one property is what makes a
   * closed item unclaimable — with no label, no GitHub round trip and no change
   * to the queue at all.
   */
  it('is not backlog, which is what the queue subtracts on', () => {
    const state = reduceWorkItem([closed])

    expect(state.lifecycle.status).not.toBe('backlog')
    expect(state.lifecycle.status).toBe('closed')
  })

  /**
   * 0151's decision, and the one that had to be written down rather than left
   * to whoever read the code next: reopening the issue starts no work. A
   * `WorkItemUnblocked` after a close — which is what the board's Requeue and
   * `lingtai answer` both append — must not resurrect it, or the next attempt
   * inherits the findings and the spend of work done under an intent that is no
   * longer the intent.
   */
  it('is not lifted by an unblock arriving after it', () => {
    const state = applyWorkItem(
      reduceWorkItem([closed]),
      event(3, 'WorkItemUnblocked', { by: 'human:steven', note: 'changed my mind' }),
    )

    expect(state.lifecycle.status).toBe('closed')
  })

  /** And a claim after it does not either: the ticket is over, not free. */
  it('is not lifted by a claim arriving after it', () => {
    const state = applyWorkItem(
      reduceWorkItem([closed]),
      event(4, 'WorkItemClaimed', { runId: 'run-2', worker: 'daemon' }),
    )

    expect(state.lifecycle.status).toBe('closed')
  })
})

/**
 * And the `end` point runs on it, because `end` is the point that runs on every
 * terminal outcome (0044).
 *
 * The first cut of `close()` appended `WorkItemClosed` and stopped. That is
 * 0016 §4's shape — the point was configured, `StepsResolved` said so, and it
 * silently did not run — and its visible cost was a manual step: `lingtai
 * close` ended the ticket on the log and left the GitHub issue open for
 * somebody to close by hand afterwards. Both halves are asserted here, against
 * this repository's own recipe with one action spliced into it, so a schema
 * that stopped admitting the action would fail this rather than a reader
 * noticing.
 */
describe('closing runs the end point', () => {
  /**
   * This repository's own recipe, unaltered.
   *
   * Not a fixture and not a splice: what is being asserted is that *this*
   * repository closes its issue when a person closes the ticket, which is a
   * fact about `.lingtai/config.yaml` and would be worth nothing if the test
   * supplied the configuration it then checked. It also fails usefully in the
   * other direction — a `when: landed` quietly widened to `any` would show up
   * here as an action resolving on a close that should not.
   */
  async function recipe(): Promise<string> {
    const root = fileURLToPath(new URL('../../../', import.meta.url))
    return readFile(`${root}${RECIPE_PATH}`, 'utf8')
  }

  /** A store that keeps what it was handed, so *one append* is checkable. */
  function store() {
    const events: Envelope[] = []
    const appends: { type: string; data: unknown }[][] = []
    return {
      appends,
      events,
      async read() {
        return events
      },
      async append(_id: string, _version: number, toAppend: { type: string; data: unknown }[]) {
        appends.push(toAppend)
        for (const e of toAppend) events.push(event(events.length + 1, e.type, e.data as object))
      },
    }
  }

  /** Just enough GitHub to read a recipe and be told about an issue. */
  function github(yaml: string | null) {
    const closedIssues: number[] = []
    const labelWrites: string[][] = []
    return {
      closedIssues,
      labelWrites,
      async defaultBranch() {
        return 'main'
      },
      async fileAt(path: string, ref: string) {
        if (yaml === null) throw new Error('the recipe could not be read')
        return path === RECIPE_PATH && ref === 'main' ? yaml : null
      },
      async getIssue() {
        return { labels: [{ name: 'bug' }, { name: 'lingtai:waiting' }] }
      },
      async setLabels(_issue: number, labels: readonly string[]) {
        labelWrites.push([...labels])
      },
      async closeIssue(issue: number) {
        closedIssues.push(issue)
      },
      async comment() {
        return { id: 1 }
      },
      async updateBody() {},
    }
  }

  const args = (s: ReturnType<typeof store>, g: ReturnType<typeof github>) =>
    ({
      project: 'lingtai',
      issue: 32,
      by: 'human:steven',
      reason: 'over-built for the need',
      state: { name: 'lingtai', owner: 'steven-zhc', base: 'main' },
      client: g,
      // The recipe through the fake GitHub, so a `null` one still refuses the
      // way an unreadable file does; where it is read from is `local.test.ts`'s.
      recipe: () => resolveRecipe((p, r) => g.fileAt(p, r), 'main'),
      store: s,
    }) as unknown as Parameters<typeof close>[0]

  it('resolves the point in the same append as the outcome', async () => {
    const s = store()
    const g = github(await recipe())

    const outcome = await close(args(s, g))

    expect(outcome.ok).toBe(true)
    // One append, carrying both. A crash cannot leave a terminal whose point
    // resolved to nothing recorded — the version check guards the pair.
    expect(s.appends[0]?.map((e) => e.type)).toEqual(['WorkItemClosed', 'EndActionsResolved'])
    // Exactly the `when: closed` action. The `when: landed` one beside it in
    // the same recipe does not resolve here, which is the whole reason the two
    // are separate actions rather than one `when: any`.
    expect(s.appends[0]?.[1]?.data).toEqual({
      outcome: 'closed',
      actions: [{ name: 'close the ticket a person ended', close: true }],
    })
  })

  it('carries the resolution out, so the issue does not need closing by hand', async () => {
    const s = store()
    const g = github(await recipe())

    await close(args(s, g))

    expect(g.closedIssues).toEqual([32])
    // And Lingtai's own labels come off: `labelsFor("closed")` is empty, and a
    // whole-set write keeps everybody else's.
    expect(g.labelWrites).toEqual([['bug']])
  })

  it('refuses on a recipe it cannot read, and closes nothing', async () => {
    const s = store()
    const g = github(null)

    const outcome = await close(args(s, g))

    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('Nothing was closed.')
    // The point of refusing before the append: a terminal with an unresolved
    // point is the silence this whole mechanism exists to prevent.
    expect(s.appends).toEqual([])
    expect(g.closedIssues).toEqual([])
  })
})

/**
 * `close()` narrowed to `IssueChannel & RefChannel` so `client` can be a
 * `db` project's `TicketedClient` (`passClientOf`, #383) rather than a raw
 * `GitHubClient` — the same client every CLI and board call site now gets
 * from `projectClient`.
 */
describe("a db project's close", () => {
  const RECIPE_DB_END_CLOSE = `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [], tickets: db }
env: { required: [], plantAt: .env.local }
steps:
  end:
    - name: close it
      when: closed
      close: true
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`

  /** Tracks every one of `IssueChannel`'s verbs reaching the raw fake, so a regression that hands `close()` the raw github client instead of its `dbTickets`-backed one is visible here. */
  function recordIssueCalls(client: GitHubClient, calls: string[]): GitHubClient {
    const wrapped: Record<string, unknown> = { ...client }
    for (const verb of ['getIssue', 'comment', 'setLabels', 'closeIssue', 'updateBody'] as const) {
      const original = (client as unknown as Record<string, unknown>)[verb]
      wrapped[verb] = (...args: unknown[]) => {
        calls.push(verb)
        if (typeof original !== 'function') throw new Error(`fake.${verb} has no implementation`)
        return (original as (...a: unknown[]) => unknown)(...args)
      }
    }
    return wrapped as unknown as GitHubClient
  }

  it("closes a db project's ticket in dbTickets, and reaches none of IssueChannel's verbs on the raw client", async () => {
    const calls: string[] = []
    const github = recordIssueCalls(fullFakeGitHub([]), calls)
    const sql = createSqliteTicketSql(openSqliteLog(':memory:'))
    const tickets = dbTickets(sql, 'lingtai')
    const opened = await tickets.createIssue({ title: 'a ticket', body: 'fix it', labels: ['bug'] })
    const client = passClientOf(github, tickets)

    const events: Envelope[] = []
    const outcome = await close({
      project: 'lingtai',
      issue: opened.number,
      by: 'human:steven',
      reason: 'over-built for the need',
      state: { project: 'lingtai', owner: 'steven-zhc', base: 'main' },
      client,
      recipe: () => resolveRecipe(async (p) => (p === RECIPE_PATH ? RECIPE_DB_END_CLOSE : null), 'main'),
      store: {
        async read() {
          return events
        },
        async append(_id: string, _version: number, toAppend: { type: string; data: unknown }[]) {
          for (const e of toAppend) {
            events.push({
              seq: events.length + 1,
              type: e.type,
              data: e.data,
              actor: 'human:steven',
            } as unknown as Envelope)
          }
          return []
        },
      },
    } as unknown as Parameters<typeof close>[0])

    expect(outcome.ok).toBe(true)
    expect(calls).toEqual([])

    const after = await tickets.getIssue(opened.number)
    expect(after.state).toBe('closed')
    // Lingtai's own labels came off, the same as `closing runs the end point`
    // asserts against the real client above.
    expect(after.labels.map((l) => l.name)).toEqual(['bug'])
  })
})
