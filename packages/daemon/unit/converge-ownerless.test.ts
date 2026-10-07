import { memoryTickets } from '@lingtai/conductor/memory-tickets'
import type { ProjectState } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

/**
 * Reconcile converges a project with no owner (`#355`) through its own
 * `Tickets`, never a `GitHubClient` — the daemon's half of the same change
 * `#352` made to `lingtai run`.
 *
 * `clientsForProjects` builds this project's map entry through
 * `ownerlessClient` rather than `clientFor`, which this proves by handing a
 * `clientFor` that throws if it is ever asked for this project. The seeded
 * ticket and log rows are `converge-refs.test.ts`'s own shape, minus the refs
 * sweep: a `refs` divergence would call `matchingRefs`/`deleteRef`, which run
 * real `git` against the project's remote (`git-refs.ts`) and belong in
 * `integration/`, not here.
 *
 * Unit, by 0060 §1: a memory log, a `memoryTickets()` store, and a
 * `clientFor` this test never expects to be called.
 */
import { clientsForProjects, convergeIssues } from '../src/converge.ts'
import type { DaemonStore } from '../src/store.ts'

const PROJECT = 'local-proj'

const project: ProjectState = {
  project: PROJECT,
  owner: null,
  base: 'main',
  configHash: 'seeded',
  fromSha: '0'.repeat(40),
  refused: null,
  version: 1,
  lastSeq: null,
}

const RECIPE = {
  version: 2 as const,
  source: { kinds: ['bug'], tickets: 'db' },
  repo: { remote: 'https://example.invalid/local-proj.git' },
} as never

/** The one stream this pass is to consider — `candidates()`' only job. */
function oneStream(streamId: string): DaemonStore {
  return { streams: async () => [streamId] } as unknown as DaemonStore
}

describe('reconcile, a project with no owner', () => {
  it('writes labels and the close through its own Tickets, never a GitHub client', async () => {
    const tickets = memoryTickets()
    const opened = await tickets.createIssue({ title: 'a ticket', body: '', labels: ['lingtai:working'] })
    const issue = opened.number
    const stream = `wi-${PROJECT}-${issue}`

    const store = createMemoryEventStore()
    await store.append(stream, 0, [
      { type: 'WorkItemClaimed', actor: 'conductor', data: { runId: 'run-a', worker: 'w', title: null, kind: null } },
      { type: 'WorkItemLanded', actor: 'conductor', data: { mergeCommit: '0'.repeat(40), base: 'main' } },
      {
        type: 'IssueUpdated',
        actor: 'conductor',
        data: { project: PROJECT, issue: String(issue), change: 'labels', detail: 'lingtai:working' },
      },
      {
        type: 'IssueUpdateFailed',
        actor: 'conductor',
        data: { project: PROJECT, issue: String(issue), change: 'closed', error: '502' },
      },
    ])

    const { clients, unresolved } = await clientsForProjects([project], {
      hasApp: () => false,
      // Never reached: there is no GitHub client to build for a project with
      // no owner.
      clientFor: () => {
        throw new Error('not reached — this project has no owner')
      },
      recipeFor: async () => ({ recipe: RECIPE, ref: 'main', configHash: 'c' }) as never,
      ticketsOf: async () => tickets,
    })
    expect(unresolved).toEqual([])
    expect(clients.has(PROJECT)).toBe(true)

    const { converged } = await convergeIssues({
      store,
      daemonStore: oneStream(stream),
      projects: [project],
      clients,
    })

    expect(converged.map((d) => d.change).sort()).toEqual(['closed', 'labels'])

    const after = await tickets.getIssue(issue)
    expect(after.state).toBe('closed')
    expect(after.labels).toEqual([])

    // Two more than the one seeded above — the labels write and the close,
    // each the same `IssueUpdated` the inline path would have appended.
    const rows = (await store.read(stream)).filter((e) => e.type === 'IssueUpdated')
    expect(rows).toHaveLength(3)
    expect(
      rows
        .slice(1)
        .map((e) => (e.data as { change: string }).change)
        .sort(),
    ).toEqual(['closed', 'labels'])
  })
})
