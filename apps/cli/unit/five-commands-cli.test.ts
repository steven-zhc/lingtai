/** `run`, `attach`, `ticket`, `end` and `backlog` through `@effect/cli` (#624): what reaches each runner, and what a refusal says. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runCli, type Runners } from '../src/cli.ts'

async function capture(
  args: string[],
  runners: Partial<Runners> = {},
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((t: string | Uint8Array) => ((out += String(t)), true))
  vi.spyOn(process.stderr, 'write').mockImplementation((t: string | Uint8Array) => ((err += String(t)), true))
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void (out += `${a.join(' ')}\n`))
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void (err += `${a.join(' ')}\n`))
  const code = await runCli(['node', 'lingtai', ...args], runners)
  return { code, out, err }
}

const saved = process.env['NO_COLOR']
beforeEach(() => {
  process.env['NO_COLOR'] = '1'
})
afterEach(() => {
  vi.restoreAllMocks()
  if (saved === undefined) delete process.env['NO_COLOR']
  else process.env['NO_COLOR'] = saved
})

/** A runner that records what it was handed and exits 0. */
function recording<T>(): { seen: T[]; run: (request: T) => Promise<number> } {
  const seen: T[] = []
  return { seen, run: async (request) => (seen.push(request), 0) }
}

describe('lingtai run', () => {
  it('hands the runner the project, the bounds and the merge flag, after a heading', async () => {
    const r = recording<Parameters<Runners['run']>[0]>()
    const a = await capture(['run', 'lingtai', '--issue', '624', '--no-merge'], { run: r.run })
    await capture(['run', '--project', 'lingtai', '--max', '3'], { run: r.run })
    await capture(['run', 'lingtai', '--once'], { run: r.run })
    await capture(['run', 'lingtai', '--once', '--issue', '5'], { run: r.run })
    expect(a.code).toBe(0)
    expect(a.out).toBe('run lingtai\n')
    expect(r.seen).toEqual([
      { project: 'lingtai', issue: 624, merge: false },
      { project: 'lingtai', max: 3, merge: true },
      { project: 'lingtai', max: 1, merge: true },
      { project: 'lingtai', issue: 5, merge: true },
    ])
  })

  it('refuses a missing project and a non-positive --max with the sentences it always had, exit 2', async () => {
    const r = recording<unknown>()
    const none = await capture(['run'], { run: r.run })
    expect(none.code).toBe(2)
    expect(none.err).toContain('lingtai run <project> [--issue <n>] [--max <n>] [--no-merge]')
    const zero = await capture(['run', 'lingtai', '--max', '0'], { run: r.run })
    expect(zero.code).toBe(2)
    expect(zero.err).toContain('--max takes a positive number')
    expect(r.seen).toEqual([])
  })

  it('passes the runner’s exit code through', async () => {
    expect((await capture(['run', 'p'], { run: async () => 1 })).code).toBe(1)
  })
})

describe('lingtai attach', () => {
  it('hands the runner the run id, and refuses none', async () => {
    const r = recording<{ runId: string }>()
    expect((await capture(['attach', '2d6f1c'], { attach: r.run })).code).toBe(0)
    expect(r.seen).toEqual([{ runId: '2d6f1c' }])
    const none = await capture(['attach'], { attach: r.run })
    expect(none.code).toBe(2)
    expect(none.err).toContain('lingtai attach <runId>')
  })
})

describe('lingtai end', () => {
  it('replays, narrowed or not, and spells out its one subcommand', async () => {
    const r = recording<{ project?: string; issue?: number }>()
    await capture(['end', 'replay'], { end: r.run })
    await capture(['end', 'replay', 'lingtai', '--issue', '9'], { end: r.run })
    expect(r.seen).toEqual([{}, { project: 'lingtai', issue: 9 }])
    const bare = await capture(['end'], { end: r.run })
    expect(bare.code).toBe(2)
    expect(bare.err).toContain('lingtai end replay [<project>] [--issue <n>]')
  })
})

