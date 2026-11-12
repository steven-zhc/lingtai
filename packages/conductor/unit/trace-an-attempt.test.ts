/**
 * **A pass is one OTLP trace** (#791) — run, steps and actions as spans, against
 * the same fakes `conduct-a-whole-attempt.test.ts` uses and an in-memory exporter.
 *
 * Unit by 0060 §1: nothing here opens a socket. The exporter is injected into
 * `installTracing`, so the provider, the batch processor, the context manager and
 * the Effect tracer are the production ones.
 */
import type { RunOutcome } from '@lingtai/agent'
import type { Envelope, ToAppend } from '@lingtai/domain'
import { machineFileFrom } from '@lingtai/env'
import { context, trace } from '@opentelemetry/api'
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { Effect } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { installTracing, type Tracing } from '../src/telemetry.ts'
import { tellGitHubAbout } from '../src/tell.ts'
import {
  HUMAN_BEFORE_THE_LANE,
  JUDGED_BY_AN_AGENT,
  REVIEWED,
  fakeGitHub,
  fakePorts,
  memoryStore,
  once,
  project,
  refusingRuntime,
  reviewerThatCrashes,
  runtime,
} from '../test/one-attempt.ts'

const none = machineFileFrom('/h/config.yml', null)
const on = { LINGTAI_TELEMETRY_OTLP_ENDPOINT: 'http://collector:4318/v1/traces' } as unknown as NodeJS.ProcessEnv

describe('without an endpoint', () => {
  it('installs nothing, and a span is not recording', async () => {
    expect(await installTracing({} as NodeJS.ProcessEnv, none)).toBeUndefined()
    expect(trace.getTracer('lingtai-conductor').startSpan('x').isRecording()).toBe(false)
  })

  it('does not import the SDK, the exporter or the context manager', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('../src/telemetry.ts', import.meta.url), 'utf8')
    const staticImports = source.split('\n').filter((line) => /^import (?!type)/.test(line))
    expect(staticImports.join('\n')).not.toMatch(/sdk-trace-base|exporter-trace|context-async-hooks|resources/)
  })
})

