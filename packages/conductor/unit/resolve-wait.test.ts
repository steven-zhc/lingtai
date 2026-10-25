/**
 * `resolveWait` (#465, 0118 §11): the sole writer of `WaitResolved`, checked
 * against `createMemoryEventStore()` — no filesystem, no network (0060 §1).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  CONTROL_STREAM,
  type Action,
  type Envelope,
  parsePayload,
  reduceRun,
  reduceTicket,
  releaseCauseOf,
  waitsOf,
  ticketStream,
} from '@lingtai/domain'
import { aClaim, aRelease, aRoute, aRun, aRunRef, aWait, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { ConcurrencyError, type EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { refusingOn, resolveWaitHolding } from '../src/resolve-wait.ts'

const PROJECT = 'lingtai'
const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)

function fakeClient(refSha: string | null) {
  return { refSha: async () => refSha }
}

/** A `human:`/`watch:` signoff asking for approval, the way a `merge`/`proposed` signoff action reports it. */
function signoffAsks(onSha: string, name = 'human:land', question = 'land it?'): Action {
  return {
    plugin: 'human',
    name,
    onSha,
    evidence: '',
    yields: 'signoff',
    result: { _tag: 'Completed', requested: { question } },
  }
}

/** `proposed:build`/`merge:build`, refused — the gate `refusingOn` finds when nothing waived it. */
function refusedCheck(onSha: string, name = 'build'): Action {
  return {
    plugin: 'run',
    name,
    onSha,
    evidence: 'tsc failed',
    yields: 'verdict',
    result: { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } },
  }
}

async function seed(store: EventStore, streamId: string, events: readonly Envelope[]): Promise<void> {
  await store.append(streamId, (await store.read(streamId)).length, events)
}

describe('resolveWaitHolding, Split (#560)', () => {
  const child = (key: string, kind = 'feature') => ({ key, title: key, body: `work on ${key}`, kind })
  const sound = {
    _tag: 'Split' as const,
    children: [child('a'), child('b')],
    blockedBy: [{ ticket: 'b', blockedBy: 'a' }],
  }

  async function blockedOnFirstWait() {
    const store = createMemoryEventStore()
    const ticketId = ticketStream(PROJECT, 560)
    const item = makeStream(ticketId)
    const run = aRun('pass-560')
    const waitId = aWaitId()
    await seed(store, ticketId, [
      ...aClaim(item, run.runId),
      ...aWait(item, { _tag: 'NothingProduced', run: aRunRef(run.runId), said: null }, waitId),
    ])
    const split = (resolution: unknown, kinds?: readonly string[]) =>
      resolveWaitHolding(
        { ticketId, waitId, resolution: resolution as never, by: 'human:steven', kinds, store },
        ticketId,
      )
    return { store, ticketId, waitId, split }
  }

  it('refuses an invalid plan by name and appends nothing', async () => {
    const { store, ticketId, split } = await blockedOnFirstWait()
    const before = (await store.read(ticketId)).length
    const cyclic = {
      ...sound,
      blockedBy: [
        { ticket: 'a', blockedBy: 'b' },
        { ticket: 'b', blockedBy: 'a' },
      ],
    }
    expect(await split(cyclic, ['feature'])).toMatchObject({
      ok: false,
      reason: 'invalid-split',
      detail: expect.stringContaining('cycle'),
    })
    expect(await split({ ...sound, children: [child('a'), child('b', 'chore')] }, ['feature'])).toMatchObject({
      reason: 'invalid-split',
      detail: expect.stringContaining('chore'),
    })
    expect((await store.read(ticketId)).length).toBe(before)
  })

  it('refuses a plan with no kinds to check against', async () => {
    const { store, ticketId, split } = await blockedOnFirstWait()
    const before = (await store.read(ticketId)).length
    expect(await split(sound)).toMatchObject({ ok: false, reason: 'no-kinds' })
    expect((await store.read(ticketId)).length).toBe(before)
  })

  it('refuses a sound plan as not built: the wait stays current and nothing is recorded', async () => {
    const { store, ticketId, waitId, split } = await blockedOnFirstWait()
    const before = (await store.read(ticketId)).length
    expect(await split(sound, ['feature'])).toMatchObject({ ok: false, reason: 'split-not-built' })
    expect((await store.read(ticketId)).length).toBe(before)
    const lifecycle = reduceTicket(await store.read(ticketId)).lifecycle
    expect(lifecycle).toMatchObject({ status: 'blocked', waitId })
  })
})

