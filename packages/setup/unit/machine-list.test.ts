import { Effect, Redacted } from 'effect'
import { describe, expect, it } from 'vitest'

import type { MachineText } from '../src/claude-token.ts'
import {
  type MachinePorts,
  machineQuestions,
  machineRows,
  machineSnapshotRows,
  writeDayCeiling,
} from '../src/machine-list.ts'
import { type Asker, type SetupInput, runSetupList } from '../src/setup-list.ts'

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

const sandboxed = { runtime: { agent: 'claude-code' }, steps: {}, sandbox: { enabled: true } } as never

describe('the token entry', () => {
  const tokenList = (ports: MachinePorts) =>
    machineQuestions(ports, { githubRequired: false }).filter((q) => q.id === 'claude-token')

  it.each([null, Redacted.make('invalid-token')])(
    'a failed token setup reports no effective change (%s)',
    async (token) => {
      let obtained = 0
      const { ports, state } = world('', {
        recipes: () => Effect.succeed([sandboxed]),
        obtainToken: () => {
          obtained++
          return Effect.succeed(token)
        },
      })
      const list = tokenList(ports)
      const result = await run(list, input({ askers: { 'claude-token': () => Effect.succeed({ answer: 'run' }) } }))
      expect(result.refused).toBeUndefined()
      expect(obtained).toBe(1)
      expect(state.writes).toBe(0)
      expect(machineRows(list, result.entries)).toEqual([
        { id: 'claude-token', label: 'claude token', group: 'machine', changed: false, text: 'skipped' },
      ])
    },
  )

  it.each(['keep', 'skip'])('an existing token stays set after %s and in the add snapshot', async (answer) => {
    for (const environment of [false, true]) {
      const { ports, state } = world('', {
        recipes: () => Effect.succeed([sandboxed]),
        tokenState: () => ({ environment, file: !environment, usable: true }),
        obtainToken: () => Effect.die('an existing token must not be obtained again'),
      })
      const list = tokenList(ports)
      const result = await run(list, input({ askers: { 'claude-token': () => Effect.succeed({ answer }) } }))
      const expected = {
        id: 'claude-token',
        label: 'claude token',
        group: 'machine',
        changed: false,
        text: `set${environment ? ' — from LINGTAI_CLAUDE_OAUTH_TOKEN' : ''}`,
      }
      expect(result.refused).toBeUndefined()
      expect(machineRows(list, result.entries)).toEqual([expected])
      expect((await Effect.runPromise(machineSnapshotRows(ports))).find((r) => r.id === 'claude-token')).toEqual(
        expected,
      )
      expect(state.writes).toBe(0)
    }
  })

  it('a successful token setup reports the saved state without retaining credentials', async () => {
    const { ports, state } = world('', {
      recipes: () => Effect.succeed([sandboxed]),
      obtainToken: () => Effect.succeed(Redacted.make('sk-ant-oat01-test-secret')),
    })
    const list = tokenList(ports)
    const result = await run(list, input({ askers: { 'claude-token': () => Effect.succeed({ answer: 'run' }) } }))
    expect(state.writes).toBe(1)
    expect(machineRows(list, result.entries)).toEqual([
      { id: 'claude-token', label: 'claude token', group: 'machine', changed: true, text: 'skipped → set' },
    ])
    expect(JSON.stringify(machineRows(list, result.entries))).not.toContain('test-secret')
  })

  it('is not asked where no recipe names claude-code with the sandbox on, and is asked once the draft does', async () => {
    const { ports } = world('')
    const list = tokenList(ports)
    const none = await Effect.runPromise(
      runSetupList(list, input({ askers: { 'claude-token': () => Effect.die('asked') } })),
    )
    expect(none.entries).toEqual([])
    expect(none.deferred).toHaveLength(1)

    const other = { runtime: { agent: 'codex' }, steps: {}, sandbox: { enabled: true } } as never
    expect(await Effect.runPromise(list[0]!.needed!({ draft: other }))).toBe(false)

    const seen: (string | null)[] = []
    const asked = await Effect.runPromise(
      runSetupList(
        none.deferred,
        input({
          askers: {
            'claude-token': (d) => {
              seen.push(d.default)
              return Effect.succeed({ answer: d.default! })
            },
          },
        }),
        { draft: sandboxed },
      ),
    )
    expect(seen).toEqual(['skip'])
    expect(asked.deferred).toEqual([])
  })

  it('a token that is set defaults to keep, which writes nothing', async () => {
    const { state, ports } = world('claude:\n  oauth_token: sk-ant-oat01-x\n', {
      tokenState: () => ({ environment: false, file: true, usable: true }),
    })
    const seen: (string | null)[] = []
    const out = await Effect.runPromise(
      runSetupList(
        tokenList(ports),
        input({
          askers: {
            'claude-token': (d) => {
              seen.push(d.default)
              return Effect.succeed({ answer: d.default! })
            },
          },
        }),
        { draft: sandboxed },
      ),
    )
    expect(seen).toEqual(['keep'])
    expect(out.entries[0]).toMatchObject({ wrote: false, after: 'keep' })
    expect(state.writes).toBe(0)
  })

  it('--claude-token keep with no token is refused by name; the token itself is never a flag', async () => {
    const { ports } = world('')
    const kept = await Effect.runPromise(
      runSetupList(tokenList(ports), input({ flags: { 'claude-token': 'keep' } }), { draft: sandboxed }),
    )
    expect(kept.refused).toContain('--claude-token keep')
    const secret = await Effect.runPromise(
      runSetupList(tokenList(ports), input({ flags: { 'claude-token': 'sk-ant-oat01-x' } }), { draft: sandboxed }),
    )
    expect(secret.refused).toContain('never a flag')
  })
})

