import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

/**
 * `gitRefChannel`, against a real git binary and a bare repository — the
 * `RefChannel` an owner-less project's pass sweeps with instead of GitHub's
 * (`#352`).
 *
 * The one thing worth a real git for is `matchingRefs`' prefix behaviour,
 * which `tell.ts:209-214` says GitHub answers as a plain string match rather
 * than a path match: asking for `heads/agent/24` also answers `heads/agent/
 * 240`'s refs. `sweepRefs` is the one that filters that back down by hand —
 * `startsWith(heads/agent/24-attempt-)` rather than `startsWith(heads/agent/
 * 24)` — and this is the case that would catch it if `gitRefChannel` ever
 * answered a narrower or wider match than GitHub's.
 */
import { workItemStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { gitRefChannel } from '../src/git-refs.ts'
import { sweepRefs } from '../src/tell.ts'

const exec = promisify(execFile)
const authored = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
}
const g = (args: string[], cwd: string) => exec('git', args, { cwd, env: { ...process.env, ...authored } })

let root: string
let remote: string
let work: string

async function pushArm(branch: string): Promise<void> {
  await g(['checkout', '-q', '-B', branch, 'main'], work)
  await g(['commit', '-q', '--allow-empty', '-m', branch], work)
  await g(['push', '-q', 'origin', branch], work)
  await g(['checkout', '-q', 'main'], work)
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'lingtai-git-refs-'))
  remote = join(root, 'origin.git')
  work = join(root, 'work')

  await exec('git', ['init', '-q', '-b', 'main', work])
  await g(['commit', '-q', '--allow-empty', '-m', 'first'], work)
  await exec('git', ['clone', '-q', '--bare', work, remote])
  await g(['remote', 'add', 'origin', remote], work)

  // `agent/24`'s arm and `agent/240`'s — the pair `tell.ts` names (#240).
  await pushArm('agent/24-attempt-1')
  await pushArm('agent/240-attempt-1')
}, 60_000)

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('gitRefChannel', () => {
  it('matches a plain string prefix, same as GitHub says it does', async () => {
    const channel = gitRefChannel({ remote })
    const found = await channel.matchingRefs('heads/agent/24')
    expect(found).toContain('heads/agent/24-attempt-1')
    // The collision `sweepRefs` exists to filter back out — asked without its
    // own filter on top, `heads/agent/24` answers `heads/agent/240`'s ref too.
    expect(found).toContain('heads/agent/240-attempt-1')
  })
})

describe('sweepRefs, over a gitRefChannel', () => {
  it("sweeps 24's own arm and leaves 240's, even though matchingRefs('heads/agent/24') answers both", async () => {
    const store = createMemoryEventStore()
    const channel = gitRefChannel({ remote })
    const workItemId = workItemStream('esctest', 24)

    await sweepRefs({ store, github: channel, workItemId, andTheBranch: false })

    const left = await channel.matchingRefs('heads/agent/')
    expect(left).not.toContain('heads/agent/24-attempt-1')
    expect(left).toContain('heads/agent/240-attempt-1')

    const events = await store.read(workItemId)
    const last = events.at(-1)
    expect(last?.type).toBe('IssueUpdated')
    expect(last?.data).toMatchObject({ change: 'refs', detail: 'heads/agent/24-attempt-1' })
  })
})
