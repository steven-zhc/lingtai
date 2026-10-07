import { memoryTickets } from '@lingtai/conductor/memory-tickets'
import type { ControlState, ProjectState } from '@lingtai/domain'
import type { CreateClientOptions, GitHubClient } from '@lingtai/github'
import { resolveRecipe } from '@lingtai/recipe'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { conductProjects, conductWork, type ConductWorld, type PassOutcome } from '../src/conduct.ts'

/**
 * A pass's per-project work, for a project with no owner beside a GitHub one
 * (`#355`) — `conductWork` is the seam this needed: before it, `work` was a
 * closure inside `conductorPass` with no way to drive either branch under the
 * unit half (0060 §1), the way `unit/run-ownerless.test.ts` already proves for
 * `lingtai run`.
 *
 * The GitHub branch still calls `githubApp()` directly, same as before this
 * ticket — it is not part of `ConductWorld`, the same choice `run.ts` makes
 * for its own GitHub branch. `world.createGitHubClient` never reads what it is
 * handed, so a made-up App exported for the one test below is enough to let
 * that call resolve without reaching a file or the network.
 */
const PREVIOUS_ENV = { ...process.env }

beforeEach(() => {
  process.env['LINGTAI_GITHUB_APP_ID'] = '1'
  process.env['LINGTAI_GITHUB_APP_PRIVATE_KEY'] = 'not-a-real-key'
})

afterEach(() => {
  process.env = { ...PREVIOUS_ENV }
})

const EMPTY_CONTROL: ControlState = {
  paused: false,
  by: null,
  reason: null,
  until: null,
  shutdown: null,
  requested: [],
  discussions: [],
}

const LOCAL_PROJECT: ProjectState = {
  project: 'local',
  owner: null,
  base: 'main',
  configHash: 'hash',
  fromSha: '0'.repeat(40),
  refused: null,
  version: 1,
  lastSeq: null,
}

const GH_PROJECT: ProjectState = { ...LOCAL_PROJECT, project: 'gh', owner: 'steven-zhc' }

const LOCAL_RECIPE_YAML = `
version: 2
repo:
  base: main
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

const GH_RECIPE_YAML = `
version: 2
repo:
  base: main
source:
  kinds: [bug]
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

/** Enough of a `GitHubClient` for `runnableNow` to find nothing runnable. */
function stubGitHubClient(): GitHubClient {
  return {
    listOpenIssues: async () => [],
    token: async () => 'installation-token',
  } as unknown as GitHubClient
}

describe('conductWork, a pass across a project with no owner and a GitHub project', () => {
  it('offers the no-owner project work from its own Tickets, and reconciles the GitHub one as before', async () => {
    const localResolved = await resolveRecipe(async () => LOCAL_RECIPE_YAML, 'main')
    const ghResolved = await resolveRecipe(async () => GH_RECIPE_YAML, 'main')

    const localTickets = memoryTickets()
    await localTickets.createIssue({ title: 'fix the thing', body: 'body', labels: ['bug'] })

    const ghClient = stubGitHubClient()
    const createGitHubClientCalls: CreateClientOptions[] = []
    const runQueueCalls: { project: string }[] = []

    const world: ConductWorld = {
      createGitHubClient: async (options) => {
        createGitHubClientCalls.push(options)
        return ghClient
      },
      currentRecipe: async (project) => (project.project === 'local' ? localResolved : ghResolved),
      ticketsFor: async (project, _recipe, client) => (project.project === 'local' ? localTickets : client),
      selectRunnable: async ({ offered }) =>
        offered.map((o) => ({ taskId: `t-${o.ref}`, issue: o.ref, title: o.title, kind: o.kind })),
      runOnce: () => {
        throw new Error('not reached — nothing was asked for by number')
      },
      runQueue: (options) => {
        runQueueCalls.push({ project: options.project.project! })
        return Effect.succeed({ ran: [], stopped: 'empty', attempted: [] })
      },
    }

    const outcome: PassOutcome = { projects: 0, ran: 0, refused: [] }
    const work = conductWork(
      {
        hookBinary: '/dev/null',
        prompt: 'go read the ticket',
        control: EMPTY_CONTROL,
        outcome,
        log: () => {},
      },
      world,
    )

    const lines: string[] = []
    await conductProjects({
      projects: [LOCAL_PROJECT, GH_PROJECT],
      codeSha: null,
      outcome,
      log: (l) => lines.push(l),
      work,
    })

    expect(outcome.refused).toEqual([])
    expect(outcome.projects).toBe(2)

    // The GitHub project went through `createGitHubClient` and reached
    // `runQueue`, exactly as it does today.
    expect(createGitHubClientCalls).toHaveLength(1)
    expect(createGitHubClientCalls[0]?.owner).toBe('steven-zhc')
    expect(runQueueCalls.map((c) => c.project).sort()).toEqual(['gh', 'local'])

    // The no-owner project's queue came from the seeded ticket, through its
    // own `Tickets` — never a `GitHubClient`.
    const localQueued = runQueueCalls.find((c) => c.project === 'local')
    expect(localQueued).toBeDefined()
  })
})

describe('conductWork, with no GitHub App on this machine', () => {
  it('still conducts the no-owner project — only a GitHub project would be refused', async () => {
    const localResolved = await resolveRecipe(async () => LOCAL_RECIPE_YAML, 'main')
    const localTickets = memoryTickets()
    await localTickets.createIssue({ title: 'fix the thing', body: 'body', labels: ['bug'] })

    const runQueueCalls: string[] = []
    const world: ConductWorld = {
      createGitHubClient: () => {
        throw new Error('not reached — no owner, no App')
      },
      currentRecipe: async () => localResolved,
      ticketsFor: async () => localTickets,
      selectRunnable: async ({ offered }) =>
        offered.map((o) => ({ taskId: `t-${o.ref}`, issue: o.ref, title: o.title, kind: o.kind })),
      runOnce: () => {
        throw new Error('not reached')
      },
      runQueue: (options) => {
        runQueueCalls.push(options.project.project!)
        return Effect.succeed({ ran: [], stopped: 'empty', attempted: [] })
      },
    }

    // `conductorPass`'s own filtering (`#355`): with no App, only the
    // no-owner projects are handed to `conductProjects`, and the `'*'`
    // refusal is pushed once rather than returned early.
    const outcome: PassOutcome = {
      projects: 0,
      ran: 0,
      refused: [{ project: '*', detail: 'no GitHub App configured' }],
    }
    const work = conductWork(
      { hookBinary: '/dev/null', prompt: 'go', control: EMPTY_CONTROL, outcome, log: () => {} },
      world,
    )

    await conductProjects({
      projects: [LOCAL_PROJECT],
      codeSha: null,
      outcome,
      log: () => {},
      work,
    })

    expect(runQueueCalls).toEqual(['local'])
    expect(outcome.refused).toEqual([{ project: '*', detail: 'no GitHub App configured' }])
  })
})