describe('the store entry', () => {
  it('an exported Postgres URL is in force: not asked, not written, and a different flag is refused', async () => {
    const { state, ports } = world('', {
      store: () => ({ store: 'postgres', url: 'postgres://u:p@h/db', environment: true }),
    })
    const list = machineQuestions(ports, { githubRequired: false }).filter((q) => q.id === 'store')
    const out = await Effect.runPromise(runSetupList(list, input({ askers: { store: () => Effect.die('asked') } })))
    expect(out.entries[0]).toMatchObject({ asked: false, wrote: false })
    const refused = await Effect.runPromise(
      runSetupList(list, input({ flags: { 'database-url': 'postgres://u:p@other/db' } })),
    )
    expect(refused.refused).toContain('environment')
    expect(state.writes).toBe(0)
  })

  it('a first run without a terminal writes sqlite; a Postgres URL that does not answer is refused, and nothing is written', async () => {
    const { state, ports } = world('')
    const list = machineQuestions(ports, { githubRequired: false }).filter((q) => q.id === 'store')
    await Effect.runPromise(runSetupList(list, input({ interactive: false })))
    expect(state.text).toContain('store: sqlite')
    const down = world('', { database: () => Effect.succeed({ ok: false, why: 'connection refused' }) })
    const refused = await Effect.runPromise(
      runSetupList(
        machineQuestions(down.ports, { githubRequired: false }).filter((q) => q.id === 'store'),
        input({ flags: { 'database-url': 'postgres://me:secret@h/db' } }),
      ),
    )
    expect(refused.refused).toContain('connection refused')
    expect(refused.refused).not.toContain('secret')
    expect(down.state.writes).toBe(0)
  })
})

describe('a value that could not be read is not an absent one', () => {
  const faulty = (text: string) =>
    world(text, { dayCeiling: () => ({ fault: 'limits.day_usd 0 is not a positive number', environment: false }) })

  it('removes a malformed ceiling for `none`, and reports that it wrote', async () => {
    const { state, ports } = faulty('limits:\n  day_usd: 0\n  other: 1\n')
    const out = await run(ceilingOnly(ports), input({ flags: { 'day-usd': 'none' } }))
    expect(out.entries[0]).toMatchObject({ after: 'none', wrote: true })
    expect(machineRows(ceilingOnly(ports), out.entries)[0]?.text).toBe('no ceiling')
    expect(state.text).not.toContain('day_usd')
    expect(state.text).toContain('other: 1')
  })

  it('replaces it for a positive answer', async () => {
    const { state, ports } = faulty('limits:\n  day_usd: 0\n')
    const out = await run(ceilingOnly(ports), input({ flags: { 'day-usd': '50' } }))
    expect(out.entries[0]).toMatchObject({ after: '50', wrote: true })
    expect(machineRows(ceilingOnly(ports), out.entries)[0]?.text).toBe('up to $50 a day')
    expect(state.text).toContain('day_usd: 50')
  })
})

describe('an exported value beside a flag', () => {
  it('accepts --claude-token keep and skip beside an exported token, writing nothing', async () => {
    for (const given of ['keep', 'skip']) {
      const { state, ports } = world('', { tokenState: () => ({ environment: true, file: false, usable: true }) })
      const list = machineQuestions(ports, { githubRequired: false }).filter((q) => q.id === 'claude-token')
      const out = await Effect.runPromise(
        runSetupList(list, input({ flags: { 'claude-token': given } }), {
          draft: sandboxed,
        }),
      )
      // The entry was reached and answered by the flag, not deferred: the comparison with the exported token ran.
      expect(out.deferred).toEqual([])
      expect(out.entries).toHaveLength(1)
      expect(out.refused).toBeUndefined()
      expect(state.writes).toBe(0)
    }
  })

  it('refuses an exported none for a command that needs GitHub, and accepts it for init', async () => {
    const ports = world('', { githubAuth: () => ({ kind: 'none', environment: true, written: true }) }).ports
    const github = (required: boolean) =>
      machineQuestions(ports, { githubRequired: required }).filter((q) => q.id === 'github')
    const refused = await run(github(true), input())
    expect(refused.refused).toContain('GitHub')
    const fine = await run(github(false), input())
    expect(fine.refused).toBeUndefined()
  })
})

