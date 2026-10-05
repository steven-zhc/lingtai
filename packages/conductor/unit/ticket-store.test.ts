/**
 * `ticketsFor` and `passClientOf` (`#382`) — the seam that decides whether a
 * pass's ticket verbs go to GitHub or to `dbTickets`, and the refusal that
 * keeps a `db` switch from numbering into a project's own GitHub history.
 *
 * Unit by [0060](../../../doc/decisions-archive/0060-the-gate-runs-unit-tests.md) §1:
 * SQLite `:memory:` and the fakes from `test/one-pass.ts`, no process, no
 * network.
 */
import type { LogQueries } from '@lingtai/event-store'
import { createSqliteTicketSql, openSqliteLog } from '@lingtai/event-store/sqlite'
import type { TicketSql } from '@lingtai/event-store/ticket-sql'
import { resolveRecipe } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { runOnce } from '../src/conduct.ts'
import { dbTickets } from '../src/db-tickets.ts'
import { passClientOf, TicketSourceConflict, ticketsFor } from '../src/ticket-store.ts'
import { fakeGitHub, fakePorts, memoryStore, PROJECT, project, runtime, streams, withPorts } from '../test/one-pass.ts'

function freshSql(): TicketSql {
  return createSqliteTicketSql(openSqliteLog(':memory:'))
}

/** No `tickets:` written — the default, exactly as a project had it before this field existed. */
const RECIPE_GITHUB = `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps: {}
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`

const RECIPE_DB = `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [], tickets: db }
env: { required: [], plantAt: .env.local }
steps: {}
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`

/**
 * A person at `proposed`, and a `close:` declared for the outcome that
 * reaches — so one pass exercises all three ticket verbs the claim and the
 * block write (a comment, a label change) plus the one `end` only carries out
 * for effect (`close`).
 */
const RECIPE_DB_HOLD = `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [], tickets: db }
env: { required: [], plantAt: .env.local }
steps:
  proposed:
    - name: approval
      human: "Merge this? It is a db-ticketed project."
  end:
    - name: close it
      when: blocked
      close: true
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`

async function recipeOf(text: string) {
  return (await resolveRecipe(async (path) => (path === '.lingtai/config.yaml' ? text : null), 'main')).recipe
}

describe('ticketsFor', () => {
  it('answers the client itself when the recipe names no source, exactly the value it always answered', async () => {
    const client = fakeGitHub([])
    const recipe = await recipeOf(RECIPE_GITHUB)
    expect(await ticketsFor(project, recipe, client)).toBe(client)
  })

  it('answers a store backed by dbTickets when the recipe says db', async () => {
    const sql = freshSql()
    const recipe = await recipeOf(RECIPE_DB)
    const client = fakeGitHub([])

    const tickets = await ticketsFor(project, recipe, client, { sql })
    expect(tickets).not.toBe(client)

    const opened = await tickets.createIssue({ title: 'a race in the importer', body: 'fix it', labels: ['bug'] })
    // The same `sql`, read back through a second `dbTickets` of its own — the
    // claim that `ticketsFor`'s answer really is this project's ticket table
    // and not a store of its own invention.
    expect(await dbTickets(sql, PROJECT).getIssue(opened.number)).toMatchObject({ title: 'a race in the importer' })
  })

  describe('the refusal', () => {
    function logOver(store: ReturnType<typeof memoryStore>): Pick<LogQueries, 'projectStreams'> {
      return {
        projectStreams: async (prefix) => [...streams(store).keys()].filter((id) => id.startsWith(prefix)),
      }
    }

    it('refuses by name when the log already has GitHub-numbered work items and dbTickets is empty', async () => {
      const store = memoryStore()
      await store.append(`wi-${PROJECT}-212`, 0, [
        { type: 'WorkItemClaimed', actor: 'conductor', data: { issue: 212 } },
      ])
      const recipe = await recipeOf(RECIPE_DB)

      await expect(
        ticketsFor(project, recipe, fakeGitHub([]), { sql: freshSql(), log: logOver(store) }),
      ).rejects.toThrow(TicketSourceConflict)
    })

    it('passes once dbTickets already holds a ticket of its own, regardless of what the log holds', async () => {
      const store = memoryStore()
      await store.append(`wi-${PROJECT}-212`, 0, [
        { type: 'WorkItemClaimed', actor: 'conductor', data: { issue: 212 } },
      ])
      const recipe = await recipeOf(RECIPE_DB)
      const sql = freshSql()
      await dbTickets(sql, PROJECT).createIssue({ title: 'switched on purpose', body: '', labels: [] })

      await expect(
        ticketsFor(project, recipe, fakeGitHub([]), { sql, log: logOver(store) }),
      ).resolves.toBeDefined()
    })

    it('does not refuse a project with no wi- streams at all', async () => {
      const store = memoryStore()
      const recipe = await recipeOf(RECIPE_DB)

      await expect(
        ticketsFor(project, recipe, fakeGitHub([]), { sql: freshSql(), log: logOver(store) }),
      ).resolves.toBeDefined()
    })
  })
})

describe('a pass under source.tickets: db', () => {
  /**
   * **Every ticket verb a pass makes lands in `dbTickets`, and the fake
   * GitHub records none of its own** — the claim, the block's comment and
   * label change, and the `end` point's close.
   */
  it('claims a ticket dbTickets created, blocks, and closes it — all without a GitHub call', async () => {
    const store = memoryStore()
    const did: string[] = []
    const said: string[] = []

    const github = fakeGitHub(said, RECIPE_DB_HOLD)
    const sql = freshSql()
    const tickets = dbTickets(sql, PROJECT)
    const created = await tickets.createIssue({
      title: 'a race in the importer',
      body: 'fix it',
      labels: ['bug'],
    })
    const client = passClientOf(github, tickets)

    const result = await Effect.runPromise(
      runOnce({
        project,
        client,
        recipe: () => resolveRecipe((path, ref) => github.fileAt(path, ref), project.base ?? 'main'),
        runtime,
        issue: created.number,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: true,
        home: '/tmp/fake-home',
        store,
      }).pipe(Effect.provide(withPorts(fakePorts(did, store, true)))),
    )

    if (result.ok === false) throw new Error(`stopped at ${result.stage}: ${result.detail}`)
    if (result.ok !== 'held') throw new Error('it landed, and a person had been declared at proposed')
    expect(result.step).toBe('proposed')

    // The fake GitHub's own ticket verbs were never called — everything a
    // real `GitHubClient` would have been asked went to `dbTickets` instead.
    expect(said).toEqual([])

    const after = await tickets.getIssue(created.number)
    expect(after.state).toBe('closed')
    expect(after.labels.map((l) => l.name).sort()).toEqual(['bug', 'lingtai:waiting'])

    const comments = await tickets.commentBodies(created.number)
    expect(comments.some((body) => body.includes('Lingtai is waiting on you'))).toBe(true)
  })
})
