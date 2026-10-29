/** `lingtai doctor` while it runs (#716): the step in flight, the time each took, and when the line is drawn. */
import type { Runtime } from '@lingtai/agent'
import type { StoreChoice } from '@lingtai/env'
import type { LogQueries } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import type { Projection } from '@lingtai/projector'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type DoctorProgress, type DoctorReach, type DoctorReport, runDoctor, tally } from '../src/doctor.ts'
import { doctorProgress, type Spinner } from '../src/steps.ts'

const wroteSqlite = (): StoreChoice => ({
  store: 'sqlite',
  path: '<unused>',
  where: 'config.yml',
  from: '<home>/config.yml',
})

const signedInRuntime = {
  capabilities: { id: 'claude-code' },
  checkAuth: async () => ({ loggedIn: true, detail: 'signed in' }),
} as unknown as Runtime

const reach: DoctorReach = {
  status: async () => null,
  pause: async () => null,
  lags: async () => [],
  shapes: async (p: Projection) => ({ projection: p.name, matched: [], absent: [], drift: [] }),
  lockHolder: async () => null,
  orphans: async () => [],
  titles: async () => [],
  settings: async () => null,
  runtimes: () => [signedInRuntime],
  sea: () => ({ can: true }),
  recipe: () => {
    throw new Error('no project is registered')
  },
  agentEnv: () => {
    throw new Error('no project is registered')
  },
}

const queries: LogQueries = {
  projectStreams: async () => [],
  endedWithoutEndActions: async () => [],
  typeCounts: () => createMemoryEventStore().typeCounts(),
  rowsOfType: async () => [],
  unconvergedUpdates: async () => [],
  subscriberFailures: async () => [],
}

describe('runDoctor reports its steps (#716)', () => {
  it('starts and ends every step in turn, grows `done` by the rows it pushed, and stamps every row', async () => {
    const seen: DoctorProgress[] = []
    const report = await runDoctor(
      {},
      () => undefined,
      wroteSqlite,
      queries,
      async () => [],
      {
        ...reach,
        onProgress: (p) => seen.push(p),
      },
    )

    expect(seen.length).toBeGreaterThan(0)
    for (let i = 0; i < seen.length; i += 2) {
      const [start, end] = [seen[i]!, seen[i + 1]!]
      expect(start.phase).toBe('start')
      expect(end).toMatchObject({ label: start.label, phase: 'end' })
      expect(end.done).toBeGreaterThanOrEqual(start.done)
      if (i > 0) expect(start.done).toBe(seen[i - 1]!.done)
    }
    expect(seen.at(-1)!.done).toBe(report.results.length)
    expect(report.results.every((r) => typeof r.ms === 'number')).toBe(true)
  })
})

describe('doctorProgress', () => {
  const saved = { NO_COLOR: process.env['NO_COLOR'], FORCE_COLOR: process.env['FORCE_COLOR'] }
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  function drive(how: { stdout: boolean; stderr: boolean; json?: boolean }): string[] {
    const calls: string[] = []
    const spinner: Spinner = {
      start: (m) => calls.push(`start ${m}`),
      message: (m) => calls.push(`message ${m}`),
      clear: () => calls.push('clear'),
    }
    const p = doctorProgress({
      stdout: { isTTY: how.stdout },
      stderr: { isTTY: how.stderr },
      json: how.json ?? false,
      spinner: () => spinner,
    })
    p.onProgress({ label: 'GitHub', phase: 'start', done: 23 })
    p.onProgress({ label: 'GitHub', phase: 'end', done: 24 })
    p.clear()
    return calls
  }

  it('draws on a terminal, in colour, and clears', () => {
    delete process.env['NO_COLOR']
    process.env['FORCE_COLOR'] = '1'
    expect(drive({ stdout: true, stderr: true })).toEqual([
      'start checking GitHub · 23 done',
      'message checking GitHub · 24 done',
      'clear',
    ])
  })

  it('draws nothing when stderr is not a terminal, even under FORCE_COLOR', () => {
    process.env['FORCE_COLOR'] = '1'
    expect(drive({ stdout: true, stderr: false })).toEqual([])
  })

  it('draws nothing when stdout is piped', () => {
    process.env['FORCE_COLOR'] = '1'
    expect(drive({ stdout: false, stderr: true })).toEqual([])
  })

  it('draws nothing under --json or NO_COLOR', () => {
    process.env['FORCE_COLOR'] = '1'
    expect(drive({ stdout: true, stderr: true, json: true })).toEqual([])
    delete process.env['FORCE_COLOR']
    process.env['NO_COLOR'] = '1'
    expect(drive({ stdout: true, stderr: true })).toEqual([])
  })
})

describe('lingtai doctor through runCli (#716)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock('../src/doctor.ts')
    vi.doUnmock('../src/install.ts')
    vi.doUnmock('../src/steps.ts')
  })

  async function run(
    argv: string[],
    read: (o?: { onProgress?: (p: DoctorProgress) => void }) => Promise<DoctorReport>,
    clear = vi.fn(),
  ) {
    vi.resetModules()
    vi.doMock('../src/doctor.ts', async (orig) => ({
      ...(await orig<typeof import('../src/doctor.ts')>()),
      doctorReport: read,
    }))
    vi.doMock('../src/install.ts', async (orig) => ({
      ...(await orig<typeof import('../src/install.ts')>()),
      releaseCheck: async () => ({ name: 'release: newest', status: 'ok' as const, detail: 'current' }),
    }))
    vi.doMock('../src/steps.ts', async (orig) => ({
      ...(await orig<typeof import('../src/steps.ts')>()),
      doctorProgress: () => ({ onProgress: () => {}, clear }),
    }))
    const { runCli } = await import('../src/cli.ts')
    let out = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((t: unknown) => ((out += String(t)), true))
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void (out += `${a.join(' ')}\n`))
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void (out += `${a.join(' ')}\n`))
    const code = await runCli(['node', 'lingtai', ...argv])
    return { code, out }
  }

  const timed = async (): Promise<DoctorReport> => {
    const rs: DoctorReport['results'] = [
      { name: 'node: at or above the floor', status: 'ok', detail: 'v22', ms: 1234 },
      { name: 'packages load under Node', status: 'ok', detail: 'loaded', ms: 3 },
    ]
    return { results: rs, ...tally(rs) }
  }

  it('--verbose shows each row’s time, and --json carries ms', async () => {
    process.env['NO_COLOR'] = '1'
    const text = await run(['doctor', '--verbose'], timed)
    expect(text.out).toContain('node: at or above the floor 1.2s')
    expect(text.out).toContain('packages load under Node <0.1s')
    const json = await run(['doctor', '--json'], timed)
    const checks = JSON.parse(json.out).checks as { name: string; ms?: number }[]
    expect(checks.map((c) => c.ms)).toEqual([1234, 3, expect.any(Number)])
    delete process.env['NO_COLOR']
  })

  it('clears the line when a check throws, and exits 1', async () => {
    const clear = vi.fn()
    const { code } = await run(
      ['doctor'],
      async () => {
        throw new Error('no store')
      },
      clear,
    )
    expect(clear).toHaveBeenCalledTimes(1)
    expect(code).toBe(1)
  })
})
