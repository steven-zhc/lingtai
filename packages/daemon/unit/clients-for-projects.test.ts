import type { ProjectState } from '@lingtai/domain'
import type { GitHubClient } from '@lingtai/github'
/**
 * **A project whose recipe will not resolve is reported, not skipped
 * silently** (`#389`).
 *
 * `clientsForProjects` used to drop such a project with a bare `continue`,
 * which cost it label convergence, the close and #240's leftover-arm sweep
 * with nothing said anywhere — `doctor`'s sentence kept promising "the next
 * reconcile recomputes and writes the difference" for a project reconcile
 * had stopped touching. This is what makes that returned rather than lost:
 * the project's own problem comes back in `unresolved`, alongside the
 * `clients` map every other project still gets.
 *
 * `clientsForProjects` has one caller (`apps/cli/src/lingtai.ts`, at daemon
 * startup), so there is nothing on the work loop that calls it again until
 * the next start — a second sweep "over the same projects" here means a
 * second call in the same test, not a second pass. See its own doc comment.
 *
 * Unit, by 0060 §1: no GitHub App, no network, and a `createMemoryEventStore()`
 * handed in nowhere, because this function appends nothing — it only resolves
 * clients and recipes in memory.
 */
import { describe, expect, it } from 'vitest'

import { clientsForProjects } from '../src/converge.ts'

const OK: ProjectState = {
  project: 'ok',
  owner: 'steven-zhc',
  base: 'main',
  configHash: 'seeded',
  fromSha: '0'.repeat(40),
  refused: null,
  version: 1,
  lastSeq: null,
}

const BROKEN: ProjectState = { ...OK, project: 'broken' }

const stubClient = {} as GitHubClient

function seams() {
  return {
    hasApp: () => true,
    clientFor: async () => stubClient,
    recipeFor: async (state: ProjectState) => {
      if (state.project === 'broken') throw new Error('RECIPE INVALID — source.kinds.3: Invalid option')
      return { recipe: { version: 2 as const, source: { kinds: ['bug'] } }, ref: 'main', configHash: 'c' } as never
    },
  }
}

describe('clientsForProjects, a project whose recipe will not resolve', () => {
  it('is reported once in unresolved, and the other project still gets a client', async () => {
    const { clients, unresolved } = await clientsForProjects([OK, BROKEN], seams())

    expect(clients.has('ok')).toBe(true)
    expect(clients.has('broken')).toBe(false)
    expect(unresolved).toEqual([{ project: 'broken', problem: 'RECIPE INVALID — source.kinds.3: Invalid option' }])
  })

  it('reports the same single entry on a second call, and nothing accumulates', async () => {
    const options = seams()
    const first = await clientsForProjects([OK, BROKEN], options)
    const second = await clientsForProjects([OK, BROKEN], options)

    expect(first.unresolved).toEqual(second.unresolved)
    expect(second.unresolved).toHaveLength(1)
  })
})
