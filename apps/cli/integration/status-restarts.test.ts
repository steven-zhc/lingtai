/**
 * `lingtai status` and the board say a restart's ceiling in the same words
 * (#100).
 *
 * `TicketReleased{cause: Restart}` carries no denominator of its own since
 * `#502` — `task_view.restarts_of` has had no writer since that ticket, so
 * both surfaces fall back to the recipe's own `runtime.limits.restarts`
 * through `describeArm`'s second argument. `board.ts`'s `toCard` passes it;
 * `status.ts` did not, so the terminal printed `restart 1` for the same
 * ticket the board printed `restart 1 of 2` for.
 */
import { projectStream, workItemStream } from '@lingtai/domain'
import { processEventStore, type EventStore } from '@lingtai/event-store'
import type { GitHubClient, Issue, Label } from '@lingtai/github'
import { createProjectionRunner, taskViewProjection } from '@lingtai/projector'
import { type ResolvedRecipe, resolveRecipe } from '@lingtai/recipe'
import { beforeAll, expect, it } from 'vitest'

import { status } from '../src/status.ts'

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`
const OWNER = 'steven-zhc'
const RESTARTED = 61

const YAML = `
version: 2
repo:
  base: develop
source:
  kinds: [bug]
  exclude: []
env:
  required: []
  plantAt: .env.local
runtime:
  agent: claude-code
  limits:
    restarts: 2
`

const issue = (over: Omit<Partial<Issue>, 'labels'> & { number: number; labels?: (string | Label)[] }): Issue => ({
  title: `issue ${over.number}`,
  body: '',
  state: 'open',
  url: `https://example.invalid/${over.number}`,
  dependencies: { blockedBy: 0, totalBlockedBy: 0 },
  assignees: [],
  ...over,
  labels: (over.labels ?? []).map((l) => (typeof l === 'string' ? { name: l, color: null } : l)),
})

const github: GitHubClient = {
  owner: OWNER,
  repo: PROJECT,
  installation: { id: 1, permissions: {}, account: OWNER, repositorySelection: 'selected', htmlUrl: null },
  request: async () => {
    throw new Error('not used')
  },
  token: async () => {
    throw new Error('not used')
  },
  defaultBranch: async () => 'develop',
  fileAt: async () => YAML,
  refSha: async () => '0'.repeat(40),
  matchingRefs: async () => [],
  deleteRef: async () => {
    throw new Error('no writes in this test')
  },
  // Offers nothing: the restarted ticket is already claimed, and its row
  // comes off `task_view` through `--all` rather than off this offer.
  listOpenIssues: async () => [],
  listIssuesSince: async () => [],
  getIssue: async (n) => issue({ number: n }),
  comment: async () => {
    throw new Error('no writes in this test')
  },
  setLabels: async () => {
    throw new Error('no writes in this test')
  },
  updateBody: async () => {
    throw new Error('no writes in this test')
  },
  createIssue: async () => {
    throw new Error('no writes in this test')
  },
  closeIssue: async () => {
    throw new Error('no writes in this test')
  },
}

const wi = (n: number) => workItemStream(PROJECT, n)

let store: EventStore
let resolved: ResolvedRecipe

/** Catches `task_view` up to the head before `status` reads it (same as `ask.test.ts`'s own `fold`). */
async function fold(): Promise<void> {
  const runner = createProjectionRunner({ projection: taskViewProjection, store })
  try {
    await runner.start()
  } finally {
    await runner.close()
  }
}

beforeAll(async () => {
  store = await processEventStore()
  resolved = await resolveRecipe(async () => YAML, 'develop')
  await store.append(projectStream(PROJECT), 0, [
    {
      type: 'ProjectConfigured',
      actor: 'conductor',
      data: {
        project: PROJECT,
        owner: OWNER,
        base: 'develop',
        configHash: resolved.configHash,
        fromSha: '0'.repeat(40),
      },
    },
  ])

  const run1 = `pass-${PROJECT}-${RESTARTED}a`
  await store.append(wi(RESTARTED), 0, [
    { type: 'TicketClaimed', actor: 'conductor', data: { runId: run1, worker: 'w', title: null, kind: null } },
    {
      type: 'TicketReleased',
      actor: 'conductor',
      data: { runId: run1, reason: 'the proposed reviewer refused — restart 1 of 2', cause: { _tag: 'Restart', restart: 1 } },
    },
  ])

  await fold()
}, 120_000)

it("says the restart's ceiling, in the same words the board's card would", async () => {
  const said: string[] = []
  const code = await status({ project: PROJECT, all: true }, (l) => said.push(l), {
    clientFor: async () => github,
    recipeFor: async () => resolved,
  })
  expect(code).toBe(0)

  const out = said.join('\n')
  // `describeArm({restarts: 1, restartsOf: 0}, 2)` — the recipe's own
  // `runtime.limits.restarts` standing in for the column `#502` left at
  // zero. Printing `restart 1` with no denominator is the failure this
  // test pins: a person reading the terminal could not tell the ceiling
  // from being spent.
  expect(out).toContain('restart 1 of 2')
  expect(out).not.toMatch(/restart 1(?! of)/)
})