describe('lingtai ticket', () => {
  it('reads each verb', async () => {
    const r = recording<Parameters<Runners['ticket']>[0]>()
    await capture(['ticket', 'list', '--all', '--project', 'p', '--json'], { ticket: r.run })
    await capture(['ticket', 'close', '3', '--project', 'p'], { ticket: r.run })
    await capture(['ticket', 'new'], { ticket: r.run })
    await capture(['ticket', 'edit', '4'], { ticket: r.run })
    expect(r.seen).toEqual([
      { verb: 'list', all: true, json: true, project: 'p' },
      { verb: 'close', issue: 3, project: 'p' },
      { verb: 'new' },
      { verb: 'edit', issue: 4 },
    ])
  })

  it('answers a runner that threw with the error document under --json, and prose otherwise', async () => {
    const boom = async (): Promise<number> => {
      throw new Error('database is down')
    }
    const json = await capture(['ticket', 'list', '--json'], { ticket: boom })
    expect(json.code).toBe(1)
    expect(JSON.parse(json.out)).toMatchObject({ command: 'ticket list', error: { message: 'database is down' } })
    const text = await capture(['ticket', 'list'], { ticket: boom })
    expect(text.code).toBe(1)
    expect(text.err).toContain('database is down')
  })

  it('prints the four usage lines and exits 2 with no verb, and refuses a number that is not one', async () => {
    const r = recording<unknown>()
    const bare = await capture(['ticket'], { ticket: r.run })
    expect(bare.code).toBe(2)
    expect(bare.err.trim().split('\n')).toHaveLength(4)
    const bad = await capture(['ticket', 'close', 'three'], { ticket: r.run })
    expect(bad.code).toBe(2)
    expect(bad.err).toContain('lingtai ticket close <n> [--project <p>]')
    const missing = await capture(['ticket', 'edit'], { ticket: r.run })
    expect(missing.code).toBe(2)
    expect(r.seen).toEqual([])
  })
})

describe('lingtai backlog', () => {
  it('is the listing when no verb is named, and takes a project and --all in either order', async () => {
    const r = recording<Parameters<Runners['backlog']>[0]>()
    await capture(['backlog'], { backlog: r.run })
    await capture(['backlog', 'lingtai', '--all'], { backlog: r.run })
    await capture(['backlog', '--all', '--json'], { backlog: r.run })
    expect(r.seen).toEqual([
      { verb: 'list', all: false, json: false },
      { verb: 'list', project: 'lingtai', all: true, json: false },
      { verb: 'list', all: true, json: true },
    ])
  })

  it('reads an unquoted reason as one reason, not as a list of keys', async () => {
    const r = recording<Parameters<Runners['backlog']>[0]>()
    await capture(['backlog', 'decline', 'lingtai', '0123456789ab', '--reason', 'style', 'only'], { backlog: r.run })
    expect(r.seen).toEqual([{ verb: 'decline', positional: ['lingtai', '0123456789ab'], reason: 'style only' }])
  })

  it('leaves a --reason with nothing after it to the verb to refuse', async () => {
    const r = recording<Parameters<Runners['backlog']>[0]>()
    await capture(['backlog', 'decline', 'lingtai', 'aaaaaaaaaaaa', '--reason'], { backlog: r.run })
    expect(r.seen).toEqual([{ verb: 'decline', positional: ['lingtai', 'aaaaaaaaaaaa'] }])
  })

  it('hands accept its keys, --kind and --unheld, and a second key through to be refused by name', async () => {
    const r = recording<Parameters<Runners['backlog']>[0]>()
    await capture(['backlog', 'accept', 'lingtai', 'aaaaaaaaaaaa', '--kind', 'bug', '--unheld'], { backlog: r.run })
    await capture(['backlog', 'accept', 'lingtai', 'a', 'b'], { backlog: r.run })
    expect(r.seen).toEqual([
      { verb: 'accept', positional: ['lingtai', 'aaaaaaaaaaaa'], kind: 'bug', unheld: true },
      { verb: 'accept', positional: ['lingtai', 'a', 'b'], unheld: false },
    ])
  })

  it('prints usage and exits 0 for `help`', async () => {
    const r = await capture(['backlog', 'help'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('lingtai backlog accept <project> <key> --kind <kind>')
  })
})
