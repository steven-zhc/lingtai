/**
 * **A run an account limit cut off is the ticket's to run again** (0108 §11, #1205): the crash releases the
 * ticket `AccountLimit` behind the lock, and the first claim after the lift continues the same attempt, at the
 * cut-off step, with the cut-off run's recorded prompt under its own dispatch id.
 */
import type { Runtime } from '@lingtai/agent'
import { type PayloadOf } from '@lingtai/domain'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { liftAccountLimit } from '../src/account.ts'
import {
  PROJECT,
  JUDGED,
  fakeGitHub,
  fakePorts,
  memoryStore,
  once,
  project,
  runtime,
  streams,
} from '../test/one-attempt.ts'

const WALL = "You've hit your session limit · resets 11pm (America/Chicago)"

/** The reviewer's dispatch ids and prompts, and a wall on the first of them. */
function reviewerAtTheWallOnce(seen: { id: string; prompt: string }[]): Runtime {
  return {
    ...runtime,
    run: (request) => {
      if (!request.runId.includes(':review:')) {
        return Effect.succeed({
          exitCode: 0,
          turns: 3,
          durationMs: 1234,
          costUsd: 0.42,
          failure: null,
          text: 'done',
          sessionId: 'sess-1',
        })
      }
      seen.push({ id: request.runId, prompt: request.prompt })
      return Effect.succeed({
        exitCode: 1,
        turns: 2,
        durationMs: 1_000,
        costUsd: 0.1,
        failure: { kind: 'crash', detail: WALL },
        text: null,
        sessionId: 'sess-review',
      })
    },
  }
}

const options = (store: ReturnType<typeof memoryStore>, rt: Runtime, said: string[]) => ({
  project,
  client: fakeGitHub(said, JUDGED),
  runtime: rt,
  issue: 7,
  hookBinary: '/tmp/fake/lingtai-hook',
  prompt: 'fix {{issue}}',
  merge: false,
  home: '/tmp/fake-home',
  store,
  log: () => {},
})

describe('a run an account limit cut off', () => {
  it('is released AccountLimit behind the lock, and no wait is written', async () => {
    const store = memoryStore()
    const seen: { id: string; prompt: string }[] = []
    const result = await once(options(store, reviewerAtTheWallOnce(seen), []), fakePorts([], store))

    expect(result).toMatchObject({ ok: false })
    const ticket = await store.read(`ticket-${PROJECT}-7`)
    const released = ticket.filter((e) => e.type === 'TicketReleased').map((e) => e.data as PayloadOf<'TicketReleased'>)
    expect(released).toHaveLength(1)
    expect(released[0]!.cause).toMatchObject({ _tag: 'AccountLimit', step: 'review', runtime: 'claude-code' })
    expect(ticket.map((e) => e.type)).not.toContain('WaitStarted')
    // The lock is there before anything could claim the ticket again.
    expect((await store.read('acct-claude-code')).map((e) => e.type)).toEqual(['AccountLimitReached'])
  })

  it('is continued once the lock lifts: the same run, the recorded prompt, a :rerun:1 dispatch id', async () => {
    const store = memoryStore()
    const seen: { id: string; prompt: string }[] = []
    await once(options(store, reviewerAtTheWallOnce(seen), []), fakePorts([], store))
    const cutOff = seen[0]!

    // Locked: the ticket is not taken, and it is not a fresh claim from the base either.
    const declined = await once(options(store, reviewerAtTheWallOnce(seen), []), fakePorts([], store))
    expect(declined).toMatchObject({ ok: false })
    expect(seen).toHaveLength(1)

    await Effect.runPromise(liftAccountLimit(store, 'claude-code', 'a person'))
    await once(options(store, reviewerAtTheWallOnce(seen), []), fakePorts([], store))

    const ticket = await store.read(`ticket-${PROJECT}-7`)
    const continued = ticket.filter((e) => e.type === 'TicketContinued')
    expect(continued).toHaveLength(1)
    const [runId] = [...streams(store)].find(([id]) => id.startsWith('pass-'))!
    expect((continued[0]!.data as PayloadOf<'TicketContinued'>).runId).toBe(runId)
    expect(seen).toHaveLength(2)
    expect(seen[1]!.id).toBe(`${cutOff.id}:rerun:1`)
    expect(seen[1]!.prompt).toBe(cutOff.prompt)
  })
})
