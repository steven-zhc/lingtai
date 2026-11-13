import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** `env`, `projection`, `upgrade`, `rollback` and `uninstall` through `@effect/cli` and the output module (#625). */
import type { ProjectEnvListing } from '@lingtai/agent-env'
import type { ProjectionLag } from '@lingtai/projector'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type Runners } from '../src/cli.ts'
import { envListJson, formatEnvList, renderEnvList } from '../src/env.ts'
import { releaseCheck, rollback, uninstall, upgrade, type World } from '../src/install.ts'
import { projectionLagJson, renderProjectionLag } from '../src/projection.ts'
import { runCli } from '../test/cli.ts'

const ESC = String.fromCharCode(27)

async function capture(
  args: string[],
  runners: Partial<Runners> = {},
  run: typeof runCli = runCli,
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((t: string | Uint8Array) => ((out += String(t)), true))
  vi.spyOn(process.stderr, 'write').mockImplementation((t: string | Uint8Array) => ((err += String(t)), true))
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void (out += `${a.join(' ')}\n`))
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void (err += `${a.join(' ')}\n`))
  const code = await run(['node', 'lingtai', ...args], runners)
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

function recording<T>(): { seen: T[]; run: (request: T) => Effect.Effect<number> } {
  const seen: T[] = []
  return { seen, run: (request) => (seen.push(request), Effect.succeed(0)) }
}

describe('lingtai env', () => {
  it('hands each verb to the runner, and a value that looks like a flag or holds "=" arrives whole', async () => {
    const r = recording<Parameters<Runners['env']>[0]>()
    await capture(['env', 'list', 'p', '--json'], { env: r.run })
    await capture(['env', 'set', 'p', 'K=--x=y=='], { env: r.run })
    await capture(['env', 'set', 'p', 'KEY'], { env: r.run })
    await capture(['env', 'unset', 'p', 'KEY'], { env: r.run })
    expect(r.seen).toEqual([
      { verb: 'list', project: 'p', json: true },
      { verb: 'set', project: 'p', argument: 'K=--x=y==' },
      { verb: 'set', project: 'p', argument: 'KEY' },
      { verb: 'unset', project: 'p', name: 'KEY' },
    ])
  })

  it('prints its usage and exits 2 for a missing verb, project or key', async () => {
    const r = recording<unknown>()
    for (const argv of [['env'], ['env', 'list'], ['env', 'set', 'p'], ['env', 'unset', 'p']]) {
      const a = await capture(argv, { env: r.run })
      expect(a.code).toBe(2)
      expect(a.err).toContain('lingtai env set <project> KEY=VALUE')
    }
    expect(r.seen).toEqual([])
  })

  it('answers a missing project under --json with the usage error document on stdout', async () => {
    const a = await capture(['env', 'list', '--json'], { env: recording<unknown>().run })
    expect(a.code).toBe(2)
    expect(JSON.parse(a.out)).toMatchObject({ command: 'env list', error: { code: 'usage' } })
  })

  it('answers a read that threw with the error document under --json, exit 1', async () => {
    // Through the live runner and its `lift`, so the message is the module's own and not the wrapper's.
    vi.resetModules()
    vi.doMock('../src/env.ts', async (orig) => ({
      ...(await orig<typeof import('../src/env.ts')>()),
      envList: () => Effect.fail(new Error('unknown project "nope"')),
    }))
    let a: Awaited<ReturnType<typeof capture>>
    try {
      const { runCli: fresh } = await import('../test/cli.ts')
      a = await capture(['env', 'list', 'nope', '--json'], {}, fresh)
    } finally {
      vi.doUnmock('../src/env.ts')
    }
    expect(a.code).toBe(1)
    expect(JSON.parse(a.out)).toEqual({
      version: 1,
      command: 'env list',
      error: { code: 'unavailable', message: 'unknown project "nope"' },
    })
  })

  it('takes --json on list and nowhere else', async () => {
    const r = recording<unknown>()
    expect((await capture(['env', 'set', 'p', 'K=v', '--json'], { env: r.run })).code).toBe(1)
    expect(r.seen).toEqual([])
  })
})

