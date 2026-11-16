import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * **The base check's question is built from a project and its recipe, with no attempt in scope** (#1206, 0122 §2).
 * Over a fake `Sandbox`, a fake `Repo` and the memory store: no git, no srt.
 */
import type { CommandOutcome } from '@lingtai/actions'
import { integrationStream } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { SandboxApi } from '@lingtai/sandbox'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { baseCheckQuestion, createBaseCheck, UNSANDBOXED } from '../src/base-check.ts'
import { Repo } from '../src/ports.ts'
import { makeRunSandbox, type PassSandbox } from '../src/sandbox-decision.ts'

const SHA = 'c'.repeat(40)

const recipe = {
  steps: {
    admit: [],
    build: [{ name: 'test', run: 'pnpm test', env: [], timeout: '1m' }],
    prepared: [{ name: 'install', run: 'pnpm install', env: [], timeout: '2m' }],
  },
  env: { refuseHosts: [], plantAt: '.env.local' },
  repo: { submodules: false },
  runtime: { agent: 'claude-code' },
} as never

const env = { merged: { A: '1' }, values: { A: '1' } } as never

const service: SandboxApi = {
  hostCanSandbox: Effect.void,
  wrap: () => Effect.succeed({ argv: ['/w'], env: {}, commandId: 'c' }),
  refusedConnections: () => Effect.succeed({ kind: 'unreadable', why: 'unused' } as never),
  policyOf: () => {
    throw new Error('unused')
  },
  fingerprintOf: () => 'fp-policy',
}

const sandboxed: PassSandbox = {
  decision: { kind: 'sandboxed', project_additions: { network: [], write: [], deny: [] } } as never,
  service,
}
const unsandboxed: PassSandbox = {
  decision: { kind: 'unsandboxed', reason: 'off by choice' },
  service: undefined,
}

const gitCalls: { args: string[]; cwd: string | undefined }[] = []
const fakeRepo = {
  git: (args: string[], opts: { cwd?: string }) => {
    gitCalls.push({ args, cwd: opts.cwd })
    return Effect.succeed('')
  },
} as never

const build = (sandbox: PassSandbox) =>
  baseCheckQuestion({
    project: 'proj',
    base: 'main',
    baseSha: SHA,
    recipe,
    action: 'test',
    env,
    home: '/home/h',
    sandbox,
    checkId: 'look-1',
    signal: new AbortController().signal,
    token: undefined,
    gitEnv: undefined,
  }).pipe(Effect.provideService(Repo, fakeRepo), Effect.runPromise)

const ran: CommandOutcome = { ok: false, evidence: 'boom', timedOut: false, durationMs: 1, exitCode: 1 }

async function askOf(sandbox: PassSandbox) {
  const built = await build(sandbox)
  if ('notBuilt' in built) throw new Error(built.notBuilt)
  const store = createMemoryEventStore()
  const check = createBaseCheck({
    store,
    run: (o) => Effect.succeed(o.run === 'pnpm test' ? ran : { ...ran, ok: true, exitCode: 0 }),
    worktreePath: (project, sha7, id) => join(tmpdir(), 'base-check-question', `${project}-${sha7}-${id}`),
    note: () => {},
  })
  const answer = await Effect.runPromise(check.ask(built.question))
  const events = await store.read(integrationStream('proj', 'main'))
  return { built, answer, events }
}

describe('baseCheckQuestion', () => {
  it('builds an unsandboxed question with no attempt, and the answer names the boundary the event was recorded under', async () => {
    const { answer, events } = await askOf(unsandboxed)
    expect(answer).toMatchObject({ verdict: 'red', boundary: UNSANDBOXED })
    expect(events.map((e) => (e.data as { boundary?: string }).boundary)).toEqual([UNSANDBOXED])
  })

  it('builds a sandboxed question whose boundary is the one a pass’s own wrap records', async () => {
    const { built, answer, events } = await askOf(sandboxed)
    expect(built).toMatchObject({ observed: 'sandboxed' })
    const recorded = (events[0]!.data as { boundary: string }).boundary
    expect(answer).toMatchObject({ verdict: 'red', boundary: recorded })
    expect(recorded).not.toBe(UNSANDBOXED)

    // A pass's wrap: the same service and inputs, with its appends.
    const pass = makeRunSandbox(service, {
      appends: {} as never,
      project: 'proj',
      mirror: '/home/h/mirror/proj',
      cache: '/home/h/cache/proj',
      additions: { network: [], write: [], deny: [] } as never,
      codexNamed: false,
    })
    const profile = pass.profile('/wt/x', {})
    expect(pass.fingerprint('/wt/x', profile)).toBe(recorded)
  })

  it('cuts at the mirror, not at an attempt’s worktree', async () => {
    gitCalls.length = 0
    const built = await build(unsandboxed)
    if ('notBuilt' in built) throw new Error(built.notBuilt)
    const cutting = vi.fn()
    cutting()
    await Effect.runPromise(
      Effect.promise(() => built.question.tree.cut('/wt/proj/base-ccccccc-look-1', SHA)).pipe(
        Effect.provideService(Repo, fakeRepo),
      ),
    )
    expect(gitCalls[0]!.args).toEqual(['worktree', 'add', '--force', '--detach', '/wt/proj/base-ccccccc-look-1', SHA])
    expect(gitCalls[0]!.cwd).toContain('proj')
    expect(built.question.runId).toBe('look-1')
  })

  it('refuses to build on a refused decision and on a sandboxed one with no service', async () => {
    expect(await build({ decision: { kind: 'refused', why: 'no srt' }, service: undefined })).toEqual({
      notBuilt: 'no srt',
    })
    const got = await build({ ...sandboxed, service: undefined })
    expect(got).not.toHaveProperty('question')
    expect(got).toHaveProperty('notBuilt')
  })

  it('refuses a build action that is not a run:', async () => {
    const built = await baseCheckQuestion({
      project: 'proj',
      base: 'main',
      baseSha: SHA,
      recipe,
      action: 'nope',
      env,
      home: '/home/h',
      sandbox: unsandboxed,
      checkId: 'x',
      signal: new AbortController().signal,
      token: undefined,
      gitEnv: undefined,
    }).pipe(Effect.provideService(Repo, fakeRepo), Effect.runPromise)
    expect(built).toEqual({ notBuilt: 'not a run: action in the recipe' })
  })
})
