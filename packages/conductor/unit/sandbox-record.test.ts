import { makeProcessAction } from '@lingtai/actions'
/**
 * What a pass appends about an invocation's sandbox boundary and its refused connections (#1164).
 * `SandboxApi` is a fake whose scope release empties its own store, as srt's does, so the read has to be made first.
 */
import type { ToAppend } from '@lingtai/domain'
import type { SandboxApi, WrapInput, RefusedRead } from '@lingtai/sandbox'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeRunSandbox } from '../src/sandbox-decision.ts'
import { boundaryOfDecision, recordUnwrapped, recordingWrap } from '../src/sandbox-record.ts'

const policy = {
  allowedDomains: [],
  allowRead: [],
  allowWrite: [],
  denyRead: [],
  denyWrite: [],
  weakerNetworkIsolation: false,
  srtVersion: '1.2.3',
}

const entry = { host: 'evil.test', port: 443, count: 2, firstAt: '2026-11-13T00:00:00.000Z', telemetry: false }

/** A service whose per-command state is gone once the wrap's scope closes. */
const fakeApi = (refused: RefusedRead | 'store') => {
  const store: RefusedRead[] = [{ kind: 'entries', entries: [entry], complete: true }]
  const api: SandboxApi = {
    hostCanSandbox: Effect.void,
    wrap: (input: WrapInput) =>
      Effect.acquireRelease(Effect.succeed({ argv: ['/w', ...input.command], env: {}, commandId: 'cmd-1' }), () =>
        Effect.sync(() => void store.splice(0)),
      ),
    refusedConnections: () =>
      Effect.sync(() =>
        refused === 'store' ? (store[0] ?? { kind: 'entries', entries: [], complete: true }) : refused,
      ),
    policyOf: () => policy,
    fingerprintOf: () => 'fp',
  }
  return api
}

const input: WrapInput = { project: 'p', worktree: '/w', mirror: '/m', command: ['x'], env: {} }
const keys = { step: 'review', action: 'cold', runtime: 'claude-code', runId: 'run-1' } as const

const sink = () => {
  const rows: ToAppend[] = []
  const log: string[] = []
  const append = (label: string) => (events: readonly ToAppend[]) =>
    Effect.sync(() => {
      rows.push(...events)
      log.push(label)
    })
  return { rows, log, appends: { before: append('before'), after: append('after') } }
}

describe('recordingWrap', () => {
  it('appends the boundary before the child starts and the refusals after, read before the scope releases', async () => {
    const s = sink()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* recordingWrap(fakeApi('store'), input, keys, s.appends)
          // The child "starts" here: the boundary is already there, and the refusals are not yet.
          s.log.push('spawn')
        }),
      ),
    )
    expect(s.log).toEqual(['before', 'spawn', 'after'])
    expect(s.rows.map((r) => r.type)).toEqual(['SandboxBoundaryRecorded', 'SandboxConnectionsRefused'])
    const [boundary, refused] = s.rows.map((r) => r.data as Record<string, any>)
    expect(boundary).toMatchObject({
      step: 'review',
      action: 'cold',
      runtime: 'claude-code',
      runId: 'run-1',
      commandId: 'cmd-1',
    })
    expect(boundary!['boundary']).toMatchObject({ kind: 'sandboxed', srtVersion: '1.2.3' })
    // The scope closed and emptied the fake's store; the event holds what was read first.
    expect(refused!['read']).toMatchObject({ kind: 'entries', entries: [{ host: 'evil.test' }] })
    expect(refused!['commandId']).toBe('cmd-1')
  })

  it('appends no refusals for a clean complete read, and does append an unreadable one', async () => {
    const clean = sink()
    await Effect.runPromise(
      Effect.scoped(
        recordingWrap(fakeApi({ kind: 'entries', entries: [], complete: true }), input, keys, clean.appends),
      ),
    )
    expect(clean.rows.map((r) => r.type)).toEqual(['SandboxBoundaryRecorded'])
    const bad = sink()
    await Effect.runPromise(
      Effect.scoped(recordingWrap(fakeApi({ kind: 'unreadable', reason: 'no' }), input, keys, bad.appends)),
    )
    expect(bad.rows.map((r) => r.type)).toEqual(['SandboxBoundaryRecorded', 'SandboxConnectionsRefused'])
  })

  it('a wrap that fails appends nothing', async () => {
    const s = sink()
    const api: SandboxApi = { ...fakeApi('store'), wrap: () => Effect.fail({ _tag: 'SandboxUnavailable' } as never) }
    await Effect.runPromise(Effect.scoped(recordingWrap(api, input, keys, s.appends)).pipe(Effect.ignore))
    expect(s.rows).toEqual([])
  })
})

