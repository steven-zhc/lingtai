import { RECIPE_PATH, resolveRecipe } from '@lingtai/recipe'
/** The shape of `lingtai doctor`: the text, the `--json` document, and the command through `@effect/cli` (#619). */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  areaOf,
  doctorJson,
  type DoctorReport,
  extensionRow,
  formatReport,
  renderDoctor,
  shareFixes,
  subscriberRow,
  tally,
  timed,
} from '../src/doctor.ts'

const results: DoctorReport['results'] = [
  { name: 'daemon: liveness', status: 'ok', detail: 'up, last beat 2s ago' },
  {
    name: 'daemon: currency',
    status: 'warn',
    detail: 'running 8f3a1c2 — 3 commit(s) behind origin/main — restart the daemon to take them',
  },
  {
    name: 'environment',
    status: 'fail',
    detail: 'two databases named — they must be one database',
    restartAnswers: true,
  },
  { name: 'packages load under Node', status: 'ok', detail: 'every package imports' },
  { name: 'schema: tables', status: 'fail', detail: 'missing events — run the migration' },
  { name: 'runtime: signed in', status: 'skip', detail: 'no project names a runtime' },
  { name: 'unknown thing', status: 'ok', detail: 'somewhere unexpected' },
  { name: 'hook: fail closed', status: 'skip', detail: 'every run proves it immediately', deferred: true },
]
const report: DoctorReport = { results, ...tally(results) }

describe('tally', () => {
  it('counts a skip without deferred as not checked', () => {
    expect(tally(results)).toEqual({ ok: 3, failed: 2, skipped: 2, deferred: 1, notChecked: 1, warned: 1, info: 0 })
  })
})

describe('an info row (#718)', () => {
  const info = { name: 'runtime: other settings in scope', status: 'info' as const, detail: 'first line\nsecond line' }
  const only = [{ name: 'node: at or above the floor', status: 'ok' as const, detail: 'x' }, info]
  const rep: DoctorReport = { results: only, ...tally(only) }

  it('is counted as info and neither warned nor failed', () => {
    expect(tally(only)).toMatchObject({ ok: 1, warned: 0, failed: 0, info: 1 })
  })

  it('is one note line in the short view, with no [next]', () => {
    const text = renderDoctor(rep).join('\n')
    expect(text).toContain('[note] first line')
    expect(text).not.toContain('second line')
    expect(text).not.toContain('[next]')
  })

  it('is drawn among its area in --verbose', () => {
    const text = renderDoctor(rep, { verbose: true }).join('\n')
    expect(text).toContain('note  runtime: other settings in scope')
    expect(text).toContain('second line')
    expect(text).toContain('1 noted')
  })

  it('is in --json with the same version-free shape', () => {
    const json = doctorJson(rep)
    expect(json['info']).toBe(1)
    expect((json['checks'] as { status: string }[]).map((c) => c.status)).toContain('info')
  })
})

describe('areaOf', () => {
  it('reads the prefix, the whole name when it has no colon, and defers whatever is deferred', () => {
    expect(results.map(areaOf)).toEqual([
      'Daemon',
      'Daemon',
      'Store and log',
      'Machine',
      'Store and log',
      'Runtimes',
      'Other',
      'Not implemented here',
    ])
  })
})

describe('doctorJson', () => {
  it('is pinned', () => {
    expect(doctorJson(report)).toEqual({
      ok: 3,
      failed: 2,
      warned: 1,
      info: 0,
      skipped: 2,
      deferred: 1,
      notChecked: 1,
      checks: [
        {
          area: 'Daemon',
          name: 'daemon: liveness',
          status: 'ok',
          detail: 'up, last beat 2s ago',
          deferred: false,
          restartAnswers: false,
        },
        {
          area: 'Daemon',
          name: 'daemon: currency',
          status: 'warn',
          detail: 'running 8f3a1c2 — 3 commit(s) behind origin/main — restart the daemon to take them',
          deferred: false,
          restartAnswers: false,
        },
        {
          area: 'Store and log',
          name: 'environment',
          status: 'fail',
          detail: 'two databases named — they must be one database',
          deferred: false,
          restartAnswers: true,
        },
        {
          area: 'Machine',
          name: 'packages load under Node',
          status: 'ok',
          detail: 'every package imports',
          deferred: false,
          restartAnswers: false,
        },
        {
          area: 'Store and log',
          name: 'schema: tables',
          status: 'fail',
          detail: 'missing events — run the migration',
          deferred: false,
          restartAnswers: false,
        },
        {
          area: 'Runtimes',
          name: 'runtime: signed in',
          status: 'skip',
          detail: 'no project names a runtime',
          deferred: false,
          restartAnswers: false,
        },
        {
          area: 'Other',
          name: 'unknown thing',
          status: 'ok',
          detail: 'somewhere unexpected',
          deferred: false,
          restartAnswers: false,
        },
        {
          area: 'Not implemented here',
          name: 'hook: fail closed',
          status: 'skip',
          detail: 'every run proves it immediately',
          deferred: true,
          restartAnswers: false,
        },
      ],
    })
  })
})

