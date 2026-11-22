import type { GitHub } from '@lingtai/github'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { checkRunState, githubActionsProvider, runsOnPullRequest } from '../src/ci-github-actions.ts'

const files = (workflows: Record<string, string>) =>
  githubActionsProvider({
    github: {} as GitHub,
    git: (args) =>
      Effect.succeed(
        args[0] === 'ls-tree'
          ? {
              code: 0,
              stdout: Object.keys(workflows)
                .map((f) => `.github/workflows/${f}\0`)
                .join(''),
            }
          : { code: 0, stdout: workflows[args[1]!.split('/').pop()!] ?? '' },
      ),
  })
const detect = (workflows: Record<string, string>) =>
  Effect.runPromise(files(workflows).detect({ sha: 'abc', branch: 'b' }))

describe('detect', () => {
  it('on: push only is none', async () => {
    expect(await detect({ 'ci.yml': 'on: push\njobs: {}\n' })).toBe('none')
    expect(await detect({})).toBe('none')
  })
  it('a list or a map naming pull_request is configured', async () => {
    expect(runsOnPullRequest('on: [push, pull_request]\n')).toBe(true)
    expect(runsOnPullRequest('on:\n  pull_request:\n    types: [opened]\n')).toBe(true)
    expect(runsOnPullRequest('on: pull_request_target\n')).toBe(true)
    expect(await detect({ 'a.yml': 'on: push\n', 'b.yaml': 'on: [pull_request]\n' })).toBe('configured')
  })
  it('a file that does not parse counts as configured', () => {
    expect(runsOnPullRequest('on: [unclosed\n')).toBe(true)
  })
})

describe('detect with a non-ASCII workflow name', () => {
  it('reads the raw path from NUL-separated ls-tree output', async () => {
    expect(await detect({ '测试.yml': 'on: pull_request\n' })).toBe('configured')
  })
})

describe('observe', () => {
  const provider = (runs: object[], total: number) =>
    githubActionsProvider({
      github: {
        checkRunsAt: () => Effect.succeed(runs),
        combinedStatusAt: () =>
          Effect.succeed({ total, statuses: total === 0 ? [] : [{ context: 'ci/x', state: 'pending', url: null }] }),
      } as unknown as GitHub,
      git: () => Effect.fail(new Error('unused')),
    })
  it('maps a run and carries its log link as the only artifact', async () => {
    const { checks } = await Effect.runPromise(
      provider(
        [
          {
            name: 't',
            status: 'completed',
            conclusion: 'success',
            url: 'https://x/summary',
            detailsUrl: 'https://x/1',
            startedAt: null,
            completedAt: null,
          },
        ],
        0,
      ).observe('abc'),
    )
    expect(checks).toMatchObject([{ name: 't', state: 'success', artifacts: [{ kind: 'log', url: 'https://x/1' }] }])
  })
  it('total_count 0 adds no check; a pending status is running', async () => {
    expect((await Effect.runPromise(provider([], 0).observe('abc'))).checks).toEqual([])
    expect((await Effect.runPromise(provider([], 1).observe('abc'))).checks).toMatchObject([
      { name: 'ci/x', state: 'running' },
    ])
  })
  it('a completed run with no conclusion is unknown', () => {
    expect(checkRunState({ status: 'completed', conclusion: null })).toBe('unknown')
    expect(checkRunState({ status: 'completed', conclusion: 'weird' })).toBe('unknown')
  })
})
