/**
 * **A team pass makes `branch.personal` when the remote has none, and only then** (#1358).
 *
 * The cut asks the port after its provision reported the base absent, never before: a branch that
 * exists is never touched and a read that failed makes nothing.
 */
import { RepoFailed } from '@lingtai/repo'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { ensurePersonalBranch, lsRemoteReading, type PersonalBranchPort } from '../src/personal-branch.ts'
import { RECIPE, fakeGitHub, fakePorts, issue, memoryStore, once, project, runtime } from '../test/one-attempt.ts'

const TEAM = RECIPE.replace('branch: { main: main }', 'mode: team\nbranch: { main: main, personal: p }').replace(
  'source: {',
  'source: { assignee: { login: me, take: mine },',
)

const pass = async (recipe: string, personalBranch: PersonalBranchPort | undefined, absent: boolean) => {
  const store = memoryStore()
  const did: string[] = []
  const client = fakeGitHub([], recipe)
  client.getIssue = async () => ({ ...issue, assignees: ['me'] })
  client.listOpenIssues = async () => [{ ...issue, assignees: ['me'] }]
  const ports = fakePorts(did, store)
  const provision = ports.repo.provision
  let first = true
  ports.repo.provision = (o) => {
    if (absent && first) {
      first = false
      did.push('provision absent')
      return Effect.fail(new RepoFailed({ operation: 'provision', detail: 'unknown revision', baseAbsent: true }))
    }
    return provision(o)
  }
  const result = await once(
    {
      project: { ...project, base: 'main' },
      client,
      runtime,
      issue: 7,
      hookBinary: '/tmp/fake/lingtai-hook',
      prompt: 'fix {{issue}}',
      home: '/tmp/fake-home',
      store,
      signedIn: async () => [],
      ...(personalBranch === undefined ? {} : { personalBranch }),
    },
    ports,
  )
  return { did, result }
}

describe('a team pass whose personal branch is absent', () => {
  it('makes it once from branch.main and cuts again', async () => {
    const calls: Array<[string, string]> = []
    const { did } = await pass(
      TEAM,
      (name, from) => Effect.sync(() => (calls.push([name, from]), { made: 'b'.repeat(40) })),
      true,
    )
    expect(calls).toEqual([['p', 'main']])
    expect(did.filter((l) => l.startsWith('provision')).length).toBe(2)
    expect(did).toContain('cut from origin/p')
  })

  it('cuts again when the port says it exists', async () => {
    const { did } = await pass(TEAM, () => Effect.succeed({ exists: true as const }), true)
    expect(did).toContain('cut from origin/p')
  })

  it('makes nothing and does not cut when the read failed', async () => {
    let cut = false
    const { did, result } = await pass(TEAM, () => Effect.fail(new Error('could not read whether p exists')), true)
    cut = did.includes('cut from origin/p')
    expect(cut).toBe(false)
    expect(JSON.stringify(result)).toContain('could not read whether p exists')
  })

  it('asks nothing in solo mode, or with no port, or when the branch is there', async () => {
    const calls: string[] = []
    const port: PersonalBranchPort = (n) => Effect.sync(() => (calls.push(n), { exists: true as const }))
    await pass(RECIPE, port, true)
    await pass(TEAM, undefined, true)
    await pass(TEAM, port, false)
    expect(calls).toEqual([])
  })
})

describe('ensurePersonalBranch', () => {
  const client = (exists: boolean | Error, calls: string[]) => ({
    branchExists: () => (exists instanceof Error ? Effect.fail(exists) : Effect.succeed(exists)),
    refSha: () => Effect.sync(() => (calls.push('refSha'), 'c'.repeat(40))),
    createBranch: (n: string, sha: string) => Effect.sync(() => void calls.push(`create ${n} ${sha.slice(0, 1)}`)),
  })

  it('makes it at the tip of main when absent', async () => {
    const calls: string[] = []
    const out = await Effect.runPromise(ensurePersonalBranch(client(false, calls), 'p', 'main'))
    expect(out).toEqual({ made: 'c'.repeat(40) })
    expect(calls).toEqual(['refSha', 'create p c'])
  })

  it('does nothing when it exists', async () => {
    const calls: string[] = []
    expect(await Effect.runPromise(ensurePersonalBranch(client(true, calls), 'p', 'main'))).toEqual({ exists: true })
    expect(calls).toEqual([])
  })

  it('makes nothing when the existence read fails', async () => {
    const calls: string[] = []
    await expect(Effect.runPromise(ensurePersonalBranch(client(new Error('502'), calls), 'p', 'main'))).rejects.toThrow(
      /nothing was made/,
    )
    expect(calls).toEqual([])
  })
})

describe('lsRemoteReading', () => {
  it('reads a line as exists and nothing as absent', () => {
    expect(lsRemoteReading('abc\trefs/heads/p\n')).toBe('exists')
    expect(lsRemoteReading('')).toBe('absent')
  })
})