describe('renderDoctor', () => {
  const keep = { no: process.env['NO_COLOR'], force: process.env['FORCE_COLOR'], term: process.env['TERM'] }
  afterEach(() => {
    for (const [name, value] of [
      ['NO_COLOR', keep.no],
      ['FORCE_COLOR', keep.force],
      ['TERM', keep.term],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('puts sections with a failure first, then a note, then the rest, and not implemented last', () => {
    process.env['NO_COLOR'] = '1'
    const lines = renderDoctor(report, { verbose: true })
    const headings = lines.filter((l) => /^\S/.test(l) && l !== '' && !/ok|FAILED/.test(l))
    expect(headings).toEqual([
      'doctor',
      'Store and log',
      'Daemon',
      'Machine',
      'Runtimes',
      'Other',
      'Not implemented here',
    ])
  })

  it('orders a section fail, note, ok, skip, and puts the detail on the next line', () => {
    process.env['NO_COLOR'] = '1'
    const text = renderDoctor(report, { verbose: true }).join('\n')
    expect(text).toContain(
      'Daemon\n  !     daemon: currency\n        running 8f3a1c2 — 3 commit(s) behind origin/main — restart the daemon to take them\n  ✓     daemon: liveness\n        up, last beat 2s ago',
    )
    expect(text.indexOf('✗     environment')).toBeLessThan(text.indexOf('✗     schema: tables'))
  })

  it('loses no name and no detail', () => {
    const text = renderDoctor(report, { verbose: true }).join('\n')
    for (const r of results) {
      expect(text).toContain(r.name)
      expect(text).toContain(r.detail)
    }
  })

  it('keeps the summary words, in the FAILED form and the green one', () => {
    process.env['NO_COLOR'] = '1'
    const verbose = (r: DoctorReport): string => renderDoctor(r, { verbose: true }).join('\n')
    expect(verbose(report)).toContain(
      '2 check(s) FAILED — 3 ok, 1 need attention, 1 not checked here, 1 not implemented yet',
    )
    const green = results.filter((r) => r.status !== 'fail')
    expect(verbose({ results: green, ...tally(green) })).toContain(
      '3 ok, 1 need attention, 1 not checked here, 1 not implemented yet, 0 failed',
    )
    const plain = [{ name: 'node: at or above the floor', status: 'ok' as const, detail: 'x' }]
    expect(verbose({ results: plain, ...tally(plain) })).toContain(
      '1 ok, 0 not checked here, 0 not implemented yet, 0 failed',
    )
  })

  it('draws no colour under NO_COLOR, and colours the cross but not a warn under FORCE_COLOR', () => {
    process.env['NO_COLOR'] = '1'
    delete process.env['FORCE_COLOR']
    expect(renderDoctor(report, { verbose: true }).join('\n')).not.toContain('\u001b')
    expect(formatReport(report)).not.toContain('\u001b')
    delete process.env['NO_COLOR']
    // `TERM=dumb` suppresses colour whatever FORCE_COLOR says.
    delete process.env['TERM']
    process.env['FORCE_COLOR'] = '1'
    const coloured = renderDoctor(report, { verbose: true })
    expect(coloured.find((l) => l.includes('✗') && l.includes('environment'))).toContain('\u001b')
    const warn = coloured.find((l) => l.includes('!') && l.includes('daemon: currency'))!
    expect(warn).not.toContain('\u001b')
    expect(renderDoctor(report).find((l) => l.includes('daemon: currency'))).not.toContain('✗')
  })

  it('is a flat list of what to fix: fails first, no headings, no !', () => {
    process.env['NO_COLOR'] = '1'
    const lines = renderDoctor(report)
    expect(lines.slice(0, 3)).toEqual([
      'doctor',
      '',
      '3 to fix · 3 passed · 1 not checked here · 1 not implemented yet',
    ])
    const text = lines.join('\n')
    expect(text).not.toContain('!')
    expect(text).not.toContain('Daemon')
    expect(text).not.toContain('daemon: liveness')
    expect(text).toContain('[problem] ✗ environment  · store and log\n          two databases named')
    expect(text.indexOf('✗ schema: tables')).toBeLessThan(text.indexOf('daemon: currency'))
    expect(text).toContain('[problem] daemon: currency  · daemon\n          running 8f3a1c2')
    expect(lines.at(-1)).toBe('   [next] lingtai doctor --verbose')
  })

  it('draws the layout the operator chose: one merged cause, its fix, the note', () => {
    process.env['NO_COLOR'] = '1'
    const fix =
      'lingtai env set lingtai TELEGRAM_BOT_TOKEN\nlingtai env set lingtai TELEGRAM_CHAT_ID\nor remove the telegram subscriber'
    const rs: DoctorReport['results'] = [
      { name: 'node: at or above the floor', status: 'ok', detail: 'x' },
      {
        name: 'subscribers: failures',
        status: 'warn',
        title: 'telegram notifications are failing',
        detail: '31 in the last day · TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set',
        fix,
      },
      {
        name: 'env: lingtai extensions',
        status: 'warn',
        title: 'telegram is missing environment variables',
        detail: 'telegram: TELEGRAM_BOT_TOKEN ← not set\nsecond line',
        fix,
      },
      { name: 'runtime: other settings in scope', status: 'info', detail: '~/.claude/settings.json also applies' },
    ]
    expect(renderDoctor({ results: rs, ...tally(rs) }).join('\n')).toBe(
      [
        'doctor',
        '',
        '1 to fix · 1 passed · 0 not checked here · 0 not implemented yet',
        '',
        '[problem] telegram notifications are failing  · daemon, projects',
        '          31 in the last day · TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set',
        '    [fix] lingtai env set lingtai TELEGRAM_BOT_TOKEN',
        '          lingtai env set lingtai TELEGRAM_CHAT_ID',
        '          or remove the telegram subscriber',
        '',
        '   [note] ~/.claude/settings.json also applies',
        '',
        '   [next] lingtai doctor --verbose',
      ].join('\n'),
    )
  })

  it('shows a fix block in --verbose, and the whole detail', () => {
    process.env['NO_COLOR'] = '1'
    const rs: DoctorReport['results'] = [
      {
        name: 'env: p extensions',
        status: 'warn',
        detail: 'one\ntwo',
        fix: 'lingtai env set p A\nlingtai env set p B',
      },
    ]
    const text = renderDoctor({ results: rs, ...tally(rs) }, { verbose: true }).join('\n')
    expect(text).toContain('        two\n        fix  lingtai env set p A\n             lingtai env set p B')
  })

  it('formatReport is the short view with no next line', () => {
    process.env['NO_COLOR'] = '1'
    const text = formatReport(report)
    expect(text).toContain('3 to fix')
    expect(text).not.toContain('[next]')
    expect(text).not.toContain('next:')
  })

  it('draws labels as badges under colour, aligned with the plain column, never amber', () => {
    delete process.env['NO_COLOR']
    delete process.env['TERM']
    process.env['FORCE_COLOR'] = '1'
    const strip = (t: string): string => t.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
    const text = renderDoctor(report).join('\n')
    expect(text).toContain('\u001b[41;97m PROBLEM ')
    expect(text).toContain('\u001b[7m PROBLEM ')
    const fixed = renderDoctor({
      results: [{ name: 'x', status: 'fail', detail: 'd', fix: 'run it' }],
      ...tally([{ name: 'x', status: 'fail', detail: 'd', fix: 'run it' }]),
    }).join('\n')
    expect(fixed).toContain('\u001b[46;30m FIX ')
    expect(text).not.toMatch(new RegExp(`${String.fromCharCode(27)}\\[(?:[0-9;]*;)?33m`))
    expect(strip(fixed)).toContain('     FIX  run it')
    expect(strip(text).split('\n').at(-1)).toBe('    NEXT  lingtai doctor --verbose')
  })

  it('says all passed, and draws nothing else, when nothing is to fix', () => {
    process.env['NO_COLOR'] = '1'
    const ok = [{ name: 'node: at or above the floor', status: 'ok' as const, detail: 'x' }]
    expect(renderDoctor({ results: ok, ...tally(ok) })).toEqual([
      'doctor',
      '',
      'all 1 passed · 0 not checked here · 0 not implemented yet',
    ])
  })

  it('carries title and fix in --json without a new version', () => {
    const rs: DoctorReport['results'] = [{ name: 'a: b', status: 'warn', detail: 'd', title: 'T', fix: 'run it' }]
    const json = doctorJson({ results: rs, ...tally(rs) })
    expect((json['checks'] as Record<string, unknown>[])[0]).toMatchObject({ title: 'T', fix: 'run it' })
    expect(json['failed']).toBe(0)
    expect(json['warned']).toBe(1)
  })
})

describe('lingtai doctor through @effect/cli', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock('../src/doctor.ts')
    vi.doUnmock('../src/install.ts')
  })

  async function run(argv: string[], read: () => Promise<DoctorReport>): Promise<{ code: number; out: string }> {
    vi.resetModules()
    vi.doMock('../src/doctor.ts', async (orig) => ({
      ...(await orig<typeof import('../src/doctor.ts')>()),
      doctorReport: read,
    }))
    // The real one asks GitHub.
    vi.doMock('../src/install.ts', async (orig) => ({
      ...(await orig<typeof import('../src/install.ts')>()),
      releaseCheck: async () => ({ name: 'release: newest', status: 'ok' as const, detail: 'current' }),
    }))
    const { runCli } = await import('../src/cli.ts')
    let out = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((t: unknown) => ((out += String(t)), true))
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void (out += `${a.join(' ')}\n`))
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void (out += `${a.join(' ')}\n`))
    const code = await runCli(['node', 'lingtai', ...argv])
    return { code, out }
  }

  const green = (): DoctorReport => {
    const rs: DoctorReport['results'] = [{ name: 'node: at or above the floor', status: 'ok', detail: 'v22' }]
    return { results: rs, ...tally(rs) }
  }

  it('prints one document and exits 0 when nothing failed, with the release row counted', async () => {
    const { code, out } = await run(['doctor', '--json'], async () => green())
    expect(code).toBe(0)
    const doc = JSON.parse(out)
    expect(doc).toMatchObject({ version: 1, command: 'doctor', ok: 2, failed: 0 })
    expect(doc.checks.map((c: { name: string }) => c.name)).toEqual(['node: at or above the floor', 'release: newest'])
  })

  it('prints the report document and exits 1 when a check failed', async () => {
    const { code, out } = await run(['doctor', '--json'], async () => {
      const rs: DoctorReport['results'] = [{ name: 'log: reachable', status: 'fail', detail: 'down' }]
      return { results: rs, ...tally(rs) }
    })
    expect(code).toBe(1)
    const doc = JSON.parse(out)
    expect(doc.error).toBeUndefined()
    expect(doc).toMatchObject({ command: 'doctor', failed: 1 })
  })

  it('prints the text by default', async () => {
    process.env['NO_COLOR'] = '1'
    const { code, out } = await run(['doctor'], async () => green())
    expect(code).toBe(0)
    expect(out).toContain('all 2 passed · 0 not checked here · 0 not implemented yet')
  })

  it('answers unavailable when the report could not be produced', async () => {
    const { code, out } = await run(['doctor', '--json'], async () => {
      throw new Error('no store')
    })
    expect(code).toBe(1)
    expect(JSON.parse(out)).toMatchObject({ command: 'doctor', error: { code: 'unavailable', message: 'no store' } })
  })
})

