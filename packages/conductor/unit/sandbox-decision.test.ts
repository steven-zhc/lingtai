/**
 * The pass's one sandbox decision and the wrap's closure (#1152). `Sandbox` is a fake that records; nothing loads srt.
 */
import type { UserPermissions } from '@lingtai/agent'
import type { SandboxBlock } from '@lingtai/recipe'
import { SandboxUnavailable, type SandboxApi, type WrapInput } from '@lingtai/sandbox'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { decidePassSandbox, makeRunSandbox } from '../src/sandbox-decision.ts'

const block = (over: Partial<SandboxBlock> = {}): SandboxBlock => ({
  enabled: true,
  required: false,
  network: { allow: ['example.com'] },
  write: ['~/cache'],
  deny: [],
  ...over,
})

function fakeService(host: 'can' | SandboxUnavailable) {
  const asked = { host: 0 }
  const service: SandboxApi = {
    hostCanSandbox: Effect.suspend(() => {
      asked.host += 1
      return host === 'can' ? Effect.void : Effect.fail(host)
    }),
    wrap: () => Effect.succeed({ argv: ['/w'], env: {}, commandId: 'c' }),
    refusedConnections: () => Effect.succeed({ kind: 'unreadable', why: 'unused' } as never),
    policyOf: () => {
      throw new Error('unused')
    },
  }
  return { service, asked }
}

const decide = (b: SandboxBlock | undefined, service?: SandboxApi) =>
  decidePassSandbox(b, service === undefined ? undefined : Effect.succeed(service)).pipe(Effect.runPromise)

describe('decidePassSandbox', () => {
  it('asks the host nothing for no block, or for enabled: false', async () => {
    const f = fakeService('can')
    for (const b of [undefined, block({ enabled: false })]) {
      const got = await decide(b, f.service)
      expect(got.decision).toEqual({ kind: 'unsandboxed', reason: 'off by choice' })
    }
    expect(f.asked.host).toBe(0)
  })

  it('is sandboxed where the provided service says it can, with the block’s additions against the user’s HOME', async () => {
    const f = fakeService('can')
    const got = await decide(block(), f.service)
    expect(got.service).toBe(f.service)
    expect(got.decision.kind).toBe('sandboxed')
    if (got.decision.kind !== 'sandboxed') return
    expect(got.decision.project_additions.network).toEqual(['example.com'])
    expect(got.decision.project_additions.write).toEqual([`${process.env['HOME']}/cache`])
    expect(f.asked.host).toBe(1)
  })

  it('is degraded with the sentence under required: false, and refused under required: true', async () => {
    const f = fakeService(new SandboxUnavailable({ reason: 'bwrap is missing', sentences: [] }))
    expect((await decide(block(), f.service)).decision).toEqual({
      kind: 'unsandboxed',
      reason: 'degraded',
      why: 'bwrap is missing',
    })
    expect((await decide(block({ required: true }), f.service)).decision).toEqual({
      kind: 'refused',
      why: 'bwrap is missing',
    })
  })

  it('is refused by name with no service, and carries a failed build as an unavailable host', async () => {
    expect((await decide(block(), undefined)).decision).toEqual({
      kind: 'refused',
      why: 'no sandbox service in this process',
    })
    const failed = await decidePassSandbox(
      block({ required: true }),
      Effect.fail(new SandboxUnavailable({ reason: 'the sandbox runtime could not be loaded', sentences: [] })),
    ).pipe(Effect.runPromise)
    expect(failed.decision).toEqual({ kind: 'refused', why: 'the sandbox runtime could not be loaded' })
    expect(failed.service).toBeUndefined()
  })
})

describe('makeRunSandbox puts the operator Codex profile denies on a run: command (#1155)', () => {
  const wrapOf = (profile: UserPermissions, codexNamed: boolean) => {
    const seen: WrapInput[] = []
    const { service } = fakeService('can')
    const api: SandboxApi = {
      ...service,
      wrap: (input) => {
        seen.push(input)
        return Effect.succeed({ argv: ['/w'], env: {}, commandId: 'c' })
      },
    }
    const run = makeRunSandbox(api, {
      project: 'p',
      mirror: '/state/repos/p.git',
      cache: '/state/cache/p',
      additions: {},
      codexNamed,
      readCodexPermissions: () => profile,
    })
    const result = Effect.runPromise(
      Effect.scoped(run.wrap(['make'], '/work/tree', { HOME: '/home/op' })).pipe(Effect.result),
    )
    return { seen, result }
  }

  it('hands the denies to wrap as caller_additions.deny', async () => {
    const { seen, result } = wrapOf({ kind: 'denies', paths: ['~/secrets'] }, false)
    expect((await result)._tag).toBe('Success')
    expect(seen[0]!.caller_additions).toEqual({ deny: ['/home/op/secrets'] })
  })

  it('refuses an unreadable profile only when the recipe names Codex', async () => {
    const named = wrapOf({ kind: 'unreadable', why: 'bad' }, true)
    expect((await named.result)._tag).toBe('Failure')
    expect(named.seen).toHaveLength(0)
    const plain = wrapOf({ kind: 'unreadable', why: 'bad' }, false)
    expect((await plain.result)._tag).toBe('Success')
    expect(plain.seen[0]!.caller_additions).toBeUndefined()
  })

  it('refuses a deny that contains the worktree', async () => {
    const { seen, result } = wrapOf({ kind: 'denies', paths: ['/work'] }, false)
    expect((await result)._tag).toBe('Failure')
    expect(seen).toHaveLength(0)
  })
})
