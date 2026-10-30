import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Currency } from '@lingtai/daemon'
import type { UnconvergedUpdate } from '@lingtai/event-store'
import type { GhRun } from '@lingtai/github'
import { describe, expect, it } from 'vitest'

import {
  currencyRow,
  daemonCurrency,
  describeRefusal,
  ghLogin,
  refusalsRow,
  ratesCheck,
  githubCredentials,
  spendToday,
  unconvergedRow,
  type CheckResult,
} from '../src/doctor.js'

/** What the title of any row in this ticket must not carry: an issue or ADR number, a hash, a path. */
const PLAIN = (title: string | undefined) => {
  expect(title).toBeTruthy()
  expect(title!.length).toBeLessThanOrEqual(60)
  expect(title).not.toMatch(/#\d|\b\d{4}\b|\b[0-9a-f]{7,40}\b|\//)
}
const firstLine = (r: CheckResult) => r.detail.split('\n')[0]!

const RESTART = 'lingtai restart "picking up main"'

describe('daemon: currency', () => {
  const behind: Currency = {
    running: 'a'.repeat(40),
    dirty: false,
    base: 'origin/main',
    baseSha: 'b'.repeat(40),
    behind: [
      { sha: 'abc1234', subject: 'one' },
      { sha: 'def5678', subject: 'two' },
    ],
    unknown: null,
  }

  it('titles the behind warn, with the commits on later lines and a restart fix', () => {
    const row = currencyRow(behind)
    expect(row).toMatchObject({ name: 'daemon: currency', status: 'warn', fix: RESTART })
    expect(row.title).toBe('the daemon is 2 commit(s) behind main')
    PLAIN(row.title)
    expect(row.detail.split('\n')).toHaveLength(3)
    expect(firstLine(row)).not.toContain('abc1234')
  })

  it('titles the no-commit warn', async () => {
    const row = await daemonCurrency(async () => ({ codeSha: null, state: 'idle', lastSeenAt: new Date() }) as never)
    expect(row.name).toBe('daemon: currency')
    expect(row.status).toBe('warn')
    expect(row.fix).toBe(RESTART)
    PLAIN(row.title)
  })

  it('is not a warn, and offers no restart, for a binary daemon that records no commit', async () => {
    const row = await daemonCurrency(async () => ({ codeSha: null, state: 'idle', lastSeenAt: new Date() }) as never, {
      form: 'binary',
      lingtai: '0.10.0',
    })
    expect(row.status).toBe('ok')
    expect(row.fix).toBeUndefined()
    expect(row.detail).toContain('0.10.0')
    expect(row.detail).not.toContain('lingtai restart')
  })

  it('judges a binary by its own form even when the beacon carries a sha', async () => {
    const row = await daemonCurrency(
      async () => ({ codeSha: 'abcdef0123', codeDirty: false, state: 'idle', lastSeenAt: new Date() }) as never,
      { form: 'binary', lingtai: '0.10.0' },
    )
    expect(row.status).toBe('ok')
    expect(row.fix).toBeUndefined()
    expect(row.detail).toContain('0.10.0')
  })
})

describe('conductor: refusals on the log', () => {
  const refusal = {
    project: 'lingtai',
    detail: 'env: Unrecognized key',
    ref: 'main',
    codeSha: 'c'.repeat(40),
    seq: 9n,
    at: new Date('2026-09-12T10:00:00.000Z'),
  }

  it('titles both outcomes in words, with the reason on the first line', () => {
    const fail = describeRefusal('lingtai', refusal, { daemonUp: true, here: refusal.codeSha })
    const warn = describeRefusal('lingtai', refusal, { daemonUp: false, here: refusal.codeSha })
    PLAIN(fail.title)
    PLAIN(warn.title)
    expect(fail.title).toContain('lingtai')
    expect(fail.detail.split('\n')[0]).toBe('lingtai: env: Unrecognized key')
  })

  it('offers the restart only when every failing project is refused by older code', () => {
    const older = describeRefusal('lingtai', refusal, { daemonUp: true, here: 'd'.repeat(40), behind: true })
    const same = describeRefusal('lingtai', refusal, { daemonUp: true, here: refusal.codeSha })
    expect(older.restartAnswers).toBe(true)
    expect(refusalsRow([older])).toMatchObject({ status: 'fail', fix: RESTART, restartAnswers: true })
    expect(refusalsRow([older]).title).toBe(older.title)
    const two = refusalsRow([older, older])
    expect(two.title).toBe('2 projects are refused by the last pass')
    expect(two.fix).toBe(RESTART)
    expect(refusalsRow([older, same]).fix).toBeUndefined()
    expect(refusalsRow([same]).fix).toBeUndefined()
  })
})

describe('spend: today', () => {
  const day = {
    reportedCents: 0,
    reportedRuns: 0,
    estimatedCents: 0,
    estimatedRuns: 0,
    fetchedRuns: 0,
    unknown: 2,
    unknownWhy: [{ reason: 'no usage reported', runs: 2 }],
  }

  it('titles the warn and the fail, and gives neither a fix', async () => {
    const warn = await spendToday(async () => ({ day, ceilingUsd: 50 }))
    expect(warn.title).toBe("2 of today's runs reported no cost")
    expect(firstLine(warn)).toBe('the daily ceiling cannot see them')
    const fail = await spendToday(async () => {
      throw new Error('nope')
    })
    expect(fail.status).toBe('fail')
    PLAIN(fail.title)
    expect(warn.fix ?? fail.fix).toBeUndefined()
  })
})

describe('github: gh login', () => {
  const env = { LINGTAI_HOME: '/nonexistent/lingtai-home', LINGTAI_GITHUB_AUTH: 'gh' }
  const hosts = (entry: unknown) => JSON.stringify({ hosts: { 'github.com': [entry] } })

  it('titles signed out, fix gh auth login', async () => {
    const out: GhRun = async () => ({ code: 1, stdout: hosts({ state: 'error', active: true }), stderr: '' })
    const row = await ghLogin(env, out)
    PLAIN(row?.title)
    expect(row?.fix).toBe('gh auth login')
  })

  it('gives a missing or too-old gh its own title and no sign-in fix', async () => {
    const missing = await ghLogin(env, async () => ({ missing: true }) as never)
    expect(missing).toMatchObject({ status: 'fail', title: 'gh is not installed' })
    expect(missing?.fix).toBeUndefined()
    const old = await ghLogin(env, async () => ({ code: 1, stdout: '', stderr: 'unknown flag: --json' }))
    expect(old).toMatchObject({ status: 'fail', title: 'gh is too old to report its login' })
    expect(old?.fix).toBeUndefined()
    const out = await ghLogin(env, async () => ({
      code: 1,
      stdout: hosts({ state: 'error', active: true }),
      stderr: '',
    }))
    expect(out?.detail).not.toContain('gh auth login')
  })

  it('titles a scope gap, fix the refresh the gap names', async () => {
    const run: GhRun = async () => ({
      code: 0,
      stdout: hosts({ state: 'success', active: true, login: 'op', scopes: 'repo' }),
      stderr: '',
    })
    const row = await ghLogin(env, run)
    PLAIN(row?.title)
    expect(row?.fix).toBe('gh auth refresh --hostname github.com --scopes workflow')
    expect(row?.detail).not.toContain('gh auth')
  })
})

describe('github: app credentials', () => {
  it('titles an unreadable key and offers no fix', () => {
    const row = githubCredentials({
      LINGTAI_HOME: '/nonexistent/lingtai-home',
      LINGTAI_GITHUB_APP_ID: '1',
      LINGTAI_GITHUB_APP_PRIVATE_KEY: 'not a key',
    })
    expect(row.name).toBe('github: app credentials')
    expect(row.status).toBe('fail')
    PLAIN(row.title)
    expect(row.fix).toBeUndefined()
  })
})

describe('github: what we said and did not manage', () => {
  const rows = (change: string, project = 'lingtai'): UnconvergedUpdate[] => [{ project, issue: '1', change }] as never
  const book = new Map() as never

  it('titles each non-ok outcome and gives none a fix', () => {
    const comment = unconvergedRow(rows('comment'), book, new Map())
    const blocked = unconvergedRow(rows('labels', 'broken'), book, new Map([['broken', 'bad']]))
    const diverged = unconvergedRow(rows('labels'), book, new Map())
    expect(comment.title).toBe('1 comment(s) were never posted')
    expect(blocked.title).toBe('1 issue(s) cannot converge until a recipe resolves')
    expect(diverged.title).toBe('1 issue(s) on GitHub differ from the log')
    for (const r of [comment, blocked, diverged]) {
      PLAIN(r.title)
      expect(r.fix).toBeUndefined()
      expect(r.detail.split('\n').length).toBeGreaterThan(1)
    }
  })
})

describe('rates', () => {
  const home = (note: object) => {
    const dir = mkdtempSync(join(tmpdir(), 'rates-'))
    mkdirSync(join(dir, 'rates'), { recursive: true })
    return { dir, env: { LINGTAI_HOME: dir } as NodeJS.ProcessEnv, note }
  }
  const write = (note: object) => {
    const { dir, env } = home(note)
    for (const sub of ['', 'rates']) {
      writeFileSync(join(dir, sub, 'rates-fetch.json'), JSON.stringify(note))
    }
    return env
  }

  it('titles a failed fetch and gives it no fix', () => {
    const row = ratesCheck(write({ at: '2026-10-01T00:00:00Z', ok: false, error: 'offline', rejected: ['m-1'] }))
    expect(row).toMatchObject({ name: 'rates', status: 'warn', title: 'the last price fetch failed' })
    expect(row.fix).toBeUndefined()
    PLAIN(row.title)
    expect(firstLine(row)).not.toContain('m-1')
  })

  it('titles a spend that was not rebuilt and offers the rebuild', () => {
    const row = ratesCheck(
      write({ at: '2026-10-01T00:00:00Z', ok: true, rejected: [], priced: ['m-2'], rebuilt: 'not rebuilt' }),
      3n,
    )
    expect(row).toMatchObject({
      status: 'warn',
      title: 'spend was not rebuilt after new prices',
      fix: 'lingtai projection rebuild spend',
    })
    PLAIN(row.title)
    expect(firstLine(row)).not.toContain('m-2')
  })
})
