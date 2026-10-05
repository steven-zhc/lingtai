import { NO_RUN_LOG, type Runtime, type RunOutcome, type RunRequest } from '@lingtai/agent'
import { callFor, Discuss, DISCUSS_DEFAULTS } from '@lingtai/recipe'
/**
 * `discussionAsk`: what a round's `call` — the recipe's `discuss.limits` and
 * `discuss.model`, resolved — becomes on the `RunRequest` a real `Runtime`
 * receives (`#243`).
 *
 * Asserted against a stand-in `Runtime` rather than against the schema alone,
 * which is the Done-when's own distinction: a `Discuss` that parses `turns: 7`
 * proves nothing about whether that `7` ever reaches a call.
 */
import { describe, expect, it } from 'vitest'

import { discussionAsk } from '../src/discuss.ts'

function stubRuntime(): { runtime: Runtime; requests: RunRequest[] } {
  const requests: RunRequest[] = []
  const runtime: Runtime = {
    capabilities: {
      id: 'claude-code',
      hooks: [],
      canFailClosed: true,
      canRewriteToolCall: false,
      tier: 'guarded',
    } as unknown as Runtime['capabilities'],
    run: async (request: RunRequest): Promise<RunOutcome> => {
      requests.push(request)
      return {
        exitCode: 0,
        turns: 1,
        durationMs: 1,
        costUsd: null,
        failure: null,
        text: null,
        sessionId: '',
      }
    },
  }
  return { runtime, requests }
}

describe('discussionAsk', () => {
  it("carries the recipe's turns and wall onto the runtime's limits", async () => {
    const { runtime, requests } = stubRuntime()
    const ask = discussionAsk(runtime, {
      runId: async (round) => `chat-1:0:${round}`,
      cwd: '/tmp/chat-1',
      settingsPath: '/tmp/chat-1.settings.json',
      log: NO_RUN_LOG,
    })

    await ask('the brief', 0, { turns: 7, wallMs: 90_000 })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.limits).toEqual({ turns: 7, wallMs: 90_000 })
    expect(requests[0]?.model).toBeUndefined()
    expect(requests[0]?.runId).toBe('chat-1:0:0')
    expect(requests[0]?.prompt).toBe('the brief')
  })

  it("carries the recipe's model only when one was named", async () => {
    const { runtime, requests } = stubRuntime()
    const ask = discussionAsk(runtime, {
      runId: async (round) => `chat-1:0:${round}`,
      cwd: '/tmp/chat-1',
      settingsPath: '/tmp/chat-1.settings.json',
      log: NO_RUN_LOG,
    })

    await ask('the brief', 1, { model: 'haiku', turns: 40, wallMs: 300_000 })

    expect(requests[0]?.model).toBe('haiku')
    expect(requests[0]?.runId).toBe('chat-1:0:1')
  })
})

describe('callFor', () => {
  it("resolves a recipe's discuss.limits and discuss.model into the call", () => {
    expect(callFor(Discuss.parse({ model: 'haiku', limits: { turns: 7, wall: '90s' } }))).toEqual({
      model: 'haiku',
      turns: 7,
      wallMs: 90_000,
    })
  })

  it('resolves the recipe defaults the same way', () => {
    expect(callFor(DISCUSS_DEFAULTS)).toEqual({ turns: 40, wallMs: 300_000 })
  })
})