describe('lingtai projection', () => {
  it('hands lag and rebuild to the runner', async () => {
    const r = recording<Parameters<Runners['projection']>[0]>()
    await capture(['projection', 'lag', '--json'], { projection: r.run })
    await capture(['projection', 'rebuild', 'spend'], { projection: r.run })
    expect(r.seen).toEqual([
      { verb: 'lag', json: true },
      { verb: 'rebuild', name: 'spend' },
    ])
  })

  it('refuses a missing or unknown name with the sentences it always had, exit 2', async () => {
    const r = recording<unknown>()
    const none = await capture(['projection', 'rebuild'], { projection: r.run })
    expect(none.code).toBe(2)
    expect(none.err).toContain('lingtai projection rebuild <name>')
    const unknown = await capture(['projection', 'rebuild', 'x'], { projection: r.run })
    expect(unknown.code).toBe(2)
    expect(unknown.err).toBe('✗ unknown projection "x" — known: task_view, finding_backlog, spend, ticket_report\n')
    expect(r.seen).toEqual([])
  })

  it('prints the command help on no verb, and answers `run` by name, in text and under --json', async () => {
    const r = recording<unknown>()
    const bare = await capture(['projection'], { projection: r.run })
    expect(bare.code).toBe(2)
    expect(bare.err).toContain('lingtai projection lag')
    const gone = await capture(['projection', 'run'], { projection: r.run })
    expect(gone.code).toBe(2)
    expect(gone.err).toMatch(/^✗ lingtai projection run is gone — it was another name for lingtai daemon/)
    const asJson = await capture(['projection', 'run', '--json'], { projection: r.run })
    expect(asJson.code).toBe(2)
    expect(JSON.parse(asJson.out).error.code).toBe('usage')
    const plain = await capture(['projection', 'run', '--no-color'], { projection: r.run })
    expect(plain.err).not.toContain(ESC)
    expect(r.seen).toEqual([])
  })
})

describe('lingtai upgrade, rollback and uninstall', () => {
  it('hand the runner what was typed', async () => {
    const up = recording<Parameters<Runners['upgrade']>[0]>()
    const back = recording<Parameters<Runners['rollback']>[0]>()
    const un = recording<Parameters<Runners['uninstall']>[0]>()
    await capture(['upgrade', '--despite-doctor'], { upgrade: up.run })
    await capture(['upgrade'], { upgrade: up.run })
    await capture(['rollback', '0.9.0'], { rollback: back.run })
    await capture(['rollback'], { rollback: back.run })
    await capture(['uninstall', '--yes', '--nothing-conducts'], { uninstall: un.run })
    await capture(['uninstall'], { uninstall: un.run })
    expect(up.seen).toEqual([{ despiteDoctor: true }, { despiteDoctor: false }])
    expect(back.seen).toEqual([{ version: '0.9.0' }, {}])
    expect(un.seen).toEqual([
      { yes: true, nothingConducts: true },
      { yes: false, nothingConducts: false },
    ])
  })

  it('answer an unknown flag or a second version with the parser’s usage error, exit 1', async () => {
    const up = recording<unknown>()
    const back = recording<unknown>()
    const un = recording<unknown>()
    expect((await capture(['upgrade', '--bogus'], { upgrade: up.run })).code).toBe(1)
    expect((await capture(['uninstall', '--bogus'], { uninstall: un.run })).code).toBe(1)
    expect((await capture(['rollback', 'a', 'b'], { rollback: back.run })).code).toBe(1)
    // `--x` is an unknown flag on `effect/cli`, not a version as `@effect/cli` took it.
    expect((await capture(['rollback', '--x'], { rollback: back.run })).code).toBe(1)
    expect([...up.seen, ...back.seen, ...un.seen]).toEqual([])
  })
})

const listing: ProjectEnvListing = {
  file: '/h/.lingtai/env/p.env',
  names: [
    { name: 'API_KEY', layer: 'project file' },
    { name: 'FROM_SECRET', layer: 'project file' },
  ] as ProjectEnvListing['names'],
  deferred: ['FROM_SECRET'],
}

