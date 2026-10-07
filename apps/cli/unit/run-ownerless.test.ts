/**
 * `lingtai run` on a project with no owner (`#352`) — one registered from a
 * local directory (`lingtai add --local`) rather than `lingtai add
 * <owner>/<repo>`.
 *
 * `run()` had no seam to drive either branch under the unit half before this
 * ticket (`unit/run-before-dispatch.test.ts`'s own header says why:
 * `hasGitHubApp`, `loadProject` and `createGitHubClient` all reach outside
 * the process). `RunWorld` is that seam now, and every fake below that must
 * not be reached throws if it is — which is how the first case proves no
 * GitHub client is built and the second proves the App is never checked past
 * the owner-less branch, instead of trusting a call count nobody asserted.
 */
import { AgentHost, Repo, type ScheduleOptions, type Tickets } from '@lingtai/conductor'
import type { ProjectState } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { resolveRecipe } from '@lingtai/recipe'
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import { ConductorLock } from '../src/conductor-lock.ts'
import { Projector } from '../src/projector.ts'
import { run, type RunWorld } from '../src/run.ts'

/** Assignable to any field on `RunWorld` — `never` satisfies every return type. */
const notReached = (): never => {
  throw new Error('not reached')
}

const FAKE_LOCK = Layer.succeed(ConductorLock, { key: 'test' })
const FAKE_PROJECTOR = Layer.succeed(Projector, { following: false, failure: null })
const FAKE_PORTS = Layer.merge(
  Layer.succeed(Repo, { provision: notReached, remove: notReached, git: notReached, integrate: notReached }),
  Layer.succeed(AgentHost, {
    wire: notReached,
    smokeTest: notReached,
    serve: notReached,
    unhookedSettings: notReached,
    runLog: notReached,
    resolveEnv: notReached,
  }),
)

const OWNERLESS_PROJECT: ProjectState = {
  project: 'demo',
  owner: null,
  base: 'main',
  configHash: 'hash',
  fromSha: 'deadbeef',
  refused: null,
  version: 1,
  lastSeq: 1n,
}

const GITHUB_PROJECT: ProjectState = { ...OWNERLESS_PROJECT, owner: 'steven-zhc' }

const OWNERLESS_RECIPE_YAML = `
version: 2
repo:
  base: main
  remote: https://example.invalid/demo.git
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

/** The eight `Tickets` verbs, each a distinct function so identity survives the spread into `PassClient`. */
const FAKE_DB_TICKETS: Tickets = {
  listOpenIssues: notReached,
  listIssuesSince: notReached,
  getIssue: notReached,
  createIssue: notReached,
  comment: notReached,
  setLabels: notReached,
  closeIssue: notReached,
  updateBody: notReached,
}

describe('run, for a project with no owner', () => {
  it('reaches runQueue with remote set, no token, and the db-ticket store — never building a GitHub client', async () => {
    const resolved = await resolveRecipe(async () => OWNERLESS_RECIPE_YAML, 'main')
    // An array rather than a reassigned `let`: TypeScript narrows a `let`
    // written to inside a closure down to `never` at a later read, since it
    // cannot prove the closure ran — mutating a `const` array has no such
    // narrowing to get wrong.
    const handed: ScheduleOptions[] = []

    const world: RunWorld = {
      // Never reached: there is no owner to check an App for.
      hasGitHubApp: notReached,
      loadProject: async () => OWNERLESS_PROJECT,
      // Never reached: there is no owner to build a `GitHubClient` for.
      createGitHubClient: notReached,
      currentRecipe: async () => resolved,
      ticketsFor: async () => FAKE_DB_TICKETS,
      readHookBinary: async () => Buffer.from(''),
      readPrompt: async () => 'go read the ticket',
      // This run takes the queue, so `runOnce` is never reached either.
      runOnce: notReached,
      runQueue: (options) => {
        handed.push(options)
        return Effect.succeed({ ran: [], stopped: 'empty', attempted: [] })
      },
      tallyPass: async () => ({ landed: 0, held: 0, stopped: 0 }),
      lock: FAKE_LOCK,
      projector: FAKE_PROJECTOR,
      ports: FAKE_PORTS,
    }

    const lines: string[] = []
    // A memory store, not the omitted default: `heedThePause` reads
    // `options.store` before `world` is ever consulted, and with no store it
    // reaches this machine's own config rather than staying inside the fakes
    // above (`run-pause.test.ts`'s own pattern).
    const code = await run({ project: 'demo', store: createMemoryEventStore() }, (l) => lines.push(l), world)

    expect(code).toBe(0)
    expect(handed).toHaveLength(1)
    expect(handed[0]?.remote).toBe('https://example.invalid/demo.git')
    expect(handed[0]?.token).toBeUndefined()
    expect(handed[0]?.client.owner).toBeNull()
    expect(handed[0]?.client.repo).toBe('demo')
    // The ticket verbs are the fake db tickets' — not a `GitHubClient`'s.
    expect(handed[0]?.client.listOpenIssues).toBe(FAKE_DB_TICKETS.listOpenIssues)
    expect(handed[0]?.client.getIssue).toBe(FAKE_DB_TICKETS.getIssue)
  })
})

describe('run, for a GitHub project', () => {
  it('still refuses with no GitHub App configured — the owner-less branch did not swallow this refusal', async () => {
    const world: RunWorld = {
      hasGitHubApp: () => false,
      loadProject: async () => GITHUB_PROJECT,
      // Everything past the App check is never reached.
      createGitHubClient: notReached,
      currentRecipe: notReached,
      ticketsFor: notReached,
      readHookBinary: notReached,
      readPrompt: notReached,
      runOnce: notReached,
      runQueue: notReached,
      tallyPass: notReached,
      lock: FAKE_LOCK,
      projector: FAKE_PROJECTOR,
      ports: FAKE_PORTS,
    }

    const lines: string[] = []
    const code = await run({ project: 'demo', store: createMemoryEventStore() }, (l) => lines.push(l), world)

    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('no GitHub App configured')
  })
})
