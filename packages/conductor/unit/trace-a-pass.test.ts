/**
 * **A pass is one OTLP trace** (#791) — run, steps and actions as spans, against
 * the same fakes `conduct-a-whole-pass.test.ts` uses and an in-memory exporter.
 *
 * Unit by 0060 §1: nothing here opens a socket. The exporter is injected into
 * `installTracing`, so the provider, the batch processor, the context manager and
 * the Effect tracer are the production ones.
 */
import type { Envelope, ToAppend } from '@lingtai/domain'
import { machineFileFrom } from '@lingtai/env'
import { context, trace } from '@opentelemetry/api'
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { installTracing, type Tracing } from '../src/telemetry.ts'
import { tellGitHubAbout } from '../src/tell.ts'
import {
  HUMAN_BEFORE_THE_LANE,
  REVIEWED,
  fakeGitHub,
  fakePorts,
  memoryStore,
  once,
  project,
  refusingRuntime,
  reviewerThatCrashes,
  runtime,
} from '../test/one-pass.ts'

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

  const pass = async (recipe: string, withRuntime = runtime, refuseAppend = false) => {
    exporter.reset()
    const inner = memoryStore()
    const store: typeof inner = refuseAppend
      ? {
          ...inner,
          append: (streamId: string, expected: number, events: readonly ToAppend[]) =>
            events.some(
              (e) => e.type === 'StepEnded' && (e.data as { outcome: { step: string } }).outcome.step === 'proposed',
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
      expect(typeof s.attributes['lingtai.round']).toBe('number')
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
  })
})