describe('env list, laid out', () => {
  it('has a heading, the file, the promise and a table — and no escape code in plain mode', () => {
    const lines = renderEnvList(listing, 'p')
    expect(lines).toEqual([
      'env p',
      'file  /h/.lingtai/env/p.env',
      '2 name(s), values never shown',
      '',
      'NAME         LAYER',
      'API_KEY      project file',
      'FROM_SECRET  project file — asks for a secret source (a "!" value), which is not built yet',
    ])
    expect(lines.join('\n')).not.toContain(ESC)
  })

  it('stays one line for a project with nothing, and keeps formatEnvList’s string form', () => {
    const empty: ProjectEnvListing = { file: '/h/p.env', names: [], deferred: [] }
    expect(renderEnvList(empty, 'p')).toEqual(['no names — nothing in /h/p.env'])
    expect(formatEnvList(listing)).toContain('API_KEY')
  })

  it('--json carries names, layers and the deferred flag, and no field a value could be in', () => {
    const planted = { ...listing, names: [...listing.names, { name: 'DB', layer: 'project file', value: 'hunter2' }] }
    const text = JSON.stringify({ version: 1, command: 'env list', ...envListJson('p', planted as ProjectEnvListing) })
    expect(text).not.toContain('hunter2')
    expect(JSON.parse(text)).toEqual({
      version: 1,
      command: 'env list',
      project: 'p',
      file: '/h/.lingtai/env/p.env',
      names: [
        { name: 'API_KEY', layer: 'project file', deferred: false },
        { name: 'FROM_SECRET', layer: 'project file', deferred: true },
        { name: 'DB', layer: 'project file', deferred: false },
      ],
    })
  })
})

describe('projection lag, laid out', () => {
  const lags: ProjectionLag[] = [
    { name: 'task_view', lastSeq: 812n, headSeq: 812n, lag: 0n, updatedAt: new Date('2026-10-25T01:02:03.000Z') },
    { name: 'spend', lastSeq: 10n, headSeq: 12n, lag: 2n, updatedAt: null },
  ]

  it('is a heading and a table, and one line for a log with no checkpoint', () => {
    const lines = renderProjectionLag(lags)
    expect(lines).toEqual([
      'projections',
      'NAME       AT       BEHIND  UPDATED',
      'task_view  812/812  0       2026-10-25T01:02:03.000Z',
      'spend      10/12    2       never',
    ])
    expect(lines.join('\n')).not.toContain(ESC)
    expect(renderProjectionLag([])).toEqual(['no projection has a checkpoint yet'])
  })

  it('--json writes the bigint seqs as decimal strings, and an empty log as an empty list', () => {
    expect(JSON.parse(JSON.stringify(projectionLagJson(lags)))).toEqual({
      projections: [
        { name: 'task_view', lastSeq: '812', headSeq: '812', lag: '0', updatedAt: '2026-10-25T01:02:03.000Z' },
        { name: 'spend', lastSeq: '10', headSeq: '12', lag: '2', updatedAt: null },
      ],
    })
    expect(projectionLagJson([])).toEqual({ projections: [] })
  })
})

/** A world over paths that do not exist: the refusals and the empty cases need nothing else. */
function world(env: NodeJS.ProcessEnv, log: string[], self = '/checkout/apps/cli/src/cli.ts'): World {
  return {
    env,
    self,
    fetch: (() => {
      throw new Error('nothing here may ask the network')
    }) as unknown as typeof fetch,
    log: (line) => void log.push(line),
    ask: () => Effect.succeed(false),
    running: () => [],
    conducting: () => Effect.succeed(null),
    drain: () => Effect.succeed({ ok: false, code: 1 }),
    app: () => Effect.succeed(null),
    logWhere: () => ({ kind: 'none' }) as ReturnType<World['logWhere']>,
  }
}

const NOWHERE = {
  HOME: '/nonexistent-625/home',
  LINGTAI_HOME: '/nonexistent-625/home/.lingtai',
  LINGTAI_BIN_DIR: '/nonexistent-625/bin',
}

