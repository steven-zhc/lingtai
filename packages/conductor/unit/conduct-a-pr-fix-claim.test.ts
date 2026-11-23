/**
 * **A `lingtai:pr-fix` ticket claimed while a PR is open is cut from that PR's branch, and its claim says so**
 * (0130 §5, #1341). Claimed with no PR open it is an ordinary ticket on `branch.personal`, and says that too; a PR
 * that cannot be read, or has no branch on the remote yet, claims nothing. Unit by 0060 §1.
 */
import { prStream, ticketStream } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store'
import { describe, expect, it } from 'vitest'

import { PROJECT, fakeGitHub, fakePorts, issue, memoryStore, once, project, runtime } from '../test/one-attempt.ts'

const TEAM = `
version: 2
mode: team
branch: { main: main, personal: lingtai-team }
pr: {}
repo: { submodules: false }
source: { kinds: [bug], exclude: [], assignee: { login: me } }
env: { required: [], plantAt: .env.local }
steps: {}
runtime: { agent: claude-code, limits: { run: { turns: 10, wall: 2m }, attempt: { refusalFixes: 2, conflictResolutions: 2 }, ticket: { newAttempts: 0 } } }
`

const FROZEN = 'f'.repeat(40)

/** PR 1, frozen and (optionally) pushed, so its branch `lingtai-team-pr-1` is on the remote. */
async function openPr(store: EventStore, pushed: boolean) {
  const events = [
    { type: 'PrSubmitRequested', actor: 'human:steven', data: { by: 'human:steven' } },
    {
      type: 'PrInProgress',
      actor: 'conductor',
      data: {
        because: 'submit',
        branch: 'lingtai-team',
        main: 'main',
        frozenSha: FROZEN,
        prBranch: 'lingtai-team-pr-1',
        tickets: [],
      },
    },
    ...(pushed ? [{ type: 'PrPushed', actor: 'conductor', data: { headSha: FROZEN, found: 'pushed' } }] : []),
  ]
  await store.append(prStream(PROJECT, 1), 0, events as never)
}

/** A team project is registered on its personal branch, where the recipe is read from. */
const teamClient = () => {
  const client = fakeGitHub([], TEAM)
  client.fileAt = async (path: string) => (path === '.lingtai/config.yaml' ? TEAM : null)
  return client
}

const options = (store: EventStore) => {
  const client = teamClient()
  const fix = { ...issue, assignees: ['me'], labels: [{ name: 'lingtai:pr-fix', color: '#000000' }] }
  client.getIssue = async () => fix
  client.listOpenIssues = async () => [fix]
  return {
    project: { ...project, base: 'lingtai-team' },
    client,
    runtime,
    issue: 7,
    hookBinary: '/tmp/fake/lingtai-hook',
    prompt: 'fix {{body}}',
    merge: true,
    home: '/tmp/fake-home',
    store,
  }
}

const claims = async (store: EventStore) =>
  (await store.read(ticketStream(PROJECT, 7))).filter((e) => e.type === 'TicketClaimed')

describe('a team lingtai:pr-fix claim', () => {
  it('with a PR open records the PR branch and is cut from it', async () => {
    const store = memoryStore()
    await openPr(store, true)
    const did: string[] = []
    await once(options(store), fakePorts(did, store, true))
    expect(await claims(store)).toHaveLength(1)
    expect((await claims(store))[0]!.data).toMatchObject({ cutFrom: { branch: 'lingtai-team-pr-1', pr: 1 } })
    expect(did).toContain('cut from origin/lingtai-team-pr-1')
  })

  it('with no PR open records branch.personal and no PR, and is cut from it', async () => {
    const store = memoryStore()
    const did: string[] = []
    await once(options(store), fakePorts(did, store, true))
    expect((await claims(store))[0]!.data).toMatchObject({ cutFrom: { branch: 'lingtai-team', pr: null } })
    expect(did).toContain('cut from origin/lingtai-team')
  })

  it('claims nothing while the PR branch is not on the remote yet', async () => {
    const store = memoryStore()
    await openPr(store, false)
    const did: string[] = []
    await once(options(store), fakePorts(did, store, true))
    expect(await claims(store)).toHaveLength(0)
    expect(did.some((l) => l.startsWith('provision'))).toBe(false)
  })

  it('claims nothing when the PR cannot be read', async () => {
    const store = memoryStore()
    await openPr(store, true)
    const read = store.read.bind(store)
    store.read = async (stream, ...rest) => {
      if (stream === prStream(PROJECT, 1)) throw new Error('the log would not answer')
      return read(stream, ...rest)
    }
    const did: string[] = []
    await once(options(store), fakePorts(did, store, true))
    expect(await claims(store)).toHaveLength(0)
  })
})

describe('every other claim', () => {
  it('records no cutFrom', async () => {
    const store = memoryStore()
    const ordinary = options(store)
    ordinary.client.getIssue = async () => ({ ...issue, assignees: ['me'] })
    ordinary.client.listOpenIssues = async () => [{ ...issue, assignees: ['me'] }]
    await once(ordinary, fakePorts([], store, true))
    const [claim] = await claims(store)
    expect(claim!.data).not.toHaveProperty('cutFrom')
  })
})
