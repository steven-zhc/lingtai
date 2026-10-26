/** The daemon commands through `@effect/cli` (#622): what is refused before a handler runs, and what a verdict looks like. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/cli.ts'
import { parseRestartArgs } from '../src/restart.ts'

const seen = vi.hoisted(() => ({
  calls: [] as { command: string; options: unknown }[],
  unconfirmed: false,
  board: false,
  code: 0,
}))

vi.mock('../src/daemon.ts', () => ({
  restartCommand: async (args: unknown) => {
    seen.calls.push({ command: 'restart', options: args })
    return 0
  },
  controlCommand: async (verb: string, input: unknown) => {
    seen.calls.push({ command: verb, options: input })
    return verb === 'pause' && !(input as { reason: string }).reason.trim() ? 2 : 0
  },
  daemonCommand: async (flags: unknown) => {
    seen.calls.push({ command: 'daemon', options: flags })
    return 0
  },
  serviceOptions: () => ({ marker: 'options' }),
}))
vi.mock('../src/service.ts', () => ({
  SHUTDOWN_BOARD_ONLY: 3,
  START_BOARD_ONLY: 4,
  serviceCommand: async (argv: string[], options: unknown) => {
    seen.calls.push({ command: `service ${argv.join('|')}`, options })
    const note = (options as { unconfirmed: (job: string) => void }).unconfirmed
    if (argv[0] === 'start' && seen.unconfirmed) note('conductor')
    if (argv[0] === 'start' && seen.board) note('board')
    return seen.code
  },
}))

async function capture(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((t: string | Uint8Array) => ((out += String(t)), true))
  vi.spyOn(process.stderr, 'write').mockImplementation((t: string | Uint8Array) => ((err += String(t)), true))
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void (out += `${a.join(' ')}\n`))
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void (err += `${a.join(' ')}\n`))
  const code = await runCli(['node', 'lingtai', ...args])
  return { code, out, err }
}

const saved = process.env['NO_COLOR']
beforeEach(() => {
  seen.calls.length = 0
  seen.unconfirmed = false
  seen.board = false
  seen.code = 0
  process.env['NO_COLOR'] = '1'
})
afterEach(() => {
  vi.restoreAllMocks()
  if (saved === undefined) delete process.env['NO_COLOR']
  else process.env['NO_COLOR'] = saved
})

describe('lingtai restart', () => {
  it('keeps a boolean from consuming the reason', async () => {
    const r = await capture(['restart', '--dirty', 'picking', 'up', '#88'])
    expect(r.code).toBe(0)
    expect(seen.calls[0]!.options).toMatchObject({ reason: 'picking up #88', dirty: true })
  })

  it.each([
    [['--dirty', 'picking up #88']],
    [['--timeout', '10m', '--no-conduct', 'deploying']],
    [['--force', '--despite-doctor']],
    [['--no-color', 'why']],
  ])('reads %j the way parseRestartArgs does', async (argv) => {
    await capture(['restart', ...argv])
    const expected = parseRestartArgs(argv.filter((a) => a !== '--no-color'))
    expect(expected.ok).toBe(true)
    expect(seen.calls[0]!.options).toEqual(expected.ok ? expected.args : null)
  })

  it('refuses --anyway by name, with code 2, before anything runs', async () => {
    const r = await capture(['restart', '--anyway'])
    expect(r.code).toBe(2)
    expect(r.err).toContain('--anyway is gone')
    expect(seen.calls).toEqual([])
  })

  it('refuses a --timeout it cannot read and a flag it does not have', async () => {
    expect((await capture(['restart', '--timeout', '0s'])).err).toContain('--timeout takes a positive duration')
    expect((await capture(['restart', '--timeout', 'soon'])).err).toContain(
      '--timeout takes a duration like 30m or 90s',
    )
    const r = await capture(['restart', '--bogus'])
    expect(r.code).toBe(2)
    expect(r.err).toContain('lingtai restart has no --bogus')
    expect(seen.calls).toEqual([])
  })
})

describe('lingtai service', () => {
  it('says service stop is gone, in the two lines it always said, and exits 2', async () => {
    const r = await capture(['service', 'stop'])
    expect(r.code).toBe(2)
    expect(r.err).toContain("lingtai service stop is gone — it was the supervisor's signal")
    expect(r.err).toContain('pnpm lingtai service shutdown "why" drains through the log')
  })

  it('hands shutdown its reason as one argument', async () => {
    const r = await capture(['service', 'shutdown', 'moving', 'the', 'database'])
    expect(r.code).toBe(0)
    expect(seen.calls[0]!.command).toBe('service shutdown|moving the database')
    expect(r.out).toContain('✓ shut down')
  })

  it('prints one closing line for a verb', async () => {
    const r = await capture(['service', 'install'])
    expect(r.out).toContain('✓ installed')
  })

  it('does not call an unconfirmed start started', async () => {
    seen.unconfirmed = true
    const r = await capture(['service', 'start'])
    expect(r.code).toBe(0)
    expect(r.out).not.toContain('✓ started')
  })

  it('does not claim the conductor started when the start was unconfirmed and the board failed', async () => {
    seen.unconfirmed = true
    seen.code = 4
    const r = await capture(['service', 'start'])
    expect(r.code).toBe(4)
    expect(r.out).not.toContain('the conductor did')
    expect(r.out).toContain('it was not confirmed, and the board did not start')
  })

  it('does not deny a confirmed conductor start because the board had a process already', async () => {
    seen.board = true
    const r = await capture(['service', 'start'])
    expect(r.out).toContain('✓ started')
    expect(r.out).not.toContain('nothing was started or confirmed')
  })

  it('says the board was started when only the conductor was unconfirmed', async () => {
    seen.unconfirmed = true
    const r = await capture(['service', 'start'])
    expect(r.out).toContain('the board was started')
    expect(r.out).not.toContain('nothing was started or confirmed')
  })

  it('says nothing was started when both jobs already had a process', async () => {
    seen.unconfirmed = true
    seen.board = true
    const r = await capture(['service', 'start'])
    expect(r.out).toContain('nothing was started or confirmed')
  })

  it('hands the steps to serviceCommand', async () => {
    await capture(['service', 'restart', 'why'])
    expect(seen.calls[0]!.options).toMatchObject({ steps: expect.any(Object) })
  })

  it('status takes --json and the handler is told to print the document', async () => {
    await capture(['service', 'status', '--json'])
    expect(seen.calls[0]).toMatchObject({ command: 'service status', options: { json: true } })
  })

  it('status without --json prints the report', async () => {
    await capture(['service', 'status'])
    expect(seen.calls[0]).toMatchObject({ options: { json: false } })
  })
})

describe('lingtai pause, shutdown, resume, start', () => {
  it('joins an unquoted reason, and --reason wins', async () => {
    await capture(['pause', 'reviewing', 'the', 'recipe'])
    await capture(['pause', 'ignored', '--reason', 'the real one'])
    expect(seen.calls.map((c) => c.options)).toEqual([{ reason: 'reviewing the recipe' }, { reason: 'the real one' }])
  })

  it('refuses a pause with no reason with exit 2', async () => {
    expect((await capture(['pause'])).code).toBe(2)
  })

  it('passes shutdown its timeout as text and --force as a flag', async () => {
    await capture(['shutdown', 'deploying', '--timeout', '10m'])
    await capture(['shutdown', '--force'])
    expect(seen.calls.map((c) => c.options)).toEqual([
      { reason: 'deploying', timeout: '10m', force: false },
      { reason: '', force: true },
    ])
  })

  it('resume takes nothing', async () => {
    expect((await capture(['resume'])).code).toBe(0)
    expect(seen.calls[0]!.command).toBe('resume')
  })

  it('start and daemon pass their flags on', async () => {
    await capture(['start', '--no-conduct'])
    await capture(['daemon', '--no-merge'])
    expect(seen.calls.map((c) => c.options)).toEqual([{ 'no-conduct': '' }, { 'no-merge': '' }])
  })
})

describe('service status --json when the handler throws', () => {
  it('prints the error document on stdout', async () => {
    const service = await import('../src/service.ts')
    vi.spyOn(service, 'serviceCommand').mockRejectedValueOnce(new Error('no passwd entry'))
    const r = await capture(['service', 'status', '--json'])
    expect(r.code).toBe(1)
    expect(JSON.parse(r.out.trim())).toMatchObject({ command: 'service status', error: { message: 'no passwd entry' } })
  })
})
