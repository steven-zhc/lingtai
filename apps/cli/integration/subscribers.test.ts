import { integrationStream, type ToAppend, workItemStream } from '@lingtai/domain'
/**
 * Which project an event is about, against the real log.
 *
 * This is the file that answers the refusal that ended attempt 3 of `#123`. The
 * old subscription was `{ project: "*" }` and short-circuited before it ever
 * looked at a stream; a per-recipe one cannot, and **three of the four types
 * this repository declares are appended to no work item stream** (#502):
 *
 *   `WaitStarted`          `ticket-{project}-{n}`    the stream says it
 *   `IntegrationRefused`   `int-{project}-{base}` `data.ticketId` says it
 *   `StepEnded`            `pass-<uuid>`          only the run's `RunStarted`
 *   `RunAwaitingInput`     `pass-<uuid>`          the same
 *
 * So all four are appended here exactly as `conduct.ts`, `hook-socket.ts` and
 * `integrate.ts` append them, and the resolver is asked. A mock store would
 * have passed for the version that was refused, because the thing it got wrong
 * was what the log actually holds.
 */
import { aRun, anOutcome, aWait } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { processEventStore, type EventStore } from '@lingtai/event-store'
import { beforeAll, describe, expect, it } from 'vitest'

import { createSubjectResolver } from '../src/subscribers.ts'

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`
const wi = workItemStream(PROJECT, 7)
const runId = `pass-${crypto.randomUUID()}`
const startless = `pass-${crypto.randomUUID()}`
const lane = integrationStream(PROJECT, 'main')

let store: EventStore
let subject: ReturnType<typeof createSubjectResolver>

/** The envelope the resolver is handed, off the log rather than made up. */
const head = async (streamId: string) => {
  const events = await store.read(streamId)
  const last = events.at(-1)
  if (!last) throw new Error(`${streamId} is empty`)
  return last
}

beforeAll(async () => {
  store = await processEventStore()
  subject = createSubjectResolver(store)

  // A run stream, opened the way `conduct.ts` opens one: `RunStarted` first,
  // carrying the work item, and then the events that carry only a `runId`.
  await store.append(runId, 0, [
    {
      type: 'RunStarted',
      actor: 'conductor',
      data: {
        ticketId: wi,
        runtime: 'claude-code',
        model: 'claude-opus-5',
        promptVersion: 'v1',
        baseSha: 'a'.repeat(40),
        configHash: 'b'.repeat(12),
        worktree: '/tmp/wt',
        invocation: null,
      },
    },
  ])
  const toAppend = (events: readonly { type: string; actor: string; data: unknown }[]): ToAppend[] =>
    events.map((e) => ({ type: e.type, actor: e.actor, data: e.data }))

  await store.append(
    runId,
    1,
    toAppend(
      aRun(runId).aStepEnded(
        anOutcome('merge', 0, [
          {
            plugin: 'human',
            name: 'approve',
            onSha: 'c'.repeat(40),
            evidence: 'Merge into main?',
            yields: 'signoff',
            result: { _tag: 'Completed', requested: { question: 'Merge into main?' } },
          },
        ]),
      ),
    ),
  )
  await store.append(runId, 3, [{ type: 'RunAwaitingInput', actor: `agent:${runId}`, data: { prompt: 'which base?' } }])
  await store.append(lane, 0, [
    {
      type: 'IntegrationRefused',
      actor: 'conductor',
      data: { ticketId: wi, branch: 'agent/7', reason: 'conflict', detail: 'does not merge' },
    },
  ])
  await store.append(
    wi,
    0,
    toAppend(aWait(makeStream(wi), { _tag: 'AgentQuestion', run: { runId }, step: 'design', question: 'which base?' })),
  )
  // A run refused before it started: no `RunStarted`, so nothing names a card.
  await store.append(startless, 0, [
    { type: 'RunAwaitingInput', actor: `agent:${startless}`, data: { prompt: 'anybody there?' } },
  ])
}, 120_000)

describe('createSubjectResolver', () => {
  const card = { id: wi, project: PROJECT, issue: '7' }

  it('reads the work item off its own stream', async () => {
    expect(await subject(await head(wi))).toEqual(card)
  })

  /** `int-{project}-{base}` cannot be split back — a base may hold a `-` — so the payload answers. */
  it('reads it off `ticketId` for an integration lane', async () => {
    expect(await subject(await head(lane))).toEqual(card)
  })

  /**
   * The two the refused attempt dropped. Both are on a run stream and carry a
   * `runId` and nothing else, so the answer is `RunStarted`, which is the run
   * stream's own first word.
   */
  it("reads it off the run's RunStarted for an approval", async () => {
    const events = await store.read(runId)
    const approval = events.find((e) => e.type === 'StepEnded')
    expect(approval).toBeDefined()
    expect(await subject(approval!)).toEqual(card)
  })

  it("reads it off the run's RunStarted for a question", async () => {
    expect(await subject(await head(runId))).toEqual(card)
  })

  /**
   * Null is *not from here*, and it is what a notification must not be sent
   * about: a card named by guesswork is worse than none.
   */
  it('answers null for a run that never started', async () => {
    expect(await subject(await head(startless))).toBeNull()
  })

  /**
   * The refusal that ended attempt 5. A null here resolves the delivery as a
   * success, so a failed read answered null dropped the notification with no
   * `PluginFailed` — it has to reject, so `deliver` rejects and it is recorded.
   */
  it("rejects, rather than answering null, when the run's stream cannot be read", async () => {
    const approval = (await store.read(runId)).find((e) => e.type === 'StepEnded')!
    const broken: EventStore = {
      ...store,
      read: async () => {
        throw new Error('the pool is gone')
      },
    }
    await expect(createSubjectResolver(broken)(approval)).rejects.toThrow('the pool is gone')
  })

  it('answers null for a stream that belongs to the installation', async () => {
    const control = await head(wi)
    expect(await subject({ ...control, streamId: 'ctl-conductor' })).toBeNull()
    expect(await subject({ ...control, streamId: 'chat-abc' })).toBeNull()
  })
})