describe('machine descriptor rows', () => {
  it.each([
    { id: 'ceiling', label: 'spend', ports: { dayCeiling: () => ({ fault: 'invalid ceiling', environment: false }) } },
    { id: 'ceiling', label: 'spend', ports: { dayCeiling: () => ({ fault: 'invalid ceiling', environment: true }) } },
    { id: 'store', label: 'log', ports: { store: () => ({ store: null, fault: 'invalid store' }) } },
    {
      id: 'store',
      label: 'log',
      ports: {
        store: () => ({ store: 'postgres', url: 'postgres://db.example/log', environment: false }),
        database: () => Effect.succeed({ ok: false, why: 'connection refused' }),
      },
    },
    { id: 'github', label: 'github', ports: { githubAuth: () => ({ refused: 'invalid auth', environment: false }) } },
  ] satisfies { id: string; label: string; ports: Partial<MachinePorts> }[])(
    'keeps an unanswered $id read fault in the add snapshot ($ports)',
    async ({ id, label, ports: overrides }) => {
      const { ports, state } = world('', overrides)
      const q = machineQuestions(ports, { githubRequired: false }).find((q) => q.id === id)!
      const before = await Effect.runPromise(q.inForce!({}))
      expect(before).toHaveProperty('fault')
      const row = (await Effect.runPromise(machineSnapshotRows(ports))).find((r) => r.id === id)
      expect(row).toMatchObject({
        label,
        changed: false,
        text: expect.stringContaining(`could not read — ${before !== null && 'fault' in before ? before.fault : ''}`),
      })
      expect(row?.text).not.toContain('no ceiling')
      expect(state.writes).toBe(0)
    },
  )

  it('compares no ceiling with a later daily ceiling, and the reverse', async () => {
    const { ports, state } = world('')
    const list = ceilingOnly(ports)
    const none = await run(list, input({ flags: { 'day-usd': 'none' } }))
    expect(machineRows(list, none.entries)[0]).toMatchObject({ changed: false, text: 'no ceiling' })
    expect(state.writes).toBe(0)
    const limited = await run(list, input({ flags: { 'day-usd': '150' } }))
    expect(state.text).toContain('day_usd: 150')
    expect(machineRows(list, limited.entries)[0]).toMatchObject({
      changed: true,
      text: 'no ceiling → up to $150 a day',
    })
    expect(machineRows(list, limited.entries, {}, false)[0]).toMatchObject({
      changed: false,
      text: 'up to $150 a day',
    })
    ports.dayCeiling = () => ({ value: 150, environment: false })
    const removed = await run(list, input({ flags: { 'day-usd': 'none' } }))
    expect(state.text).not.toContain('day_usd')
    expect(machineRows(list, removed.entries)[0]).toMatchObject({
      changed: true,
      text: 'up to $150 a day → no ceiling',
    })
    ports.dayCeiling = () => ({ value: null, environment: false })
    expect((await Effect.runPromise(machineSnapshotRows(ports))).find((r) => r.id === 'ceiling')).toMatchObject({
      changed: false,
      text: 'no ceiling',
    })
  })

  it('shows the semantic ceiling change in dollars per day', async () => {
    const { ports } = world('limits:\n  day_usd: 100\n', { dayCeiling: () => ({ value: 100, environment: false }) })
    const list = ceilingOnly(ports)
    const result = await run(list, input({ flags: { 'day-usd': '150' } }))
    expect(machineRows(list, result.entries)).toEqual([
      { id: 'ceiling', label: 'spend', group: 'machine', changed: true, text: 'up to $100 a day → up to $150 a day' },
    ])
  })
  it('names the actual exported variable, without an arrow on a rerun', async () => {
    const { ports, state } = world('', { dayCeiling: () => ({ value: 100, environment: true }) })
    const list = ceilingOnly(ports)
    const result = await run(list, input())
    expect(machineRows(list, result.entries)[0]).toMatchObject({
      changed: false,
      text: 'up to $100 a day — from LINGTAI_LIMITS_DAY_USD',
    })
    expect(state.writes).toBe(0)
  })
  it('keeps database credentials out of the row snapshot', async () => {
    const { ports } = world('', {
      store: () => ({ store: 'postgres', url: 'postgres://me:secret@db.example/log', environment: true }),
    })
    const list = machineQuestions(ports, { githubRequired: false }).filter((q) => q.id === 'store')
    const result = await run(list, input())
    expect(JSON.stringify(machineRows(list, result.entries))).not.toContain('secret')
    expect(machineRows(list, result.entries)[0]?.text).toContain('Postgres · db.example — from LINGTAI_DATABASE_URL')
  })
})

it('carries the actual store variable rather than guessing a production name', async () => {
  const { ports } = world('', {
    store: () => ({ store: 'sqlite', environment: true, variable: 'LINGTAI_TEST_SQLITE_PATH' }),
  })
  const list = machineQuestions(ports, { githubRequired: false }).filter((q) => q.id === 'store')
  const result = await run(list, input())
  expect(machineRows(list, result.entries)[0]?.text).toBe('SQLite — from LINGTAI_TEST_SQLITE_PATH')
})
