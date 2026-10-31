/**
 * **A pass is one OTLP trace** (#791) — run, steps and actions as spans, against
 * the same fakes `conduct-a-whole-pass.test.ts` uses and an in-memory exporter.
 *
 * Unit by 0060 §1: nothing here opens a socket. The exporter is injected into
 * `installTracing`, so the provider, the batch processor, the context manager and
 * the Effect tracer are the production ones.
 */
import { machineFileFrom } from '@lingtai/env'
import { context, trace } from '@opentelemetry/api'
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { installTracing, type Tracing } from '../src/telemetry.ts'
import {
  REVIEWED,
  fakeGitHub,
  fakePorts,
  memoryStore,
  once,
  project,
  refusingRuntime,
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

  const pass = async (recipe: string, withRuntime = runtime) => {
    exporter.reset()
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
        store: memoryStore(),
      },
      fakePorts([], memoryStore()),
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
    expect(steps.map((s) => s.name)).toContain('step end')
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

  it('a failing action exports ERROR with no message and no events', async () => {
    const { spans } = await pass(REVIEWED, refusingRuntime)
    const failed = spans.filter((s) => s.name === 'action agent' && s.status.code === 2)
    expect(failed.length).toBeGreaterThan(0)
    for (const s of spans) {
      expect(s.events).toEqual([])
      expect(s.status.message).toBeUndefined()
    }
  })

  it('a passing pass has no ERROR on its run', async () => {
    const { spans } = await pass(REVIEWED, runtime)
    expect(spans.find((s) => s.name === 'conductor.run')!.status.code).not.toBe(2)
  })
})
