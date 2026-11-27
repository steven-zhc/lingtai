import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { MachineText } from '../src/claude-token.ts'
import {
  type Asker,
  type MachinePorts,
  type SetupInput,
  machineQuestions,
  runSetupList,
  writeDayCeiling,
} from '../src/machine-list.ts'

const PATH = '/h/config.yml'

function world(initial: string | null, over: Partial<MachinePorts> = {}) {
  const state = { text: initial, writes: 0 }
  const machine: MachineText = {
    read: () => state.text,
    write: (_p, t) => {
      state.text = t
      state.writes += 1
    },
  }
  const ports: MachinePorts = {
    path: PATH,
    machine,
    store: () => ({ store: null }),
    githubAuth: () => ({ kind: null, environment: false, written: false }),
    dayCeiling: () => ({ value: null, environment: false }),
    tokenState: () => ({ environment: false, file: false, usable: false }),
    database: () => Effect.succeed({ ok: true }),
    ghStatus: () => Effect.succeed({ ok: false, reason: 'missing' } as never),
    app: () => Effect.succeed({ configured: false }),
    recipes: () => Effect.succeed([]),
    obtainToken: () => Effect.succeed(null),
    env: {},
    say: () => {},
    ...over,
  }
  return { state, ports }
}

const input = (over: Partial<SetupInput> = {}): SetupInput => ({
  interactive: true,
  defaults: false,
  flags: {},
  askers: {},
  log: () => {},
  ...over,
})

const ceilingOnly = (ports: MachinePorts) =>
  machineQuestions(ports, { githubRequired: false }).filter((q) => q.id === 'ceiling')
const run = (list: ReturnType<typeof ceilingOnly>, i: SetupInput) => Effect.runPromise(runSetupList(list, i))

describe('runSetupList', () => {
  it('takes the system default for a key never written, and writes it', async () => {
    const { state, ports } = world('')
    const seen: (string | null)[] = []
    const ask: Asker = (d) => {
      seen.push(d.default)
      return Effect.succeed({ answer: d.default! })
    }
    const out = await run(ceilingOnly(ports), input({ askers: { ceiling: ask } }))
    expect(seen).toEqual(['100'])
    expect(out.entries[0]).toMatchObject({ wrote: true, after: '100' })
    expect(state.text).toContain('day_usd: 100')
  })

  it('writes nothing for an answer equal to the value in force, and offers it as the default', async () => {
    const { state, ports } = world('limits:\n  day_usd: 40\n', {
      dayCeiling: () => ({ value: 40, environment: false }),
    })
    const seen: (string | null)[] = []
    const out = await run(
      ceilingOnly(ports),
      input({
        askers: {
          ceiling: (d) => {
            seen.push(d.default)
            return Effect.succeed({ answer: d.default! })
          },
        },
      }),
    )
    expect(seen).toEqual(['40'])
    expect(out.entries[0]!.wrote).toBe(false)
    expect(state.writes).toBe(0)
  })

  it('does not ask or write a value the environment supplies, and refuses a flag that differs', async () => {
    const { state, ports } = world('', { dayCeiling: () => ({ value: 7, environment: true }) })
    const never: Asker = () => Effect.die('asked')
    const out = await run(ceilingOnly(ports), input({ askers: { ceiling: never } }))
    expect(out.entries[0]).toMatchObject({ asked: false, wrote: false, after: null })
    expect(state.writes).toBe(0)
    const refused = await run(ceilingOnly(ports), input({ flags: { 'day-usd': '9' } }))
    expect(refused.refused).toContain('environment')
    const same = await run(ceilingOnly(ports), input({ flags: { 'day-usd': '7' } }))
    expect(same.refused).toBeUndefined()
    expect(state.writes).toBe(0)
  })

  it('takes the default without a terminal, and with --defaults, never calling the asker', async () => {
    for (const mode of [{ interactive: false }, { defaults: true }]) {
      const { state, ports } = world('')
      const out = await run(ceilingOnly(ports), input({ ...mode, askers: { ceiling: () => Effect.die('asked') } }))
      expect(out.entries[0]).toMatchObject({ wrote: true, after: '100' })
      expect(state.text).toContain('day_usd: 100')
    }
  })

  it('refuses 0 by name and writes nothing; none removes the key and an emptied limits', async () => {
    const { state, ports } = world('limits:\n  day_usd: 40\n', {
      dayCeiling: () => ({ value: 40, environment: false }),
    })
    const zero = await run(ceilingOnly(ports), input({ flags: { 'day-usd': '0' } }))
    expect(zero.refused).toContain('0')
    expect(state.writes).toBe(0)
    await run(ceilingOnly(ports), input({ flags: { 'day-usd': 'none' } }))
    expect(state.text).not.toContain('limits')
    expect(() => writeDayCeiling(ports.machine, PATH, 0)).toThrow()
  })

  it('defers a question that is not needed, and asks it once when the draft needs it', async () => {
    const { ports } = world('')
    const list = machineQuestions(ports, { githubRequired: false }).filter((q) => q.id === 'claude-token')
    const first = await run(list, input({ interactive: false }))
    expect(first.entries).toEqual([])
    expect(first.deferred).toHaveLength(1)
    const draft = { sandbox: { enabled: true }, steps: {}, runtime: { agent: 'claude-code' } } as never
    const need = await Effect.runPromise(list[0]!.needed!({ draft }).pipe(Effect.catch(() => Effect.succeed(false))))
    expect(typeof need).toBe('boolean')
  })

  it('refuses none for a GitHub project, by name, and takes gh where the login is ready', async () => {
    const { ports } = world('')
    const list = machineQuestions(ports, { githubRequired: true }).filter((q) => q.id === 'github')
    const out = await run(list, input({ interactive: false }))
    expect(out.refused).toContain('none')
    const ready = world('', {
      ghStatus: () => Effect.succeed({ ok: true, login: 'a', scopes: ['repo', 'workflow'] } as never),
    })
    const ok = await run(
      machineQuestions(ready.ports, { githubRequired: false }).filter((q) => q.id === 'github'),
      input({ interactive: false }),
    )
    expect(ok.refused).toBeUndefined()
  })

  it('does not write app where no App exists', async () => {
    const { state, ports } = world('github:\n  auth: gh\n', {
      githubAuth: () => ({ kind: 'gh', environment: false, written: true }),
    })
    const list = machineQuestions(ports, { githubRequired: false }).filter((q) => q.id === 'github')
    const out = await run(list, input({ flags: { 'github-auth': 'app' } }))
    expect(out.entries[0]).toMatchObject({ pending: true, wrote: false })
    expect(state.writes).toBe(0)
  })
})
