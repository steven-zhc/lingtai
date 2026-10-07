/**
 * The Queued column for a project with no owner (#354) — `askProject`'s real
 * path, not a pre-built filter.
 *
 * `projectFilter` for such a project builds no `GitHubClient` (there is no App
 * to build one from) and reads its tickets from `ticketsFor`'s `db` branch
 * instead. This proves `askProject` carries that straight through to the
 * Queued column: `runnableNow`'s order and skip reasons, over a seeded
 * `memoryTickets()`.
 *
 * `filterFor` and `select` are `askProject`'s own seam, used here rather than
 * a pre-built `ProjectFilter`, so the real `projectFilter` runs end to end —
 * its default path reads `~/.lingtai/<project>/recipe.yml` and `task_view`,
 * both outside the system under 0060 §1 and both unreachable under
 * `HOME=/nonexistent`.
 */
import { projectFilter } from '@lingtai/conductor/filter'
import { memoryTickets } from '@lingtai/conductor/memory-tickets'
import type { ProjectState } from '@lingtai/domain'
import { resolveRecipe } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'

import { askProject } from '../src/lib/board.ts'

const RECIPE = `
version: 2
repo: { base: main, remote: git@example.com:esctest/esctest.git }
source: { kinds: [bug, feature], exclude: [agent:hold], tickets: db }
env: { required: [], plantAt: .env.local }
steps: {}
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`

const state = { project: 'esctest', owner: null, base: 'main' } as ProjectState

const clientFor = async (): Promise<never> => {
  throw new Error('no client should be built for a project with no owner')
}

const recipeFor = (s: ProjectState) => resolveRecipe(async () => RECIPE, s.base ?? 'main')

describe('askProject, for a project with no owner', () => {
  it('lists what runnableNow offers over a seeded memoryTickets(), with no client built', async () => {
    const tickets = memoryTickets()
    await tickets.createIssue({ title: 'a feature', body: '', labels: ['feature'] })
    await tickets.createIssue({ title: 'a bug', body: '', labels: ['bug'] })
    await tickets.createIssue({ title: 'held', body: '', labels: ['bug', 'agent:hold'] })

    const queue = await askProject(state, {
      filterFor: (s) => projectFilter(s, clientFor, recipeFor, async () => tickets),
      // `selectRunnable`'s own sort is tested elsewhere (`queued.test.ts`); here
      // it just passes `offered` through, so the assertion below is about
      // `runnableNow`'s order and not a second one.
      select: async (opts) =>
        opts.offered.map((o) => ({
          taskId: `wi-${opts.project}-${o.ref}`,
          issue: o.ref,
          title: o.title,
          kind: o.kind,
        })),
    })

    expect(queue.state).toBe('listed')
    if (queue.state !== 'listed') return
    // Creation order over the seeded store, not the recipe's kind-priority
    // order — that reordering is `selectRunnable`'s and is bypassed above.
    expect(queue.offered.runnable.map((r) => r.ref)).toEqual(['1', '2'])
    expect(queue.offered.skipped).toEqual([{ ref: 3, reason: 'excluded-label' }])
    expect(queue.runnable.map((r) => r.issue)).toEqual(['1', '2'])
  })
})