describe('the install commands, laid out', () => {
  it('open with their heading, and refuse with ✗ and the sentence as it was', async () => {
    const up: string[] = []
    expect(await Effect.runPromise(upgrade({ despiteDoctor: false }, world(NOWHERE, up)))).toBe(1)
    expect(up[0]).toBe('upgrade')
    expect(up[1]).toMatch(
      /^✗ this lingtai is not under \/nonexistent-625\/home\/\.lingtai\/versions — a checkout upgrades/,
    )

    const back: string[] = []
    expect(rollback({}, world(NOWHERE, back))).toBe(1)
    expect(back).toEqual(['rollback', '✗ there is no /nonexistent-625/bin/lingtai to move — nothing is installed here'])

    const un: string[] = []
    expect(
      await Effect.runPromise(
        uninstall({ yes: true, nothingConducts: false }, world({ ...NOWHERE, LINGTAI_HOME: NOWHERE.HOME }, un)),
      ),
    ).toBe(1)
    expect(un[0]).toBe('uninstall')
    expect(un[1]).toMatch(/^✗ not uninstalling: LINGTAI_HOME is \/nonexistent-625\/home, and removing/)
  })

  it('refuse a binary outside LINGTAI_HOME/versions by naming both paths, never as a checkout', async () => {
    const lines: string[] = []
    const self = '/elsewhere/versions/0.10.0/lingtai'
    expect(
      await Effect.runPromise(
        upgrade({ despiteDoctor: false }, world(NOWHERE, lines, self), { form: 'binary', lingtai: '0.10.0' }),
      ),
    ).toBe(1)
    const refusal = lines[1]!
    expect(refusal).toContain('/elsewhere/versions/0.10.0')
    expect(refusal).toContain('/nonexistent-625/home/.lingtai/versions')
    expect(refusal).toContain('unset LINGTAI_HOME')
    expect(refusal).not.toMatch(/git pull|checkout/)
  })

  it('asks GitHub for a binary outside LINGTAI_HOME/versions, using its own version', async () => {
    let asked = 0
    const w = world(NOWHERE, [], '/elsewhere/versions/0.9.0/lingtai')
    w.fetch = (async () => {
      asked++
      return new Response(JSON.stringify({ tag_name: 'v0.11.0', assets: [] }), { status: 200 })
    }) as unknown as typeof fetch
    const row = await Effect.runPromise(releaseCheck(w, { form: 'binary', lingtai: '0.10.0' }))
    expect(asked).toBeGreaterThan(0)
    expect(row.name).toBe('release: newest')
    expect(row.status).toBe('warn')
    expect(row.detail).toBe('running 0.10.0, and 0.11.0 is out')
  })

  it('refuses with the fetch error’s own words when GitHub cannot be asked', async () => {
    const lines: string[] = []
    const home = mkdtempSync(join(tmpdir(), 'lingtai-enotfound-'))
    const self = join(home, 'versions', '0.10.0', 'lingtai')
    mkdirSync(dirname(self), { recursive: true })
    writeFileSync(self, '')
    const w = world({ ...NOWHERE, LINGTAI_HOME: home }, lines, self)
    w.fetch = (async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }) as unknown as typeof fetch
    const code = await Effect.runPromise(upgrade({ despiteDoctor: false }, w, { form: 'binary', lingtai: '0.10.0' }))
    expect(code).toBe(1)
    rmSync(home, { recursive: true, force: true })
    expect(lines.at(-1)).toContain(
      'could not ask GitHub Releases which version is newest — getaddrinfo ENOTFOUND. Nothing changed',
    )
  })

  it('treats a rejection that is not an Error as a failure, never as an answer', async () => {
    const lines: string[] = []
    const home = mkdtempSync(join(tmpdir(), 'lingtai-nonerror-'))
    const self = join(home, 'versions', '0.10.0', 'lingtai')
    mkdirSync(dirname(self), { recursive: true })
    writeFileSync(self, '')
    const w = world({ ...NOWHERE, LINGTAI_HOME: home }, lines, self)
    w.fetch = (async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'down'
    }) as unknown as typeof fetch
    const code = await Effect.runPromise(upgrade({ despiteDoctor: false }, w, { form: 'binary', lingtai: '0.10.0' }))
    expect(code).toBe(1)
    expect(lines.at(-1)).toContain('could not ask GitHub Releases which version is newest — down. Nothing changed')

    const un: string[] = []
    const w2 = world({ ...NOWHERE, LINGTAI_HOME: home }, un)
    w2.conducting = () => Effect.fail(null)
    const kept = await Effect.runPromise(uninstall({ yes: true, nothingConducts: false }, w2))
    expect(kept).toBe(1)
    expect(un.at(-1)).toContain('could not be read')
    rmSync(home, { recursive: true, force: true })
  })

  it('put ✓ on "nothing is installed", and print no escape code in plain mode', async () => {
    const lines: string[] = []
    expect(await Effect.runPromise(uninstall({ yes: true, nothingConducts: false }, world(NOWHERE, lines)))).toBe(0)
    expect(lines).toEqual([
      'uninstall',
      '✓ nothing is installed: there is no /nonexistent-625/home/.lingtai and no /nonexistent-625/bin/lingtai',
    ])
    expect(lines.join('\n')).not.toContain(ESC)
  })
})
