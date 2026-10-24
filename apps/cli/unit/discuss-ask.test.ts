import {
  NO_RUN_LOG,
  ToolsCannotBeDenied,
  createRuntime,
  type Runtime,
  type RunOutcome,
  type RunRequest,
} from '@lingtai/agent'
import { holdDiscussion } from '@lingtai/conductor/discuss'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
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
  it('answers through the tool-free Codex adapter and records its usage on RunSpent', async () => {
    const store = createMemoryEventStore()
    const requests: RequestInit[] = []
    const runtime = createRuntime('codex', {
      tools: 'none',
      codexText: {
        config: {
          apiKey: 'test-only',
          model: 'priced-model',
          maxOutputTokens: 64,
          maxUsd: 1,
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 1,
        },
        transport: async (_url, init) => {
          requests.push(init)
          return Response.json({
            id: 'response-1',
            status: 'completed',
            usage: { input_tokens: 10, output_tokens: 12 },
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: '{"answer":"Codex answered","cannot":[],"proposal":null}' }],
              },
            ],
          })
        },
      },
    })
    const held = await holdDiscussion(
      {
        store,
        serve: async () => null,
        ask: discussionAsk(runtime, {
          runId: async () => 'chat-codex:0:0',
          cwd: '/tmp/chat-codex',
          settingsPath: '/tmp/no-tools',
          log: NO_RUN_LOG,
        }),
      },
      {
        chatId: 'codex',
        question: 'Why?',
        by: 'human:test',
        runtime: 'codex',
        call: { model: 'priced-model', turns: 2, wallMs: 1000 },
        evidence: {
          ticketId: 'ticket-lingtai-1',
          attempt: null,
          ticket: { ref: '1', title: 'test', body: 'test' },
          ticketProblem: null,
          triage: null,
          log: [],
          reading: [],
          refs: [],
        },
      },
    )
    expect(held.answered).toBe(true)
    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0]!.body as string)).toMatchObject({
      model: 'priced-model',
      tools: [],
      tool_choice: 'none',
      max_output_tokens: 64,
    })
    const events = await store.read('chat-codex')
    expect(events.map((event) => event.type)).toEqual(['DiscussionAsked', 'RunSpent', 'DiscussionAnswered'])
    expect(events[1]?.data).toMatchObject({ runtime: 'codex', costUsd: null, usage: [{ model: 'priced-model' }] })
    expect(events[2]?.data).toMatchObject({ text: 'Codex answered', failure: null })
  })

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

  it('turns an unconfigured Codex runtime into an ask rejection the discussion can record', async () => {
    const ask = discussionAsk(
      () =>
        createRuntime('codex', {
          tools: 'none',
          codexText: {
            config: {
              apiKey: '',
              model: 'test-model',
              maxOutputTokens: 32,
              maxUsd: 1,
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 1,
            },
          },
        }),
      { runId: async () => 'chat-1:0:0', cwd: '/tmp/chat-1', settingsPath: '/tmp/settings', log: NO_RUN_LOG },
    )
    await expect(ask('the brief', 0, { turns: 1, wallMs: 1000 })).rejects.toThrow(ToolsCannotBeDenied)
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
