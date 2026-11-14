import { installFor } from '@lingtai/sandbox'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { areaOf, sandboxRows } from '../src/doctor.ts'
import type { CanaryResult } from '../src/sandbox-canary.ts'
import { fakeSandbox } from '../test/sandbox-fakes.ts'

type Block = { enabled: boolean; required: boolean; network: { allow: string[] }; write: string[]; deny: string[] }
const block = (b: Partial<Block> = {}): Block => ({
  enabled: true,
  required: false,
  network: { allow: [] },
  write: [],
  deny: [],
  ...b,
})

/** Projects by name, each with the recipe's sandbox block, or `null` for a recipe that does not resolve. */
const rowsFor = (projects: Record<string, Block | undefined | null>, sandbox: ReturnType<typeof fakeSandbox>) => {
  const reads: unknown[] = []
  const load = () =>
    Effect.succeed(Object.keys(projects).map((project) => ({ project, owner: 'me', base: 'main' }))) as never
  const recipe = (state: { project: string }) => {
    reads.push(state.project)
    const b = projects[state.project]
    return b === null
      ? Effect.fail(new Error('recipe does not parse'))
      : Effect.succeed({ recipe: { sandbox: b } } as never)
  }
  return Effect.runPromise(sandboxRows({ ...sandbox, recipe: recipe as never }, load)).then((rows) => ({ rows, reads }))
}

const named = (rows: readonly { name: string }[], name: string) => {
  const row = rows.find((r) => r.name === name) as
    | { name: string; status: string; detail: string; fix?: string; title?: string }
    | undefined
  if (!row) throw new Error(`no row ${name}`)
  return row
}

describe('the sandbox rows (#1159)', () => {
  it('says the host can, and runs the canary only for a project that asks', async () => {
    const held: Effect.Effect<CanaryResult> = Effect.succeed({ kind: 'held' })
    const sandbox = fakeSandbox({ can: true, canary: held })
    const { rows } = await rowsFor({ app: block() }, sandbox)
    expect(named(rows, 'sandbox: host').status).toBe('ok')
    expect(named(rows, 'sandbox: app')).toMatchObject({ status: 'ok', detail: 'sandboxed' })
    expect(named(rows, 'sandbox: canary').status).toBe('ok')
    expect(sandbox.asked).toEqual({ host: 1, canary: 1 })
  })

  it('does not run the canary when no project asks, and says so as ok', async () => {
    const sandbox = fakeSandbox({ can: true })
    const { rows } = await rowsFor({ app: undefined, other: block({ enabled: false }) }, sandbox)
    expect(named(rows, 'sandbox: app')).toMatchObject({ status: 'ok' })
    expect(named(rows, 'sandbox: app').detail).toContain('off by choice')
    expect(named(rows, 'sandbox: canary')).toMatchObject({
      status: 'ok',
      detail: 'not run: no project asks for the sandbox',
    })
    expect(sandbox.asked.canary).toBe(0)
  })

  it("names srt's sentences and the install command when the host cannot", async () => {
    const sandbox = fakeSandbox({ can: false, sentences: ['bubblewrap (bwrap) not installed'] })
    const { rows } = await rowsFor({ app: block() }, sandbox)
    const host = named(rows, 'sandbox: host')
    expect(host.status).toBe('fail')
    expect(host.detail).toContain('host dependencies are missing')
    expect(host.detail).toContain('bubblewrap (bwrap) not installed')
    expect(host.fix).toBe(installFor(process.platform)?.command)
    // The host row already carries the failure: the canary is not run, and is not a second failure.
    expect(named(rows, 'sandbox: canary')).toMatchObject({ status: 'skip' })
    expect(sandbox.asked.canary).toBe(0)
  })

  it('gives degraded for required: false and stopped for required: true on a host that cannot', async () => {
    const { rows, reads } = await rowsFor(
      { soft: block({ required: false }), hard: block({ required: true }), off: undefined },
      fakeSandbox({ can: false, sentences: ['socat not installed'] }),
    )
    const soft = named(rows, 'sandbox: soft')
    expect(soft.status).toBe('fail')
    expect(soft.detail).toContain('degraded')
    expect(soft.detail).toContain('socat not installed')
    expect(soft.fix).toContain('sandbox.enabled: false')
    const hard = named(rows, 'sandbox: hard')
    expect(hard.status).toBe('fail')
    expect(hard.detail).toContain('stopped')
    expect(hard.fix).toContain('sandbox.required: false')
    expect(named(rows, 'sandbox: off').status).toBe('ok')
    expect(reads).toEqual(['soft', 'hard', 'off'])
  })

  it('leaves a recipe that does not resolve to the recipe row', async () => {
    const { rows } = await rowsFor({ broken: null }, fakeSandbox({ can: true }))
    expect(named(rows, 'sandbox: broken')).toMatchObject({ status: 'skip' })
  })

  it('runs the canary when the project list or a recipe cannot be read', async () => {
    const sandbox = fakeSandbox({ can: true, canary: Effect.succeed({ kind: 'held' }) })
    const rows = await Effect.runPromise(
      sandboxRows({ ...sandbox, recipe: (() => Effect.fail(new Error('transient'))) as never }, (() =>
        Effect.succeed([{ project: 'app', owner: 'me', base: 'main' }])) as never),
    )
    expect(named(rows, 'sandbox: canary').detail).not.toContain('no project asks')
    const down = fakeSandbox({ can: true })
    await Effect.runPromise(sandboxRows({ ...down }, (() => Effect.fail(new Error('db'))) as never))
    expect(down.asked.canary).toBe(1)
  })

  it('fails the canary row for a leak, a run that could not be made, and a throw', async () => {
    const run = async (canary: Effect.Effect<CanaryResult>) =>
      named((await rowsFor({ app: block() }, fakeSandbox({ can: true, canary }))).rows, 'sandbox: canary')
    const leaked = await run(Effect.succeed({ kind: 'leaked', which: ['read'] }))
    expect(leaked.status).toBe('fail')
    expect(leaked.detail).toContain('planted file was readable')
    const couldNot = await run(Effect.succeed({ kind: 'could-not-run', why: 'curl is missing' }))
    expect(couldNot).toMatchObject({ status: 'fail', title: 'the canary could not run' })
    expect(couldNot.detail).toContain('curl is missing')
    expect((await run(Effect.die(new Error('boom')))).status).toBe('fail')
  })

  it('draws every sandbox row in a section of its own', () => {
    expect(areaOf({ name: 'sandbox: host', status: 'ok', detail: '' })).toBe('Sandbox')
    expect(areaOf({ name: 'sandbox: app', status: 'ok', detail: '' })).toBe('Sandbox')
  })
})
