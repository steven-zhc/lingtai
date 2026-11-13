/**
 * **Status flows up through bridged Effect spans** (#1053, #791): a child that
 * says it failed (`FAILED`) turns its bridged parent `ERROR`; a child that merely
 * ends with a typed failure marks only itself.
 */
import { FAILED } from '@lingtai/actions/spans'
import { machineFileFrom } from '@lingtai/env'
import { context, trace } from '@opentelemetry/api'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { Effect } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { installTracingEffect, type Tracing } from '../src/telemetry.ts'

const on = { LINGTAI_TELEMETRY_OTLP_ENDPOINT: 'http://collector:4318/v1/traces' } as unknown as NodeJS.ProcessEnv

describe('a bridged span and its bridged parent', () => {
  const exporter = new InMemorySpanExporter()
  let tracing: Tracing

  beforeAll(async () => {
    tracing = (await Effect.runPromise(installTracingEffect(on, machineFileFrom('/h/config.yml', null), exporter)))!
  })
  afterAll(() => {
    trace.disable()
    context.disable()
  })

  const statusOf = async (child: Effect.Effect<unknown, unknown>) => {
    exporter.reset()
    await Effect.runPromise(
      Effect.exit(child.pipe(Effect.withSpan('child'))).pipe(Effect.withSpan('parent'), Effect.provide(tracing.layer)),
    )
    await tracing.flush()
    const spans = exporter.getFinishedSpans()
    const code = (name: string) => spans.find((s) => s.name === name)?.status.code
    return { child: code('child'), parent: code('parent') }
  }

  it('is ERROR on the parent when the child was annotated FAILED', async () => {
    const seen = await statusOf(Effect.annotateCurrentSpan(FAILED, true))
    expect(seen).toEqual({ child: 2, parent: 2 })
  })

  it('is untouched on the parent when the child ends with a typed failure', async () => {
    const seen = await statusOf(Effect.fail('nope'))
    expect(seen).toEqual({ child: 2, parent: 0 })
  })
})