describe('boundaries that are not wrapped', () => {
  it('maps each decision to its boundary', () => {
    expect(boundaryOfDecision({ kind: 'unsandboxed', reason: 'off by choice' })).toEqual({
      kind: 'unsandboxed',
      reason: 'off by choice',
    })
    expect(boundaryOfDecision({ kind: 'unsandboxed', reason: 'degraded', why: 'no bwrap' })).toEqual({
      kind: 'unsandboxed',
      reason: 'degraded',
      why: 'no bwrap',
    })
    expect(boundaryOfDecision({ kind: 'refused', why: 'nope' })).toEqual({ kind: 'refused', why: 'nope' })
  })

  it('records one boundary and no refusals, with no runId for a run: command', async () => {
    const s = sink()
    await Effect.runPromise(
      recordUnwrapped(
        { kind: 'unsandboxed', reason: 'off by choice' },
        { step: 'build', action: 'test', runId: null },
        s.appends.before,
      ),
    )
    expect(s.rows.map((r) => r.type)).toEqual(['SandboxBoundaryRecorded'])
    expect(s.rows[0]!.data).toMatchObject({ step: 'build', action: 'test', runId: null })
    expect((s.rows[0]!.data as { commandId: string }).commandId).not.toBe('')
  })
})

describe('a run: command', () => {
  it('is wrapped through makeRunSandbox and keyed by step and action, without a runtime', async () => {
    const s = sink()
    const run = makeRunSandbox(fakeApi('store'), {
      project: 'p',
      mirror: '/m',
      cache: '/c',
      additions: {},
      codexNamed: false,
      appends: s.appends,
      readCodexPermissions: () => ({ kind: 'none' }) as never,
    })
    const action = makeProcessAction({
      name: 'unit',
      run: 'pnpm test',
      env: {},
      step: 'build',
      sandbox: run,
      command: () => {
        s.log.push('spawn')
        return Effect.succeed({ ok: true, evidence: '', timedOut: false, durationMs: 0, exitCode: 0 })
      },
    })
    await Effect.runPromise(action.run({ cwd: '/w', env: {}, log: undefined } as never))
    expect(s.log).toEqual(['before', 'spawn', 'after'])
    expect(s.rows[0]!.data).toMatchObject({ step: 'build', action: 'unit', runId: null })
    expect((s.rows[0]!.data as Record<string, unknown>)['runtime']).toBeUndefined()
  })

  it('an unwrapped one records its boundary before it spawns', async () => {
    const s = sink()
    const action = makeProcessAction({
      name: 'unit',
      run: 'pnpm test',
      env: {},
      step: 'build',
      recordUnwrapped: () => s.appends.before([{ type: 'x', actor: 'a', data: {} } as never]),
      command: () => {
        s.log.push('spawn')
        return Effect.succeed({ ok: true, evidence: '', timedOut: false, durationMs: 0, exitCode: 0 })
      },
    })
    await Effect.runPromise(action.run({ cwd: '/w', env: {}, log: undefined } as never))
    expect(s.log).toEqual(['before', 'spawn'])
  })
})
