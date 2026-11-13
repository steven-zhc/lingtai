/**
 * A subscriber's failure reaches `work-loop.ts` as an `Error` whose `message`
 * is the command's evidence (#1042). The command is injected, so no process
 * starts here.
 */
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { CommandOutcome } from '../src/command.ts'
import { makeSubscriber, SubscriberFailed, subjectOf } from '../src/subscriber.ts'

const event = {
  seq: 1n,
  streamId: 's',
  version: 1,
  type: 'StepEnded',
  schemaVer: 1,
  data: {},
  actor: 'test',
  causation: null,
  at: new Date(0),
}

const outcome = (ok: boolean, evidence: string): CommandOutcome => ({
  ok,
  evidence,
  timedOut: false,
  durationMs: 1,
  exitCode: ok ? 0 : 1,
})

const subscriber = (result: CommandOutcome) => {
  const port = makeSubscriber({
    project: 'p',
    spec: { name: 'notify', run: 'true', on: ['StepEnded'] } as never,
    subject: () => Effect.succeed(subjectOf('p', '1')),
    cwd: '/',
    env: Effect.succeed({}),
    board: 'http://board',
    command: () => Effect.succeed(result),
  })
  return { deliver: (e: typeof event) => Effect.runPromise(port.deliver(e)) }
}

describe('makeSubscriber over an injected command', () => {
  it('rejects with the SubscriberFailed itself, its message the evidence', async () => {
    const error = await subscriber(outcome(false, 'boom'))
      .deliver(event)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ _tag: 'SubscriberFailed', message: 'boom' })
    expect(error).toBeInstanceOf(SubscriberFailed)
  })

  it('resolves for a command that exited 0', async () => {
    await expect(subscriber(outcome(true, 'fine')).deliver(event)).resolves.toBeUndefined()
  })

  it('resolves without a command for an event it is not owed', async () => {
    await expect(subscriber(outcome(false, 'boom')).deliver({ ...event, type: 'Other' })).resolves.toBeUndefined()
  })
})
