/**
 * The pass's one sandbox decision and the wrap's closure (#1152). `Sandbox` is a fake that records; nothing loads srt.
 */
import type { SandboxBlock } from '@lingtai/recipe'
import { SandboxUnavailable, type SandboxApi } from '@lingtai/sandbox'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { decidePassSandbox } from '../src/sandbox-decision.ts'

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