describe('with an endpoint', () => {
  const exporter = new InMemorySpanExporter()
  let tracing: Tracing

  beforeAll(async () => {
    tracing = (await installTracing(on, none, exporter))!
  })
  afterAll(() => {
    trace.disable()
    context.disable()
  })

  const pass = async (recipe: string, withRuntime = runtime, refuseAppend: boolean | string = false) => {
    exporter.reset()
    const inner = memoryStore()
    const store: typeof inner = refuseAppend
      ? {
          ...inner,
          append: (streamId: string, expected: number, events: readonly ToAppend[]) =>
            events.some(
              (e) =>
                e.type === 'StepEnded' &&
                (e.data as { outcome: { step: string } }).outcome.step ===
                  (refuseAppend === true ? 'proposed' : refuseAppend),
            )
              ? Promise.reject(new Error('terminating connection /secret/path'))
              : (inner.append(streamId, expected, events) as Promise<Envelope[]>),
        }
      : inner
    const result = await once(
      {
        project,
        client: fakeGitHub([], recipe),
        runtime: withRuntime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
      },
      fakePorts([], store),
      tracing.layer,
    )
    await tracing.flush()
    return { result, spans: exporter.getFinishedSpans() }
  }

  const parentOf = (s: ReadableSpan) => s.parentSpanContext?.spanId
  const idOf = (s: ReadableSpan) => s.spanContext().spanId

  it('is one connected trace: a root run, steps under it, actions under their step', async () => {
    const { spans } = await pass(REVIEWED, refusingRuntime)
    const runs = spans.filter((s) => s.name === 'conductor.run')
    expect(runs).toHaveLength(1)
    const [run] = runs
    expect(parentOf(run!)).toBeUndefined()
    expect(run!.attributes).toEqual({ 'lingtai.ticket': 7 })
    expect(run!.resource.attributes['service.name']).toBe('lingtai-conductor')

    const steps = spans.filter((s) => s.name.startsWith('step '))
    expect(steps.map((s) => s.name)).toContain('step claim')
    expect(steps.length).toBeGreaterThan(2)
    for (const s of steps) {
      expect(parentOf(s), s.name).toBe(idOf(run!))
      if (!['step claim', 'step end'].includes(s.name))
        expect(typeof s.attributes['lingtai.round'], s.name).toBe('number')
    }

    const actions = spans.filter((s) => s.name.startsWith('action '))
    expect(actions.length).toBeGreaterThan(0)
    for (const a of actions) {
      const step = steps.find((s) => idOf(s) === parentOf(a))
      expect(step, a.name).toBeDefined()
      expect(typeof a.attributes['lingtai.index']).toBe('number')
    }
    // One trace: no span is a stray root.
    for (const s of spans) expect(s.spanContext().traceId).toBe(run!.spanContext().traceId)
  })

  it('exports no attribute outside the three, and nothing path- or URL-shaped, nor a recipe name', async () => {
    const secret = 'rm -rf secret-command-text'
    const { spans } = await pass(REVIEWED.replace('name: review', `name: "${secret}"`), refusingRuntime)
    expect(spans.length).toBeGreaterThan(3)
    for (const s of spans) {
      expect(
        Object.keys(s.attributes).filter((k) => !['lingtai.ticket', 'lingtai.round', 'lingtai.index'].includes(k)),
      ).toEqual([])
      for (const value of [s.name, ...Object.values(s.attributes).map(String)]) {
        expect(value).not.toMatch(/:\/\/|\//)
        expect(value).not.toContain('secret-command-text')
      }
    }
  })

  it('a refused pass exports its run as ERROR, with no message', async () => {
    const { result, spans } = await pass(REVIEWED, runtime, true)
    expect(result).toMatchObject({ ok: false, stage: 'unexpected' })
    const run = spans.find((s) => s.name === 'conductor.run')!
    expect(run.status.code).toBe(2)
    expect(run.status.message).toBeUndefined()
    expect(run.events).toEqual([])
    expect(run.attributes).toEqual({ 'lingtai.ticket': 7 })
  })

  it('the end step is spanned where its actions run, one action span each, by kind', async () => {
    exporter.reset()
    const store = memoryStore()
    const calls: string[] = []
    const github = {
      getIssue: async () => ({ labels: [] }),
      matchingRefs: async () => [],
      comment: async () => ({}),
      editComment: async () => undefined,
      setLabels: async () => {
        calls.push('labels')
      },
      closeIssue: async () => {
        calls.push('close')
      },
      updateBody: async () => undefined,
      deleteRef: async () => undefined,
      listRefs: async () => [],
    } as unknown as Parameters<typeof tellGitHubAbout>[0]['github']
    await tellGitHubAbout({
      store,
      github,
      ticketId: 'ticket-p-7',
      appended: [
        {
          type: 'EndActionsResolved',
          data: { actions: [{ labels: ['x'] }, { close: true }] },
        } as unknown as ToAppend,
      ],
    })
    await tracing.flush()
    expect(calls).toEqual(['labels', 'close'])
    const spans = exporter.getFinishedSpans()
    const end = spans.find((s) => s.name === 'step end')!
    expect(end).toBeDefined()
    const actions = spans.filter((s) => s.name.startsWith('action '))
    expect(actions.map((s) => s.name)).toEqual(['action labels', 'action close'])
    for (const a of actions) expect(parentOf(a)).toBe(idOf(end))
  })

  it('an end action GitHub refused exports ERROR on its action and on the end step', async () => {
    exporter.reset()
    const refuse = async () => {
      throw new Error('nope /secret')
    }
    const github = {
      getIssue: async () => ({ labels: [] }),
      matchingRefs: refuse,
      setLabels: refuse,
      closeIssue: refuse,
    } as unknown as Parameters<typeof tellGitHubAbout>[0]['github']
    await tellGitHubAbout({
      store: memoryStore(),
      github,
      ticketId: 'ticket-p-7',
      appended: [
        {
          type: 'EndActionsResolved',
          data: { actions: [{ labels: ['x'] }, { close: true }, { refs: true, branch: true }] },
        } as unknown as ToAppend,
      ],
    })
    await tracing.flush()
    const spans = exporter.getFinishedSpans()
    const actions = spans.filter((s) => s.name.startsWith('action '))
    expect(actions).toHaveLength(3)
    for (const s of [...actions, spans.find((x) => x.name === 'step end')!]) {
      expect(s.status.code, s.name).toBe(2)
      expect(s.status.message).toBeUndefined()
    }
  })

  it('a runtime version probe is a span of the step that asked, or of the judge action (#1064)', async () => {
    const versioned = {
      ...refusingRuntime,
      version: () => Effect.succeed('fake 1').pipe(Effect.withSpan('agent.version')),
    } as typeof refusingRuntime
    const { spans } = await pass(JUDGED_BY_AN_AGENT, versioned)
    const run = spans.find((s) => s.name === 'conductor.run')!
    const probes = spans.filter((s) => s.name === 'agent.version')
    expect(probes.length).toBeGreaterThan(1)
    for (const probe of probes) expect(probe.spanContext().traceId).toBe(run.spanContext().traceId)
    const parents = probes.map((probe) => spans.find((s) => idOf(s) === parentOf(probe))?.name)
    expect(parents).toContain('action judge')
    for (const name of parents) expect(name === 'action judge' || name?.startsWith('step '), String(name)).toBe(true)
  })

  it('agent.run is a span of the step that dispatched it, or of the judge action (#1065)', async () => {
    const spanned = {
      ...refusingRuntime,
      run: (request) => refusingRuntime.run(request).pipe(Effect.withSpan('agent.run')),
    } as typeof refusingRuntime
    const { spans } = await pass(JUDGED_BY_AN_AGENT, spanned)
    const run = spans.find((s) => s.name === 'conductor.run')!
    const runs = spans.filter((s) => s.name === 'agent.run')
    expect(runs.length).toBeGreaterThan(0)
    for (const one of runs) expect(one.spanContext().traceId).toBe(run.spanContext().traceId)
    const parents = runs.map((one) => spans.find((s) => idOf(s) === parentOf(one))?.name)
    expect(parents).toContain('action judge')
    for (const name of parents) expect(name === 'action judge' || name?.startsWith('step '), String(name)).toBe(true)
  })

  it('a failing action exports ERROR with no message and no events', async () => {
    const { spans } = await pass(REVIEWED, refusingRuntime)
    const failed = spans.filter((s) => s.name === 'action agent' && s.status.code === 2)
    expect(failed.length).toBeGreaterThan(0)
    for (const s of spans) {
      expect(s.events).toEqual([])
      expect(s.status.message).toBeUndefined()
    }
  })

  it('a pass held for the signoff it was asked for exports its run as unset, not ERROR', async () => {
    const { result, spans } = await pass(HUMAN_BEFORE_THE_LANE, runtime)
    expect(result.ok).toBe('held')
    const run = spans.find((s) => s.name === 'conductor.run')!
    expect(run.status.code).not.toBe(2)
    expect(run.status.message).toBeUndefined()
    // Asked is not an error anywhere: no span is ERROR.
    expect(spans.filter((s) => s.status.code === 2).map((s) => s.name)).toEqual([])
  })

  it('a run held on an unreadable reviewer answer exports ERROR too', async () => {
    const { result, spans } = await pass(REVIEWED, runtime)
    expect(result.ok).toBe('held')
    expect(spans.find((s) => s.name === 'conductor.run')!.status.code).toBe(2)
  })

  it('a run held because the reviewer crashed exports ERROR, with no message', async () => {
    const { result, spans } = await pass(REVIEWED, reviewerThatCrashes({ n: 0 }))
    expect(result.ok).toBe('held')
    const run = spans.find((s) => s.name === 'conductor.run')!
    expect(run.status.code).toBe(2)
    expect(run.status.message).toBeUndefined()
    expect(run.attributes).toEqual({ 'lingtai.ticket': 7 })
    // Status comes up from the action: the step above it is ERROR for no other reason.
    const agent = spans.filter((s) => s.name === 'action agent' && s.status.code === 2)
    for (const a of agent) {
      const step = spans.find((s) => s.spanContext().spanId === parentOf(a))!
      expect(step.name).toMatch(/^step /)
      expect(step.status.code).toBe(2)
    }
    expect(agent.length).toBeGreaterThan(0)
    for (const s of agent) {
      expect(s.status.message).toBeUndefined()
      expect(s.events).toEqual([])
    }
  })

  it('a rejected StepEnded append leaves its step span ERROR, with no message', async () => {
    const { result, spans } = await pass(REVIEWED, runtime, 'implement')
    expect(result).toMatchObject({ ok: false, stage: 'unexpected' })
    const step = spans.find((s) => s.name === 'step implement')!
    expect(step.status.code).toBe(2)
    expect(step.status.message).toBeUndefined()
    expect(step.events).toEqual([])
  })
  describe('a design question handed to a needs-input judge', () => {
    const JUDGED_QUESTION = `
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps:
  design:
    - name: draft
      agent: claude-code
      prompt: say what shape this takes
  proposed:
    - name: the answer
      judge: claude-code
      when: needs-input
runtime:
  agent: claude-code
  limits: { turns: 10, wall: 2m, rounds: 2, restarts: 0 }
`
    const asking = (judged: RunOutcome): typeof runtime => ({
      ...runtime,
      run: (request) =>
        request.runId.includes(':design:')
          ? Effect.succeed({
              exitCode: 0,
              turns: 2,
              durationMs: 1234,
              costUsd: 0.21,
              failure: null,
              text: '```question\nWhich wins?\n```',
              sessionId: 'sess-design',
            })
          : Effect.succeed(judged),
    })

    it('a judge that crashed exports the run as ERROR, with no message and no events', async () => {
      const { result, spans } = await pass(
        JUDGED_QUESTION,
        asking({
          exitCode: 1,
          turns: 0,
          durationMs: 1_000,
          costUsd: null,
          failure: { kind: 'crash', detail: 'Error: boom /secret/path' },
          text: null,
          sessionId: 'sess-judge',
        }),
      )
      expect(result.ok).toBe('held')
      const run = spans.find((s) => s.name === 'conductor.run')!
      expect(run.status.code).toBe(2)
      expect(run.status.message).toBeUndefined()
      expect(run.events).toEqual([])
      // The dispatch is spanned, under the router's visit, and the failure comes up from it.
      const judge = spans.find((s) => s.name === 'action judge')!
      expect(judge.status.code).toBe(2)
      expect(judge.status.message).toBeUndefined()
      const proposed = spans.find((s) => s.name === 'step proposed')!
      expect(proposed.status.code).toBe(2)
      expect(judge.parentSpanContext?.spanId).toBe(proposed.spanContext().spanId)
      expect(proposed.parentSpanContext?.spanId).toBe(run.spanContext().spanId)
    })

    it('a question no judge was asked exports no ERROR on any span', async () => {
      const { result, spans } = await pass(
        JUDGED_QUESTION.replace(/  proposed:[\s\S]*?(?=runtime:)/, ''),
        asking({
          exitCode: 0,
          turns: 1,
          durationMs: 1,
          costUsd: 0,
          failure: null,
          text: 'x',
          sessionId: 's',
        }),
      )
      expect(result.ok).toBe('held')
      expect(spans.find((s) => s.name === 'action agent')).toBeDefined()
      expect(spans.filter((s) => s.status.code === 2).map((s) => s.name)).toEqual([])
    })

    it('a judge whose answer could not be read exports the run as ERROR too', async () => {
      const { result, spans } = await pass(
        JUDGED_QUESTION,
        asking({
          exitCode: 0,
          turns: 1,
          durationMs: 1_000,
          costUsd: 0.1,
          failure: null,
          text: 'no answer in the shape asked for',
          sessionId: 'sess-judge',
        }),
      )
      expect(result.ok).toBe('held')
      expect(spans.find((s) => s.name === 'conductor.run')!.status.code).toBe(2)
    })
  })
})
