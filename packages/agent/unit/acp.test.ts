/**
 * The ACP runtime, against a scripted agent that speaks newline-delimited JSON-RPC
 * over in-memory streams — no real `copilot`, no process, no socket (0060 §1).
 * `spawn`, the hook socket and the group signal are the three things injected.
 */
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { COPILOT_PROFILE } from '../src/acp-session.ts'
import { acpFailure, acpRun, COPILOT_CAPABILITIES, createToolLedger, type AcpOptions } from '../src/acp.ts'
import { classifyAcpSession } from '../src/auth.ts'
import { missingToFailClosed, type RunRequest } from '../src/runtime.ts'

type Json = Record<string, any>

/** One scripted agent: what it was sent, and a way to say things to the client. */
interface Agent {
  received: Json[]
  notify(method: string, params: unknown): void
  /** Asks the client something and resolves with its answer. */
  ask(method: string, params: unknown): Promise<Json>
  respond(id: unknown, result: unknown): void
  fail(id: unknown, code: number, message: string): void
}

type Handler = (message: Json, agent: Agent) => boolean | void

function fakeAgent(handler: Handler) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    pid: number
  }
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 4242
  const waiting = new Map<number, (answer: Json) => void>()
  let nextId = 1000
  const write = (message: unknown) =>
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...(message as object) })}\n`)
  const agent: Agent = {
    received: [],
    notify: (method, params) => write({ method, params }),
    ask: (method, params) =>
      new Promise((resolve) => {
        const id = nextId++
        waiting.set(id, resolve)
        write({ id, method, params })
      }),
    respond: (id, result) => write({ id, result }),
    fail: (id, code, message) => write({ id, error: { code, message } }),
  }
  let buffer = ''
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (line.trim() === '') continue
      const message = JSON.parse(line) as Json
      if (message['method'] === undefined && waiting.has(message['id'])) {
        waiting.get(message['id'])!(message)
        continue
      }
      agent.received.push(message)
      if (handler(message, agent) === true) continue
      if (message['method'] === 'initialize')
        agent.respond(message['id'], { protocolVersion: 1, agentCapabilities: {} })
      else if (message['method'] === 'session/new') agent.respond(message['id'], { sessionId: 's1' })
      else if (message['method'] === 'session/set_model') agent.respond(message['id'], {})
    }
  })
  return { child, agent }
}

interface Harness {
  options: AcpOptions
  hook: { events: string[]; payloads: Json[] }
  signals: string[]
  agent: Agent
  child: ReturnType<typeof fakeAgent>['child']
  request(overrides?: Partial<RunRequest>): RunRequest
}

function harness(handler: Handler, hookFails = false): Harness {
  const { child, agent } = fakeAgent(handler)
  const hook = { events: [] as string[], payloads: [] as Json[] }
  const signals: string[] = []
  const options: AcpOptions = {
    binary: 'copilot',
    spawn: (() => child as unknown as ChildProcess) as AcpOptions['spawn'] & object,
    hook: (_socket, _runId, payload) => {
      hook.payloads.push(payload as Json)
      hook.events.push(`hook:${(payload as Json)['hook_event_name']}`)
      return hookFails ? Promise.reject(new Error('ENOENT')) : Promise.resolve({ allow: true })
    },
    signalGroup: (_child, signal) => {
      signals.push(signal)
    },
    cancelWaitMs: 20,
    killWaitMs: 20,
  }
  const log: string[] = []
  return {
    options,
    hook,
    signals,
    agent,
    child,
    request: (overrides = {}) =>
      ({
        runId: 'r1',
        cwd: '/work/tree',
        prompt: 'do the thing',
        settingsPath: '/x/settings.json',
        env: { LINGTAI_HOOK_SOCKET: '/tmp/hook.sock', LINGTAI_HOOK_RUN_ID: 'r1' },
        limits: { wallMs: 5_000 },
        log: { note: (label: string, detail?: string) => void log.push(`${label}: ${detail ?? ''}`) },
        ...overrides,
      }) as RunRequest,
  }
}

const run = (h: Harness, request: RunRequest = h.request()) => Effect.runPromise(acpRun(h.options, request))

/** The whole of a good turn: a permission, an edit, a read, some words. */
const goodTurn: Handler = (message, agent) => {
  if (message['method'] !== 'session/prompt') return
  const sessionId = message['params']['sessionId']
  const update = (u: unknown) => agent.notify('session/update', { sessionId, update: u })
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hel' } })
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'Edit a.ts',
    kind: 'edit',
    status: 'pending',
    locations: [{ path: '/work/tree/a.ts' }],
  })
  void agent
    .ask('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 't1', title: 'Edit a.ts' },
      options: [
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      ],
    })
    .then((answer) => {
      agent.received.push({ answered: answer['result'] })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' })
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 't2',
        title: 'Read b.ts',
        kind: 'read',
        status: 'completed',
        rawInput: { path: '/work/tree/b.ts' },
      })
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } })
      agent.respond(message['id'], { stopReason: 'end_turn' })
    })
  return true
}

describe('a run that succeeds', () => {
  it('answers a permission request allow-once, records the edit, and sends UserPromptSubmit before the prompt', async () => {
    const h = harness((message, agent) => {
      if (message['method'] === 'session/prompt') h.hook.events.push('session/prompt')
      return goodTurn(message, agent)
    })
    const outcome = await run(h)

    expect(outcome.failure).toBeNull()
    expect(outcome.text).toBe('hello')
    expect(outcome.turns).toBe(2)
    expect(outcome.costUsd).toBeNull()
    expect(outcome.sessionId).toBe('s1')

    // *Allow once*, never the reject that was listed first.
    expect(h.agent.received.find((m) => m['answered'])?.['answered']).toEqual({
      outcome: { outcome: 'selected', optionId: 'yes' },
    })

    // UserPromptSubmit precedes session/prompt; the edit is recorded the way Claude Code's `Edit` is.
    expect(h.hook.events.indexOf('hook:UserPromptSubmit')).toBeLessThan(h.hook.events.indexOf('session/prompt'))
    const edit = h.hook.payloads.find((p) => p['tool_name'] === 'Edit')
    expect(edit).toMatchObject({
      hook_event_name: 'PostToolUse',
      tool_input: { file_path: '/work/tree/a.ts' },
    })
    // A read is traced under a name the server's mutation map does not match.
    expect(h.hook.payloads.find((p) => p['tool_name'] === 'acp:read')).toBeDefined()
    expect(h.signals).toEqual(['SIGKILL'])
  })

  it('notes each permission in the run log', async () => {
    const notes: string[] = []
    const h = harness(goodTurn)
    const request = h.request({ log: { note: (l: string, d?: string) => void notes.push(`${l}: ${d}`) } })
    await run(h, request)
    expect(notes).toContain('permission: asked Edit a.ts: allowed')
  })

  it('sends the model as session/set_model, and nothing when none is set', async () => {
    const withModel = harness(goodTurn)
    expect((await run(withModel, withModel.request({ model: 'gpt-x' }))).failure).toBeNull()
    expect(withModel.agent.received.find((m) => m['method'] === 'session/set_model')?.['params']).toEqual({
      sessionId: 's1',
      modelId: 'gpt-x',
    })
    const without = harness(goodTurn)
    await run(without)
    expect(without.agent.received.some((m) => m['method'] === 'session/set_model')).toBe(false)
  })
})

describe('the outcomes', () => {
  it('-32000 from session/new is never-started, naming copilot login', async () => {
    const h = harness((message, agent) => {
      if (message['method'] !== 'session/new') return
      agent.fail(message['id'], -32000, 'Authentication required')
      return true
    })
    const outcome = await run(h)
    expect(outcome.failure?.kind).toBe('never-started')
    expect(outcome.failure?.detail).toContain('copilot login')
    expect(h.hook.events).toEqual([])
  })

  it('an end_turn whose reply is the failed-turn sentence is a crash with that text', async () => {
    const h = harness((message, agent) => {
      if (message['method'] !== 'session/prompt') return
      agent.notify('session/update', {
        sessionId: 's1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Error: Execution failed: Model "gpt-5" is not available.' },
        },
      })
      agent.respond(message['id'], { stopReason: 'end_turn' })
      return true
    })
    const outcome = await run(h)
    expect(outcome.failure).toEqual({
      kind: 'crash',
      detail: 'Error: Execution failed: Model "gpt-5" is not available.',
    })
  })

  it('past the wall: cancel, then SIGTERM, then SIGKILL to the group, and a timeout', async () => {
    const h = harness((message) => {
      if (message['method'] === 'session/prompt') return true // never answered
      return undefined
    })
    const outcome = await run(h, h.request({ limits: { wallMs: 30 } }))
    expect(outcome.failure?.kind).toBe('timeout')
    expect(h.agent.received.some((m) => m['method'] === 'session/cancel')).toBe(true)
    expect(h.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('a cancelled turn that answers in time is a timeout too, and the group is still ended', async () => {
    const h = harness((message, agent) => {
      if (message['method'] === 'session/prompt') {
        h.child.on('cancel', () => agent.respond(message['id'], { stopReason: 'cancelled' }))
        return true
      }
      if (message['method'] === 'session/cancel') h.child.emit('cancel')
      return undefined
    })
    const outcome = await run(h, h.request({ limits: { wallMs: 30 } }))
    expect(outcome.failure?.kind).toBe('timeout')
    expect(h.signals.at(-1)).toBe('SIGKILL')
  })

  it('a process that exits before the turn ends is a crash carrying its stderr', async () => {
    const h = harness((message) => {
      if (message['method'] !== 'session/prompt') return
      h.child.stderr.write('boom: out of file descriptors\n')
      setTimeout(() => h.child.emit('exit', 1, null), 5)
      return true
    })
    const outcome = await run(h)
    expect(outcome.failure?.kind).toBe('crash')
    expect(outcome.failure?.detail).toContain('boom: out of file descriptors')
  })

  it('a missing hook wiring is a crash and spawns nothing', async () => {
    const h = harness(goodTurn)
    const outcome = await run(h, h.request({ env: {} }))
    expect(outcome.failure?.kind).toBe('crash')
    expect(h.agent.received).toEqual([])
  })
})

describe('an unreachable hook socket', () => {
  it('means session/prompt is never sent, and the run is a crash naming the socket', async () => {
    const h = harness(goodTurn, true)
    const outcome = await run(h)
    expect(outcome.failure?.kind).toBe('crash')
    expect(outcome.failure?.detail).toContain('/tmp/hook.sock')
    expect(h.agent.received.some((m) => m['method'] === 'session/prompt')).toBe(false)
    expect(h.signals).toContain('SIGKILL')
  })
})

describe('the tool ledger', () => {
  it('records an edit once, when it completes, from the location or the raw input', () => {
    const ledger = createToolLedger()
    expect(
      ledger.apply({
        toolCallId: 'a',
        kind: 'edit',
        title: 'Edit',
        status: 'pending',
        rawInput: { file_path: '/x/a' },
      }),
    ).toBeNull()
    const done = ledger.apply({ toolCallId: 'a', status: 'completed' })
    expect(done).toMatchObject({ tool_name: 'Edit', tool_input: { file_path: '/x/a' } })
    expect(ledger.apply({ toolCallId: 'a', status: 'completed' })).toBeNull()
  })

  it('never records a failed edit, or one with no path, as a touched file', () => {
    const ledger = createToolLedger()
    expect(
      ledger.apply({ toolCallId: 'f', kind: 'edit', status: 'failed', locations: [{ path: '/x/f' }] })?.['tool_name'],
    ).toBe('acp:edit')
    expect(ledger.apply({ toolCallId: 'n', kind: 'edit', title: 'Edit', status: 'completed' })?.['tool_name']).toBe(
      'acp:edit',
    )
  })

  it('reports a call that never finished', () => {
    const ledger = createToolLedger()
    ledger.apply({ toolCallId: 'u', kind: 'execute', title: 'npm test', status: 'in_progress' })
    expect(ledger.unfinished()).toEqual(['npm test'])
  })
})

describe('acpFailure', () => {
  it('reads the profile’s failed-turn sentence, and a missing stopReason', () => {
    expect(acpFailure(COPILOT_PROFILE, { stopReason: 'end_turn', text: 'done.' })).toBeNull()
    expect(acpFailure(COPILOT_PROFILE, { stopReason: 'end_turn', text: 'Error: Execution failed: nope' })?.kind).toBe(
      'crash',
    )
    expect(acpFailure(COPILOT_PROFILE, { stopReason: undefined, text: 'done.' })?.kind).toBe('crash')
    expect(acpFailure(COPILOT_PROFILE, { stopReason: 'refusal', text: '' })?.kind).toBe('crash')
  })
})

describe('what copilot declares', () => {
  it('can fail closed, takes no schema, and enforces the wall alone', () => {
    expect(COPILOT_CAPABILITIES).toMatchObject({
      id: 'copilot',
      hooks: [],
      acceptsOutputSchema: false,
      canFailClosed: true,
      canRewriteToolCall: false,
      enforces: ['wall'],
    })
    expect(missingToFailClosed(COPILOT_CAPABILITIES)).toEqual([])
  })

  it('answers sign-in from whether a session opened', () => {
    expect(classifyAcpSession(COPILOT_PROFILE, { kind: 'opened' }).state).toBe('signed-in')
    const out = classifyAcpSession(COPILOT_PROFILE, { kind: 'auth-required' })
    expect(out.state).toBe('signed-out')
    expect(out.detail).toContain('copilot login')
  })
})
