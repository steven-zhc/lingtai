/**
 * A turn-wide refusal is recorded on each project it skipped, once, and goes by itself (#1477).
 *
 * Driven through `conductorTurn`, the production caller: the hook-binary check, `projectsForTurn`'s
 * dropped projects and the look that records `ProjectRecovered` are all its own, so removing a call
 * from it turns these red. `store`, `projects`, `githubApp` and `world` are the seams it was given
 * for this; none changes what a turn does by default.
 */
import { fileURLToPath } from 'node:url'

import { memoryTickets } from '@lingtai/conductor/memory-tickets'
import { projectStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { readProject } from '@lingtai/project'
import { resolveRecipe } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { conductorTurn, liveConductWorld, type ConductWorld } from '../src/conduct.ts'

/** Any file that exists: the hook check reads it, and a turn that reaches the prompt reads another. */
const HERE = fileURLToPath(import.meta.url)
const MISSING = '/nonexistent/lingtai-hook'
const detail = `no lingtai-hook binary at ${MISSING}`

const RECIPE = `
version: 2
branch:
  main: main
repo:
  remote: https://example.invalid/local.git
source:
  kinds: [bug]
  tickets: db
env:
  plantAt: .env.local
runtime:
  agent: claude-code
steps:
  implement:
    - name: write it
      agent: claude-code
      prompt: go
`

async function setup(owners: Record<string, string | null> = { first: null, second: null }) {
  const store = createMemoryEventStore()
  for (const [project, owner] of Object.entries(owners)) {
    await store.append(projectStream(project), 0, [
      {
        type: 'ProjectConfigured',
        actor: 'conductor',
        data: { project, owner, base: 'main', configHash: 'h', fromSha: 's' },
      },
    ])
  }
  const names = Object.keys(owners)
  const read = async () => Promise.all(names.map(async (n) => (await readProject(n, store))!))
  const types = async (project: string) => (await store.read(projectStream(project))).map((e) => e.type)
  const count = async (project: string, type: string) => (await types(project)).filter((t) => t === type).length
  return { store, read, count }
}

/** A world in which an owner-less project has a recipe and nothing queued: the look is idle. */
async function idleWorld(): Promise<ConductWorld> {
  const resolved = await resolveRecipe(async () => RECIPE, 'main')
  const tickets = memoryTickets()
  return {
    ...liveConductWorld(),
    currentRecipe: async () => resolved,
    ticketsFor: () => Effect.succeed(tickets),
    selectRunnable: async () => [],
  }
}

describe('a turn that refuses every project because the hook binary is missing', () => {
  it('records one ProjectRefused per registered project, nothing on an identical second turn, and ProjectRecovered once the binary is back', async () => {
    const { store, read, count } = await setup()
    const world = await idleWorld()
    const turn = (hookBinary: string) =>
      Effect.runPromise(
        conductorTurn({
          hookBinary,
          promptPath: HERE,
          store,
          projects: Effect.promise(read),
          githubApp: true,
          codeSha: 'abc',
          world,
          log: () => {},
        }),
      )

    const first = await turn(MISSING)
    expect(first.refused).toEqual([{ project: '*', detail }])
    for (const p of ['first', 'second']) expect(await count(p, 'ProjectRefused')).toBe(1)
    expect((await read())[0]!.refused?.detail).toBe(detail)

    await turn(MISSING)
    for (const p of ['first', 'second']) expect(await count(p, 'ProjectRefused')).toBe(1)

    // The binary is back and the projects have nothing runnable: the look is still where the recovery is recorded.
    await turn(HERE)
    for (const p of ['first', 'second']) {
      expect(await count(p, 'ProjectRecovered')).toBe(1)
      expect(await count(p, 'ProjectRefused')).toBe(1)
    }
    expect((await read()).map((p) => p.refused)).toEqual([null, null])
  })
})

describe('a turn that has no GitHub App', () => {
  it('records the refusal on the GitHub project only, once', async () => {
    const { store, read, count } = await setup({ local: null, remote: 'steven-zhc' })
    const world = await idleWorld()
    const turn = () =>
      Effect.runPromise(
        conductorTurn({
          hookBinary: HERE,
          promptPath: HERE,
          store,
          projects: Effect.promise(read),
          githubApp: false,
          world,
          log: () => {},
        }),
      )

    await turn()
    await turn()
    expect(await count('remote', 'ProjectRefused')).toBe(1)
    expect((await read())[1]!.refused?.detail).toBe('no GitHub App configured')
    expect(await count('local', 'ProjectRefused')).toBe(0)
  })
})