describe('resolveWait', () => {
  it('refuses a WIP-only arm but grants the clean branch head beside a WIP arm', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream(PROJECT, 539)
    const item = makeStream(ticketId)
    const run = aRun('pass-539')
    const waitId = aWaitId()
    await seed(store, ticketId, [
      ...aClaim(item, run.runId),
      ...aWait(
        item,
        {
          _tag: 'ProposedEscalated',
          run: aRunRef(run.runId),
          proposal: { _tag: 'BuildRed', output: 'typecheck failed' },
          because: { _tag: 'NotAsked' },
        },
        waitId,
      ),
    ])
    await seed(store, run.runId, [
      run.event('RunRefsPublished', {
        branch: 'agent/539',
        arm: 'agent/539-attempt-1',
        headSha: SHA2,
        armSha: SHA2,
        branchCarries: false,
        outcome: 'arm-only',
        detail: null,
      }),
      run.event('RunKeptUncommitted', {
        arm: 'agent/539-attempt-1',
        sha: SHA2,
        parentSha: SHA,
        stoppedBy: 'out-of-turns',
        files: 1,
        insertions: 1,
        deletions: 0,
      }),
    ])
    const grant = (remote: string | null, selectedStore: EventStore = store) =>
      resolveWaitHolding(
        {
          ticketId,
          issue: 539,
          waitId,
          resolution: { _tag: 'GrantFixRound', onSha: '', ref: '' },
          by: 'human:steven',
          client: fakeClient(remote),
          store: selectedStore,
        },
        ticketId,
      )
    expect(await grant(SHA2)).toMatchObject({
      ok: false,
      reason: 'wip-head',
      detail: expect.stringContaining('clean commit'),
    })
    expect(waitsOf(await store.read(ticketId)).at(-1)?.resolution).toBeNull()
    await store.append(run.runId, (await store.read(run.runId)).length, [
      {
        type: 'RunRefsPublished',
        actor: 'conductor',
        data: run.event('RunRefsPublished', {
          branch: 'agent/539',
          arm: 'agent/539-attempt-2',
          headSha: SHA,
          armSha: SHA2,
          branchCarries: true,
          outcome: 'published',
          detail: null,
        }).data,
      },
    ])
    expect(await grant(SHA2)).toMatchObject({ ok: false, reason: 'stale' })
    expect(
      await resolveWaitHolding(
        {
          ticketId,
          issue: 539,
          waitId,
          resolution: { _tag: 'GrantFixRound', onSha: SHA2, ref: '' },
          by: 'human:steven',
          client: fakeClient(SHA),
          store,
        },
        ticketId,
      ),
    ).toMatchObject({ ok: false, reason: 'stale', detail: expect.stringContaining('displayed') })
    const unschedulable: EventStore = {
      ...store,
      append: async (streamId, expectedVersion, events) => {
        if (streamId === CONTROL_STREAM) throw new ConcurrencyError(streamId, expectedVersion, [expectedVersion + 1])
        return store.append(streamId, expectedVersion, events)
      },
    }
    expect(await grant(SHA, unschedulable)).toMatchObject({ ok: true, ticketId, unscheduled: expect.any(String) })
    expect(waitsOf(await store.read(ticketId)).at(-1)?.resolution).toEqual({
      _tag: 'GrantFixRound',
      onSha: SHA,
      ref: 'agent/539',
    })
    expect(reduceTicket(await store.read(ticketId)).lifecycle).toMatchObject({
      status: 'approved',
      runId: run.runId,
      onSha: SHA,
      grantRef: 'agent/539',
    })
    expect(
      await resolveWaitHolding(
        {
          ticketId,
          issue: 539,
          waitId,
          resolution: { _tag: 'GrantFixRound', onSha: SHA2, ref: '' },
          by: 'human:steven',
          client: fakeClient(SHA),
          store,
        },
        ticketId,
      ),
    ).toMatchObject({ ok: false, reason: 'not-blocked' })
    expect(await grant(SHA)).toEqual({ ok: true, ticketId, rescheduled: true })
    expect((await store.read(ticketId)).filter((e) => e.type === 'WaitResolved')).toHaveLength(1)
    expect((await store.read(CONTROL_STREAM)).filter((e) => e.type === 'ContinueRequested')).toHaveLength(1)
  })

  it('refuses an arm-only head so a fix cannot overwrite a diverged issue branch', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream(PROJECT, 540)
    const item = makeStream(ticketId)
    const run = aRun('pass-arm-only')
    const waitId = aWaitId()
    await seed(store, ticketId, [
      ...aClaim(item, run.runId),
      ...aWait(
        item,
        {
          _tag: 'ProposedEscalated',
          run: aRunRef(run.runId),
          proposal: { _tag: 'BuildRed', output: 'typecheck failed' },
          because: { _tag: 'NotAsked' },
        },
        waitId,
      ),
    ])
    await seed(store, run.runId, [
      run.event('RunRefsPublished', {
        branch: 'agent/540',
        arm: 'agent/540-attempt-1',
        headSha: SHA,
        outcome: 'arm-only',
        detail: 'issue branch lease refused',
      }),
    ])
    const result = await resolveWaitHolding(
      {
        ticketId,
        issue: 540,
        waitId,
        resolution: { _tag: 'GrantFixRound', onSha: '', ref: '' },
        by: 'human:steven',
        client: fakeClient(SHA),
        store,
      },
      ticketId,
    )
    expect(result).toMatchObject({
      ok: false,
      reason: 'branch-diverged',
      detail: expect.stringContaining('agent/540-attempt-1'),
    })
    expect((await store.read(ticketId)).filter((event) => event.type === 'WaitResolved')).toHaveLength(0)
  })

  describe("a person's requeue releases the held run ByPerson (0118 §7, #578)", () => {
    async function blockedAfterOneRestart(resolution: 'Requeue' | 'EditBodyAndRequeue') {
      const store = createMemoryEventStore()
      const ticketId = ticketStream(PROJECT, 578)
      const item = makeStream(ticketId)
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-1'),
        ...aRelease(item, 'pass-1', 'restart', { _tag: 'Restart', restart: 1 }),
        ...aClaim(item, 'pass-2'),
        ...aWait(
          item,
          { _tag: 'AgentQuestion', run: aRunRef('pass-2'), step: 'implement', question: 'which?' },
          waitId,
        ),
      ])
      const before = reduceTicket(await store.read(ticketId)).restarts.length
      const result = await resolveWaitHolding(
        { ticketId, issue: 578, waitId, resolution: { _tag: resolution }, by: 'human:steven', store },
        ticketId,
      )
      return { store, ticketId, waitId, before, result }
    }

    it.each(['Requeue', 'EditBodyAndRequeue'] as const)(
      '%s appends the release and leaves restarts alone',
      async (tag) => {
        const { store, ticketId, waitId, before, result } = await blockedAfterOneRestart(tag)

        expect(result.ok).toBe(true)
        const events = await store.read(ticketId)
        expect(releaseCauseOf(events)).toEqual([
          { _tag: 'Restart', restart: 1 },
          { _tag: 'ByPerson', waitId },
        ])
        const folded = reduceTicket(events)
        expect(before).toBe(1)
        expect(folded.restarts).toHaveLength(before)
        expect(folded.lifecycle.status).toBe('backlog')
      },
    )

    it('releases nothing for a question asked before any run', async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream(PROJECT, 579)
      const item = makeStream(ticketId)
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aWait(item, { _tag: 'OwnQuestion', question: 'which?', by: 'human:steven' }, waitId),
      ])

      const result = await resolveWaitHolding(
        { ticketId, issue: 579, waitId, resolution: { _tag: 'Requeue' }, by: 'human:steven', store },
        ticketId,
      )

      expect(result.ok).toBe(true)
      expect(releaseCauseOf(await store.read(ticketId))).toEqual([])
    })
  })

  it('refuses a stale waitId — the item is blocked on a different wait', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream(PROJECT, 1)
    const item = makeStream(ticketId)
    await seed(store, ticketId, [
      ...aClaim(item, 'pass-1'),
      ...aWait(item, { _tag: 'AgentQuestion', run: aRunRef('pass-1'), step: 'implement', question: 'which helper?' }),
    ])

    const result = await resolveWaitHolding(
      {
        ticketId: ticketStream(PROJECT, 1),
        issue: 1,
        waitId: aWaitId(),
        resolution: { _tag: 'Requeue' },
        by: 'human:steven',
        store,
      },
      ticketId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'not-blocked' })
    expect((await store.read(ticketId)).some((e) => e.type === 'WaitResolved')).toBe(false)
  })

  it('refuses an item nothing is blocking', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream(PROJECT, 2)
    const result = await resolveWaitHolding(
      {
        ticketId: ticketStream(PROJECT, 2),
        issue: 2,
        waitId: aWaitId(),
        resolution: { _tag: 'Requeue' },
        by: 'human:steven',
        store,
      },
      ticketId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'not-blocked' })
  })

  describe('ContinueConflict (#558)', () => {
    const REF = 'agent/558'
    const hunks = [
      { _tag: 'Divergent' as const, path: 'a.ts', line: 1, behavior: 'keep new', adopted: null },
      { _tag: 'Mechanical' as const, path: 'b.ts', line: 4 },
    ]
    const counts = async () => [
      { path: 'a.ts', hunkLines: [1] },
      { path: 'b.ts', hunkLines: [4] },
    ]

    /** Blocked on a conflict between base `SHA` and the preserved head `SHA2`. */
    async function blocked(opts: { exhausted?: boolean; wip?: boolean } = {}) {
      const store = createMemoryEventStore()
      const ticketId = ticketStream(PROJECT, 558)
      const item = makeStream(ticketId)
      const run = aRun('pass-558')
      const waitId = aWaitId()
      const proposal = {
        _tag: 'MergeConflict' as const,
        output: 'conflict',
        paths: ['a.ts'],
        baseSha: SHA,
        headSha: SHA2,
      }
      await seed(store, ticketId, [
        ...aClaim(item, run.runId),
        ...aWait(
          item,
          { _tag: 'ProposedEscalated', run: aRunRef(run.runId), proposal, because: { _tag: 'NotAsked' } },
          waitId,
        ),
      ])
      await seed(store, run.runId, [
        run.event('RunRefsPublished', {
          branch: REF,
          arm: `${REF}-attempt-1`,
          headSha: SHA2,
          armSha: opts.wip ? SHA : null,
          branchCarries: !opts.wip,
          outcome: opts.wip ? 'arm-only' : 'published',
          detail: null,
        }),
        ...aRoute(run, {
          offer: {
            proposal,
            available: opts.exhausted ? [{ id: 'hand-to-person', next: { _tag: 'HandToPerson' } }] : [],
            unavailable: opts.exhausted
              ? [{ id: 'fix-lines', because: { _tag: 'CeilingReached', ceiling: 'rounds' } }]
              : [],
          },
          reply: { _tag: 'NotAsked' },
          decision: { _tag: 'Escalated', because: { _tag: 'NotAsked' } },
        }),
      ])
      return { store, ticketId, waitId, run }
    }

    const continued = (
      b: { store: EventStore; ticketId: string; waitId: ReturnType<typeof aWaitId> },
      over: Record<string, unknown> = {},
      options: Record<string, unknown> = {},
    ) =>
      resolveWaitHolding(
        {
          ticketId: b.ticketId,
          issue: 558,
          waitId: b.waitId,
          resolution: {
            _tag: 'ContinueConflict',
            baseSha: SHA,
            headSha: SHA2,
            ref: REF,
            grantExtraRound: false,
            hunks,
            ...over,
          } as never,
          by: 'human:steven',
          base: 'main',
          conflicts: counts,
          client: {
            refSha: async (ref: string) => (ref === 'heads/main' ? SHA : ref === `heads/${REF}` ? SHA2 : null),
          },
          store: b.store,
          ...options,
        },
        b.ticketId,
      )

    /** The refusal appended nothing: not to the ticket, and no continuation was requested. */
    async function expectRefused(
      b: Awaited<ReturnType<typeof blocked>>,
      result: Awaited<ReturnType<typeof continued>>,
      reason: string,
    ) {
      const before = (await b.store.read(b.ticketId)).length
      expect(result).toMatchObject({ ok: false, reason })
      expect((await b.store.read(b.ticketId)).length).toBe(before)
      expect((await b.store.read(CONTROL_STREAM)).filter((e) => e.type === 'ContinueRequested')).toHaveLength(0)
      expect(waitsOf(await b.store.read(b.ticketId)).at(-1)?.resolution).toBeNull()
    }

    it('appends one WaitResolved and one ContinueRequested, and a second call adds no second WaitResolved but re-asks for the row', async () => {
      const b = await blocked()
      expect(await continued(b)).toMatchObject({ ok: true })
      const resolved = (await b.store.read(b.ticketId)).filter((e) => e.type === 'WaitResolved')
      expect(resolved).toHaveLength(1)
      expect(reduceTicket(await b.store.read(b.ticketId)).lifecycle).toMatchObject({
        status: 'approved',
        onSha: SHA2,
        grantRef: REF,
      })
      const requests = async () => (await b.store.read(CONTROL_STREAM)).filter((e) => e.type === 'ContinueRequested')
      expect(await requests()).toHaveLength(1)

      // The way out of an unscheduled continuation: no second resolution, but the
      // request is owed again, so it is appended again.
      expect(await continued(b)).toMatchObject({ ok: true, rescheduled: true })
      expect((await b.store.read(b.ticketId)).filter((e) => e.type === 'WaitResolved')).toHaveLength(1)
      expect(await requests()).toHaveLength(2)
    })

    it("does not report another person's confirmation as a different caller's success", async () => {
      const b = await blocked()
      expect(await continued(b)).toMatchObject({ ok: true })
      const requests = async () => (await b.store.read(CONTROL_STREAM)).filter((e) => e.type === 'ContinueRequested')
      const before = (await b.store.read(b.ticketId)).length
      const other = await continued(b, { hunks: [{ ...hunks[0]!, _tag: 'Divergent', behavior: 'x', adopted: null }] })
      expect(other).toMatchObject({ ok: false, reason: 'already-confirmed' })
      expect(await continued(b, { baseSha: 'c'.repeat(40) })).toMatchObject({ ok: false, reason: 'already-confirmed' })
      expect((await b.store.read(b.ticketId)).length).toBe(before)
      expect(await requests()).toHaveLength(1)
    })

    it('refuses a moved base', async () => {
      const b = await blocked()
      const client = { refSha: async (ref: string) => (ref === 'heads/main' ? 'c'.repeat(40) : SHA2) }
      await expectRefused(b, await continued(b, {}, { client }), 'base-moved')
    })

    it('refuses a moved head, and a command naming another one', async () => {
      const b = await blocked()
      const client = { refSha: async (ref: string) => (ref === 'heads/main' ? SHA : 'c'.repeat(40)) }
      await expectRefused(b, await continued(b, {}, { client }), 'ref-moved')
      await expectRefused(b, await continued(b, { headSha: 'c'.repeat(40) }), 'stale')
    })

    it('refuses a missing or other preserved ref', async () => {
      const b = await blocked()
      const client = { refSha: async (ref: string) => (ref === 'heads/main' ? SHA : null) }
      await expectRefused(b, await continued(b, {}, { client }), 'ref-missing')
      await expectRefused(b, await continued(b, { ref: 'agent/other' }), 'head-moved')
    })

    it('refuses saved work that is a WIP arm', async () => {
      const b = await blocked({ wip: true })
      await expectRefused(b, await continued(b), 'unrecorded-wip')
    })

    it('refuses hunks that are not the mirror count', async () => {
      const b = await blocked()
      await expectRefused(b, await continued(b, { hunks: hunks.slice(0, 1) }), 'hunks-mismatch')
    })

    it('refuses when the mirror throws, never counting zero hunks', async () => {
      const b = await blocked()
      const conflicts = async () => {
        throw new Error('no git')
      }
      await expectRefused(b, await continued(b, {}, { conflicts }), 'conflicts-unreadable')
    })

    it('refuses by name what it was not handed', async () => {
      const b = await blocked()
      await expectRefused(b, await continued(b, {}, { base: undefined }), 'no-base')
      await expectRefused(b, await continued(b, {}, { conflicts: undefined }), 'no-conflicts')
      await expectRefused(b, await continued(b, {}, { client: undefined }), 'no-client')
    })

    it('needs the extra round granted once the automatic rounds are spent', async () => {
      const b = await blocked({ exhausted: true })
      await expectRefused(b, await continued(b), 'grant-required')
      expect(await continued(b, { grantExtraRound: true })).toMatchObject({ ok: true })
      expect(waitsOf(await b.store.read(b.ticketId)).at(-1)?.resolution).toMatchObject({ grantExtraRound: true })
    })

    it('refuses a grant nobody needed', async () => {
      const b = await blocked()
      await expectRefused(b, await continued(b, { grantExtraRound: true }), 'grant-not-needed')
    })
  })

  describe('refuses a disallowed resolution by name', () => {
    it('AnswerQuestion is not offered for AgentQuestion', async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream(PROJECT, 3)
      const item = makeStream(ticketId)
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-3'),
        ...aWait(
          item,
          { _tag: 'AgentQuestion', run: aRunRef('pass-3'), step: 'implement', question: 'which?' },
          waitId,
        ),
      ])

      const result = await resolveWaitHolding(
        {
          ticketId: ticketStream(PROJECT, 3),
          issue: 3,
          waitId,
          resolution: { _tag: 'AnswerQuestion', choice: 'the first' },
          by: 'human:steven',
          store,
        },
        ticketId,
      )
      expect(result).toMatchObject({
        ok: false,
        reason: 'not-offered',
        detail: 'AnswerQuestion is not offered for AgentQuestion — nothing was resolved.',
      })
      expect((await store.read(ticketId)).some((e) => e.type === 'WaitResolved')).toBe(false)
    })

    it('Approve is not offered for ProposedEscalated{BuildRed}', async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream(PROJECT, 4)
      const item = makeStream(ticketId)
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-4'),
        ...aWait(
          item,
          {
            _tag: 'ProposedEscalated',
            run: aRunRef('pass-4'),
            proposal: { _tag: 'BuildRed', output: 'tsc failed' },
            because: { _tag: 'NotAsked' },
          },
          waitId,
        ),
      ])

      const result = await resolveWaitHolding(
        {
          ticketId: ticketStream(PROJECT, 4),
          issue: 4,
          waitId,
          resolution: { _tag: 'Approve', onSha: SHA },
          by: 'human:steven',
          store,
        },
        ticketId,
      )
      expect(result).toMatchObject({
        ok: false,
        reason: 'not-offered',
        detail: 'Approve is not offered for ProposedEscalated{BuildRed} — nothing was resolved.',
      })
    })

    it('Approve is not offered for an unpushed run', async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream(PROJECT, 5)
      const item = makeStream(ticketId)
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-5'),
        ...aWait(
          item,
          {
            _tag: 'SignoffRequired',
            run: { runId: 'pass-5', unpushed: { branch: 'agent/5', said: 'nothing to push' } },
            step: 'merge',
            action: 'human:land',
            question: 'land it?',
          },
          waitId,
        ),
      ])

      const result = await resolveWaitHolding(
        {
          ticketId: ticketStream(PROJECT, 5),
          issue: 5,
          waitId,
          resolution: { _tag: 'Approve', onSha: SHA },
          by: 'human:steven',
          store,
        },
        ticketId,
      )
      expect(result).toMatchObject({ ok: false, reason: 'not-offered' })
    })
  })

  describe('Approve', () => {
    it('refuses when the run is not awaiting approval and has no head', async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream(PROJECT, 6)
      const item = makeStream(ticketId)
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-6'),
        ...aWait(
          item,
          {
            _tag: 'SignoffRequired',
            run: aRunRef('pass-6'),
            step: 'merge',
            action: 'human:land',
            question: 'land it?',
          },
          waitId,
        ),
      ])

      const result = await resolveWaitHolding(
        {
          ticketId: ticketStream(PROJECT, 6),
          issue: 6,
          waitId,
          resolution: { _tag: 'Approve', onSha: SHA },
          by: 'human:steven',
          store,
        },
        ticketId,
      )
      expect(result).toMatchObject({ ok: false, reason: 'not-awaiting-approval' })
    })

    it('refuses an Approve missing the client or the issue — the branch check cannot be skipped', async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream(PROJECT, 31)
      const item = makeStream(ticketId)
      const run = aRun('pass-31')
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-31'),
        ...aWait(
          item,
          {
            _tag: 'SignoffRequired',
            run: aRunRef('pass-31'),
            step: 'merge',
            action: 'human:land',
            question: 'land it?',
          },
          waitId,
        ),
      ])
      await seed(store, 'pass-31', run.aStepEnded({ step: 'merge', round: 0, actions: [signoffAsks(SHA)] }))

      const result = await resolveWaitHolding(
        {
          ticketId: ticketStream(PROJECT, 31),
          waitId,
          resolution: { _tag: 'Approve', onSha: SHA },
          by: 'human:steven',
          store,
        },
        ticketId,
      )
      expect(result).toMatchObject({ ok: false, reason: 'no-client' })
      expect((await store.read(ticketId)).some((e) => e.type === 'WaitResolved')).toBe(false)
    })

    it('refuses an onSha that has moved on from what the run is now asking about — appends nothing', async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream(PROJECT, 7)
      const item = makeStream(ticketId)
      const run = aRun('pass-7')
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-7'),
        ...aWait(
          item,
          {
            _tag: 'SignoffRequired',
            run: aRunRef('pass-7'),
            step: 'merge',
            action: 'human:land',
            question: 'land it?',
          },
          waitId,
        ),
      ])
      await seed(store, 'pass-7', run.aStepEnded({ step: 'merge', round: 0, actions: [signoffAsks(SHA)] }))

      const result = await resolveWaitHolding(
        {
          ticketId: ticketStream(PROJECT, 7),
          issue: 7,
          waitId,
          resolution: { _tag: 'Approve', onSha: SHA2 },
          by: 'human:steven',
          client: fakeClient(SHA),
          store,
        },
        ticketId,
      )
      expect(result).toMatchObject({ ok: false, reason: 'stale' })
      expect((await store.read(ticketId)).some((e) => e.type === 'WaitResolved')).toBe(false)
    })

    it("refuses when the branch moved on origin since the approval's sha — appends nothing", async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream(PROJECT, 8)
      const item = makeStream(ticketId)
      const run = aRun('pass-8')
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-8'),
        ...aWait(
          item,
          {
            _tag: 'SignoffRequired',
            run: aRunRef('pass-8'),
            step: 'merge',
            action: 'human:land',
            question: 'land it?',
          },
          waitId,
        ),
      ])
      await seed(store, 'pass-8', run.aStepEnded({ step: 'merge', round: 0, actions: [signoffAsks(SHA)] }))

      const result = await resolveWaitHolding(
        {
          ticketId: ticketStream(PROJECT, 8),
          issue: 8,
          waitId,
          resolution: { _tag: 'Approve', onSha: SHA },
          by: 'human:steven',
          client: fakeClient(SHA2),
          store,
        },
        ticketId,
      )
      expect(result).toMatchObject({ ok: false, reason: 'stale' })
      expect((await store.read(ticketId)).some((e) => e.type === 'WaitResolved')).toBe(false)
    })

    it('appends WaitResolved{Approve} once every check passes, and moves the lifecycle to approved', async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream(PROJECT, 9)
      const item = makeStream(ticketId)
      const run = aRun('pass-9')
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-9'),
        ...aWait(
          item,
          {
            _tag: 'SignoffRequired',
            run: aRunRef('pass-9'),
            step: 'merge',
            action: 'human:land',
            question: 'land it?',
          },
          waitId,
        ),
      ])
      await seed(store, 'pass-9', run.aStepEnded({ step: 'merge', round: 0, actions: [signoffAsks(SHA)] }))

      const result = await resolveWaitHolding(
        {
          ticketId: ticketStream(PROJECT, 9),
          issue: 9,
          waitId,
          resolution: { _tag: 'Approve', onSha: SHA },
          by: 'human:steven',
          client: fakeClient(SHA),
          store,
        },
        ticketId,
      )
      expect(result).toEqual({ ok: true, ticketId })

      const events = await store.read(ticketId)
      const wait = waitsOf(events).at(-1)
      expect(wait?.resolution).toEqual({ _tag: 'Approve', onSha: SHA })
      // `Approve` moves the lifecycle to `approved` (#465) — a continuation
      // is owed, not a fresh claim, until `continueTicket` takes it.
      expect(reduceTicket(events).lifecycle).toMatchObject({
        status: 'approved',
        runId: 'pass-9',
        waitId,
        onSha: SHA,
      })
    })

    /**
     * **A lost race on the `ContinueRequested` append must never read back as
     * the approval failing** (#465) — `WaitResolved{Approve}` has already
     * committed by the time this second append runs, so a caller told
     * `ok: false` here would be told something false: a webhook route or the
     * reconcile sweep appending to `CONTROL_STREAM` at the same moment is
     * exactly the kind of race this retries past.
     */
    it('retries the control-stream append on a lost race, and still reports the approval granted', async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream(PROJECT, 32)
      const item = makeStream(ticketId)
      const run = aRun('pass-32')
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-32'),
        ...aWait(
          item,
          {
            _tag: 'SignoffRequired',
            run: aRunRef('pass-32'),
            step: 'merge',
            action: 'human:land',
            question: 'land it?',
          },
          waitId,
        ),
      ])
      await seed(store, 'pass-32', run.aStepEnded({ step: 'merge', round: 0, actions: [signoffAsks(SHA)] }))

      // A racing writer — a webhook, the reconcile sweep, another approval
      // on a different ticket — appends to the control stream once, between
      // this call's read and its first attempt.
      let racedOnce = false
      const flaky: EventStore = {
        ...store,
        append: async (streamId, expectedVersion, events) => {
          if (streamId === CONTROL_STREAM && !racedOnce) {
            racedOnce = true
            await store.append(streamId, expectedVersion, [
              {
                type: 'ContinueRequested',
                actor: 'human:someone-else',
                data: parsePayload('ContinueRequested', {
                  project: PROJECT,
                  issue: '999',
                  runId: 'pass-999',
                  by: 'human:someone-else',
                  waitId: null,
                }),
              },
            ])
            throw new ConcurrencyError(streamId, expectedVersion, [expectedVersion + 1])
          }
          return store.append(streamId, expectedVersion, events)
        },
      }

      const result = await resolveWaitHolding(
        {
          ticketId: ticketStream(PROJECT, 32),
          issue: 32,
          waitId,
          resolution: { _tag: 'Approve', onSha: SHA },
          by: 'human:steven',
          client: fakeClient(SHA),
          store: flaky,
        },
        ticketId,
      )
      expect(result).toEqual({ ok: true, ticketId })
      expect(racedOnce).toBe(true)

      const control = await store.read(CONTROL_STREAM)
      expect(control.map((e) => e.type)).toEqual(['ContinueRequested', 'ContinueRequested'])
      expect(control.at(-1)?.data).toMatchObject({ issue: '32', runId: 'pass-32' })
    })

    /**
     * Even once every retry is spent — or the store refuses for a reason
     * that is never going to clear — the approval already on the ticket
     * stream is still reported as granted. The gap left behind (no
     * `ContinueRequested` on the log) is a different problem's to notice,
     * never this call's to misreport — but it is carried on `unscheduled`
     * rather than lost outright, so a caller can say why.
     */
    it('reports the approval granted, with `unscheduled` set, when the control-stream append never lands at all', async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream(PROJECT, 33)
      const item = makeStream(ticketId)
      const run = aRun('pass-33')
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-33'),
        ...aWait(
          item,
          {
            _tag: 'SignoffRequired',
            run: aRunRef('pass-33'),
            step: 'merge',
            action: 'human:land',
            question: 'land it?',
          },
          waitId,
        ),
      ])
      await seed(store, 'pass-33', run.aStepEnded({ step: 'merge', round: 0, actions: [signoffAsks(SHA)] }))

      const alwaysLosesTheRace: EventStore = {
        ...store,
        append: async (streamId, expectedVersion, events) => {
          if (streamId === CONTROL_STREAM) throw new ConcurrencyError(streamId, expectedVersion, [expectedVersion + 1])
          return store.append(streamId, expectedVersion, events)
        },
      }

      const result = await resolveWaitHolding(
        {
          ticketId: ticketStream(PROJECT, 33),
          issue: 33,
          waitId,
          resolution: { _tag: 'Approve', onSha: SHA },
          by: 'human:steven',
          client: fakeClient(SHA),
          store: alwaysLosesTheRace,
        },
        ticketId,
      )
      expect(result.ok).toBe(true)
      expect(result).toMatchObject({ ok: true, ticketId, unscheduled: expect.any(String) })

      const events = await store.read(ticketId)
      expect(reduceTicket(events).lifecycle).toMatchObject({ status: 'approved' })
      expect((await store.read(CONTROL_STREAM)).some((e) => e.type === 'ContinueRequested')).toBe(false)
    })

    /**
     * **The retry has to cover the read, not only the append** (#465). A
     * dropped connection on `store.read(CONTROL_STREAM)` is as transient as
     * a lost version race on the append after it — this repo's own notes on
     * the pooler record that failure as routine — and before this fix it
     * threw straight out of `resolveWaitHolding` after `WaitResolved` had
     * already committed.
     */
    it('retries the control-stream read too, not only the append, on a dropped connection', async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream(PROJECT, 34)
      const item = makeStream(ticketId)
      const run = aRun('pass-34')
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-34'),
        ...aWait(
          item,
          {
            _tag: 'SignoffRequired',
            run: aRunRef('pass-34'),
            step: 'merge',
            action: 'human:land',
            question: 'land it?',
          },
          waitId,
        ),
      ])
      await seed(store, 'pass-34', run.aStepEnded({ step: 'merge', round: 0, actions: [signoffAsks(SHA)] }))

      let readFailedOnce = false
      const flaky: EventStore = {
        ...store,
        read: async (streamId, fromVersion) => {
          if (streamId === CONTROL_STREAM && !readFailedOnce) {
            readFailedOnce = true
            throw new Error('connection terminated unexpectedly')
          }
          return store.read(streamId, fromVersion)
        },
      }

      const result = await resolveWaitHolding(
        {
          ticketId: ticketStream(PROJECT, 34),
          issue: 34,
          waitId,
          resolution: { _tag: 'Approve', onSha: SHA },
          by: 'human:steven',
          client: fakeClient(SHA),
          store: flaky,
        },
        ticketId,
      )
      expect(result).toEqual({ ok: true, ticketId })
      expect(readFailedOnce).toBe(true)
      expect((await store.read(CONTROL_STREAM)).map((e) => e.type)).toEqual(['ContinueRequested'])
    })

    /**
     * Every other error, not only `ConcurrencyError`, is retried — the same
     * dropped-connection reasoning, this time on the append itself.
     */
    it('retries the control-stream append on any error, not only a ConcurrencyError', async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream(PROJECT, 35)
      const item = makeStream(ticketId)
      const run = aRun('pass-35')
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-35'),
        ...aWait(
          item,
          {
            _tag: 'SignoffRequired',
            run: aRunRef('pass-35'),
            step: 'merge',
            action: 'human:land',
            question: 'land it?',
          },
          waitId,
        ),
      ])
      await seed(store, 'pass-35', run.aStepEnded({ step: 'merge', round: 0, actions: [signoffAsks(SHA)] }))

      let appendFailedOnce = false
      const flaky: EventStore = {
        ...store,
        append: async (streamId, expectedVersion, events) => {
          if (streamId === CONTROL_STREAM && !appendFailedOnce) {
            appendFailedOnce = true
            throw new Error('connection terminated unexpectedly')
          }
          return store.append(streamId, expectedVersion, events)
        },
      }

      const result = await resolveWaitHolding(
        {
          ticketId: ticketStream(PROJECT, 35),
          issue: 35,
          waitId,
          resolution: { _tag: 'Approve', onSha: SHA },
          by: 'human:steven',
          client: fakeClient(SHA),
          store: flaky,
        },
        ticketId,
      )
      expect(result).toEqual({ ok: true, ticketId })
      expect(appendFailedOnce).toBe(true)
      expect((await store.read(CONTROL_STREAM)).map((e) => e.type)).toEqual(['ContinueRequested'])
    })

    /**
     * **The way out** (#465). The first approval's `ContinueRequested` never
     * lands (the control stream always refuses), so the row is lost even
     * though `WaitResolved{Approve}` committed and the item sits `approved`.
     * A second `Approve` naming the same wait and the same sha reschedules
     * it — no second `WaitResolved` (`resolveWait` stays the only writer,
     * checked below the same way the file's own header test does), only the
     * `ContinueRequested` row.
     */
    it('reschedules a lost continuation on a second Approve of the same wait and sha, writing no second WaitResolved', async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream(PROJECT, 36)
      const item = makeStream(ticketId)
      const run = aRun('pass-36')
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-36'),
        ...aWait(
          item,
          {
            _tag: 'SignoffRequired',
            run: aRunRef('pass-36'),
            step: 'merge',
            action: 'human:land',
            question: 'land it?',
          },
          waitId,
        ),
      ])
      await seed(store, 'pass-36', run.aStepEnded({ step: 'merge', round: 0, actions: [signoffAsks(SHA)] }))

      const neverSchedules: EventStore = {
        ...store,
        append: async (streamId, expectedVersion, events) => {
          if (streamId === CONTROL_STREAM) throw new Error('connection terminated unexpectedly')
          return store.append(streamId, expectedVersion, events)
        },
      }

      const first = await resolveWaitHolding(
        {
          ticketId: ticketStream(PROJECT, 36),
          issue: 36,
          waitId,
          resolution: { _tag: 'Approve', onSha: SHA },
          by: 'human:steven',
          client: fakeClient(SHA),
          store: neverSchedules,
        },
        ticketId,
      )
      expect(first).toMatchObject({ ok: true, ticketId, unscheduled: expect.any(String) })
      expect((await store.read(CONTROL_STREAM)).some((e) => e.type === 'ContinueRequested')).toBe(false)

      const second = await resolveWaitHolding(
        {
          ticketId: ticketStream(PROJECT, 36),
          issue: 36,
          waitId,
          resolution: { _tag: 'Approve', onSha: SHA },
          by: 'human:steven',
          client: fakeClient(SHA),
          store,
        },
        ticketId,
      )
      expect(second).toEqual({ ok: true, ticketId, rescheduled: true })

      const control = await store.read(CONTROL_STREAM)
      expect(control.map((e) => e.type)).toEqual(['ContinueRequested'])
      expect(control[0]?.data).toMatchObject({ issue: '36', runId: 'pass-36' })

      const ticketEvents = await store.read(ticketId)
      expect(ticketEvents.filter((e) => e.type === 'WaitResolved')).toHaveLength(1)
    })

    it('requires a note when a refusal still stands on the sha, and refuses without one', async () => {
      const store = createMemoryEventStore()
      const ticketId = ticketStream(PROJECT, 10)
      const item = makeStream(ticketId)
      const run = aRun('pass-10')
      const waitId = aWaitId()
      await seed(store, ticketId, [
        ...aClaim(item, 'pass-10'),
        ...aWait(
          item,
          {
            _tag: 'SignoffRequired',
            run: aRunRef('pass-10'),
            step: 'merge',
            action: 'human:land',
            question: 'land it?',
          },
          waitId,
        ),
      ])
      await seed(store, 'pass-10', [
        ...run.aStepEnded({ step: 'build', round: 0, actions: [refusedCheck(SHA)] }),
        ...run.aStepEnded({ step: 'merge', round: 0, actions: [signoffAsks(SHA)] }),
      ])

      const withoutNote = await resolveWaitHolding(
        {
          ticketId: ticketStream(PROJECT, 10),
          issue: 10,
          waitId,
          resolution: { _tag: 'Approve', onSha: SHA },
          by: 'human:steven',
          client: fakeClient(SHA),
          store,
        },
        ticketId,
      )
      expect(withoutNote).toMatchObject({ ok: false, reason: 'reason-required' })
      expect((await store.read(ticketId)).some((e) => e.type === 'WaitResolved')).toBe(false)

      const withNote = await resolveWaitHolding(
        {
          ticketId: ticketStream(PROJECT, 10),
          issue: 10,
          waitId,
          resolution: { _tag: 'Approve', onSha: SHA },
          by: 'human:steven',
          note: 'waiving the build failure',
          client: fakeClient(SHA),
          store,
        },
        ticketId,
      )
      expect(withNote).toEqual({ ok: true, ticketId })
    })
  })

  it('refuses on a version conflict — something else moved the item between the read and the append', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream(PROJECT, 11)
    const item = makeStream(ticketId)
    const waitId = aWaitId()
    await seed(store, ticketId, [
      ...aClaim(item, 'pass-11'),
      ...aWait(item, { _tag: 'AgentQuestion', run: aRunRef('pass-11'), step: 'implement', question: 'which?' }, waitId),
    ])
    // Simulates a second decision landing between this test's read and its
    // own append — `resolveWaitHolding` reads once, at the top.
    await store.append(ticketId, 2, [
      {
        type: 'WaitResolved',
        actor: 'human:someone-else',
        data: { waitId, by: 'human:someone-else', resolution: { _tag: 'Requeue' }, note: '' },
      },
    ])

    const result = await resolveWaitHolding(
      {
        ticketId: ticketStream(PROJECT, 11),
        issue: 11,
        waitId,
        resolution: { _tag: 'EditBodyAndRequeue' },
        by: 'human:steven',
        store,
      },
      ticketId,
    )
    expect(result).toMatchObject({ ok: false, reason: 'not-blocked' })
  })

  it('refusingOn excludes the signoff this approval is itself answering', async () => {
    const store = createMemoryEventStore()
    const run = aRun('pass-12')
    await seed(store, 'pass-12', run.aStepEnded({ step: 'merge', round: 0, actions: [signoffAsks(SHA)] }))

    const folded = reduceRun(await store.read('pass-12'))
    expect(refusingOn(folded, SHA)).toEqual([])
  })

  /**
   * **The claim this file's own header makes, checked against the source
   * tree rather than asserted in prose.** `approve.ts`, `ask.ts` and
   * `close.ts` each wrote `WaitResolved` once before #465 — three separate
   * append sites a fourth caller could drift from. A grep rather than an
   * import list, so a thirteenth file added later and forgetting this rule
   * fails here too.
   */
  it("is the only src file that writes type: 'WaitResolved'", () => {
    const srcDir = fileURLToPath(new URL('../src', import.meta.url))
    const offenders = readdirSync(srcDir)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => name !== 'resolve-wait.ts')
      .filter((name) => readFileSync(`${srcDir}/${name}`, 'utf8').includes("type: 'WaitResolved'"))
    expect(offenders).toEqual([])
  })
})