describe('the rows that carry a fix (#717)', () => {
  const recipeWith = (subscribers: string, scanner = ''): string => `
version: 2
repo:
  base: main
source:
  kinds: [bug]
env:
  required: []
  plantAt: .env.local
steps:
  proposed:
    - name: scan
      run: npx scanner${scanner}
runtime:
  agent: claude-code
subscribers:
${subscribers}
`
  const telegram =
    '  - name: telegram\n    on: [TicketLanded]\n    run: npx t\n    env: [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID]'
  const notify = '  - name: notify\n    on: [TicketLanded]\n    run: npx n\n    env: [NOTIFY_KEY]'
  const resolve = async (text: string) =>
    (await resolveRecipe(async (path, ref) => (ref === 'main' && path === RECIPE_PATH ? text : null), 'main')).recipe
  const held = (merged: Record<string, string>) => ({
    merged,
    names: Object.keys(merged).map((name) => ({ name, layer: 'project file' })),
    file: '/home/x/.lingtai/env/p.env',
  })

  it('names one command per missing name, and offers removal only for a subscriber', async () => {
    const row = extensionRow('lingtai', await resolve(recipeWith(telegram)), held({}))
    expect(row.status).toBe('warn')
    expect(row.title).toBe('telegram is missing environment variables')
    expect(row.fix).toBe(
      'lingtai env set lingtai TELEGRAM_BOT_TOKEN\nlingtai env set lingtai TELEGRAM_CHAT_ID\nor remove the telegram subscriber',
    )
    expect(row.detail).not.toContain('0037')
    expect(row.detail).not.toContain('0015')
  })

  it('never offers to remove a step extension, even beside a short subscriber', async () => {
    const recipe = await resolve(recipeWith(telegram, '\n      env: [SCANNER_TOKEN]'))
    const row = extensionRow('lingtai', recipe, held({}))
    expect(row.status).toBe('fail')
    expect(row.fix).toContain('lingtai env set lingtai SCANNER_TOKEN')
    expect(row.fix).not.toContain('or remove')
  })

  it('draws a subscriber row and its project row once, tagged with both areas', async () => {
    const env = extensionRow('lingtai', await resolve(recipeWith(telegram)), held({}))
    const sub = subscriberRow([
      {
        name: 'telegram',
        total: 31,
        recent: 31,
        last: new Date(),
        lastReason: 'TELEGRAM_BOT_TOKEN not set — lingtai env set <project> …',
      },
    ] as never)
    expect(sub.title).toBe('telegram notifications are failing')
    expect(sub.detail).toBe('31 in the last day · TELEGRAM_BOT_TOKEN not set')
    const rs = [sub, env]
    shareFixes(rs)
    expect(sub.fix).toBe(env.fix)
    process.env['NO_COLOR'] = '1'
    const text = renderDoctor({ results: rs, ...tally(rs) }).join('\n')
    expect(text.match(/\[fix\]/g)).toHaveLength(1)
    expect(text).toContain('telegram notifications are failing  · daemon, projects')
  })

  it('copies nothing with no match, or with two', async () => {
    const sub = () =>
      subscriberRow([{ name: 'telegram', total: 1, recent: 1, last: new Date(), lastReason: 'r' }] as never)
    const none = sub()
    shareFixes([none, extensionRow('a', await resolve(recipeWith(notify)), held({}))])
    expect(none.fix).toBeUndefined()

    const two = sub()
    const recipe = await resolve(recipeWith(telegram))
    shareFixes([two, extensionRow('a', recipe, held({})), extensionRow('b', recipe, held({}))])
    expect(two.fix).toBeUndefined()
  })

  it('copies nothing when the shortage is mixed with a step', async () => {
    const sub = subscriberRow([{ name: 'telegram', total: 1, recent: 1, last: new Date(), lastReason: 'r' }] as never)
    const env = extensionRow('a', await resolve(recipeWith(telegram, '\n      env: [SCANNER_TOKEN]')), held({}))
    shareFixes([sub, env])
    expect(sub.fix).toBeUndefined()
  })

  it('shares the fix between rows that runDoctor has timed, which copies each one', async () => {
    const env = extensionRow('lingtai', await resolve(recipeWith(telegram)), held({}))
    const sub = subscriberRow([{ name: 'telegram', total: 1, recent: 1, last: new Date(), lastReason: 'r' }] as never)
    const rs = [sub, env].map((r) => timed(r, 5))
    shareFixes(rs)
    expect(rs[0]!.fix).toBe(env.fix)
  })
})
