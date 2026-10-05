/**
 * Where configuration values come from. No database, no network.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  directPostgresUrl,
  directUrlIfSet,
  githubApp,
  githubWebhookSecret,
  hasGitHubApp,
  logConfigured,
  machineDatabaseUrl,
  postgresUrl,
  postgresUrlIfSet,
  resolvePath,
} from '../src/index.ts'

describe('resolvePath', () => {
  /**
   * The README documented `~/.lingtai-app.pem` before this existed. Nothing
   * else expands `~` there — a shell does not read a YAML file, and
   * `path.resolve` would have produced a directory
   * *named* `~` inside the repository. The failure would have been a bare ENOENT
   * naming a path nobody wrote.
   */
  it('expands a leading tilde', () => {
    expect(resolvePath('~/.lingtai-app.pem')).toBe(resolve(homedir(), '.lingtai-app.pem'))
    expect(resolvePath('~')).toBe(homedir())
  })

  it('does not expand a tilde that is not the whole first segment', () => {
    // `~backup` is a file called that, not another user's home.
    expect(resolvePath('~backup.pem')).toContain('~backup.pem')
  })

  it('leaves an absolute path alone', () => {
    expect(resolvePath('/etc/lingtai/key.pem')).toBe('/etc/lingtai/key.pem')
  })

  it('resolves a relative path against the repository root, not the cwd', () => {
    // A command's directory must not change what configuration means.
    const fromRoot = resolvePath('../lingtai-app.pem')
    expect(fromRoot.endsWith('lingtai-app.pem')).toBe(true)
    expect(fromRoot.startsWith('/')).toBe(true)
    expect(fromRoot).not.toContain('packages/env')
  })
})

/**
 * #176. Two URLs are Supabase's; a plain Postgres writes one. Each case hands
 * an environment rather than touching `process.env`, which under vitest would
 * always take the `TEST_` side.
 */
describe('the direct URL falls back to the pooled one', () => {
  const POOLED = 'postgresql://u:p@db.example.com:6543/postgres?pgbouncer=true'
  const DIRECT = 'postgresql://u:p@db.example.com:5432/postgres'

  it('uses the pooled URL when the direct one is absent', () => {
    expect(directPostgresUrl({ LINGTAI_DATABASE_URL: DIRECT })).toBe(DIRECT)
    // Empty is absent, as it is for every other name here.
    expect(directPostgresUrl({ LINGTAI_DATABASE_URL: DIRECT, LINGTAI_DIRECT_DATABASE_URL: '' })).toBe(DIRECT)
  })

  it('never overrides a direct URL that is set', () => {
    // On Supabase the two genuinely differ, and the pooled one is the
    // connection that loses a NOTIFY without saying so.
    expect(directPostgresUrl({ LINGTAI_DATABASE_URL: POOLED, LINGTAI_DIRECT_DATABASE_URL: DIRECT })).toBe(DIRECT)
  })

  it('refuses by name when neither is set', () => {
    expect(() => directPostgresUrl({})).toThrow(/LINGTAI_DIRECT_DATABASE_URL is not set/)
  })

  it("falls back within the TEST_ pair, and never across to the operator's", () => {
    const test = { LINGTAI_TEST: '1' }
    expect(directPostgresUrl({ ...test, LINGTAI_TEST_DATABASE_URL: DIRECT })).toBe(DIRECT)
    expect(
      directPostgresUrl({ ...test, LINGTAI_TEST_DATABASE_URL: POOLED, LINGTAI_TEST_DIRECT_DATABASE_URL: DIRECT }),
    ).toBe(DIRECT)
    expect(() =>
      directPostgresUrl({ ...test, LINGTAI_DATABASE_URL: POOLED, LINGTAI_DIRECT_DATABASE_URL: DIRECT }),
    ).toThrow(/LINGTAI_TEST_DIRECT_DATABASE_URL is not set/)
  })
})

/**
 * #169. The board's setup page writes the App into `config.yml` while the board
 * — and a daemon — are already running, so the file is read per call: the page
 * that has just written the App must not be answered *no GitHub App
 * configured* by its own next click.
 */
describe('the App is read from config.yml as it is now', () => {
  async function home(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'lingtai-home-'))
  }

  it('sees an App written to the file after this module was loaded', async () => {
    const dir = await home()
    const key = join(dir, 'app.pem')
    const env = { LINGTAI_HOME: dir }

    expect(hasGitHubApp(env)).toBe(false)

    await writeFile(key, 'not a real key')
    await writeFile(join(dir, 'config.yml'), `github:\n  app_id: 4242\n  app_private_key_path: ${key}\n`)

    expect(hasGitHubApp(env)).toBe(true)
    expect(githubApp(env)).toEqual({
      appId: '4242',
      privateKey: 'not a real key',
      keySource: key,
      source: join(dir, 'config.yml'),
    })
  })

  it('resolves a relative key path against the state directory', async () => {
    const dir = await home()
    await writeFile(join(dir, 'app.pem'), 'the key')
    await writeFile(join(dir, 'config.yml'), 'github:\n  app_id: "1"\n  app_private_key_path: app.pem\n')
    expect(githubApp({ LINGTAI_HOME: dir }).keySource).toBe(join(dir, 'app.pem'))
  })

  it("lets an exported App override the file's, every name of it", async () => {
    const dir = await home()
    await writeFile(join(dir, 'file.pem'), 'from-file')
    await writeFile(
      join(dir, 'config.yml'),
      `github:\n  app_id: "1"\n  app_private_key_path: ${join(dir, 'file.pem')}\n  webhook_secret: file-secret\n`,
    )
    const exported = { LINGTAI_HOME: dir, LINGTAI_GITHUB_APP_ID: '2', LINGTAI_GITHUB_APP_PRIVATE_KEY: 'from-env' }

    const app = githubApp(exported)
    expect(app).toMatchObject({ appId: '2', privateKey: 'from-env', source: 'environment' })
    // The file's secret is App 1's, and App 2 is the one answering.
    expect(githubWebhookSecret(exported)).toBeUndefined()
  })

  it('refuses an exported id with no key beside it, rather than borrowing the file’s', async () => {
    const dir = await home()
    await writeFile(join(dir, 'config.yml'), 'github:\n  app_id: "1"\n  app_private_key: from-file\n')
    expect(() => githubApp({ LINGTAI_HOME: dir, LINGTAI_GITHUB_APP_ID: '2' })).toThrow(/export its key/)
  })

  /** The setup page writes the secret while the board runs; the receiver must see it. */
  it('reads the webhook secret from the file as it is now', async () => {
    const dir = await home()
    expect(githubWebhookSecret({ LINGTAI_HOME: dir })).toBeUndefined()
    await writeFile(join(dir, 'config.yml'), 'github:\n  app_id: "222"\n  webhook_secret: from-setup\n')
    expect(githubWebhookSecret({ LINGTAI_HOME: dir })).toBe('from-setup')
  })

  it('names a file it cannot read, rather than calling the App unset', async () => {
    const dir = await home()
    await writeFile(join(dir, 'config.yml'), 'github: [unclosed\n')
    expect(hasGitHubApp({ LINGTAI_HOME: dir })).toBe(false)
    expect(() => githubApp({ LINGTAI_HOME: dir })).toThrow(/could not be parsed as YAML/)
  })

  it('names a file it cannot open, rather than reading it as no file', async () => {
    const dir = await home()
    await writeFile(join(dir, 'config.yml'), 'github:\n  app_id: "1"\n', { mode: 0o000 })
    // Root can open anything, so the claim is only checkable as another user.
    if (process.getuid?.() === 0) return
    expect(() => githubApp({ LINGTAI_HOME: dir })).toThrow(/could not be read/)
  })

  it("reads no machine's file for a test that names no home of its own", () => {
    expect(hasGitHubApp({})).toBe(false)
  })
})

/**
 * #186. `lingtai init` writes the URL it verified to `~/.lingtai/config.yml`,
 * and a URL written where nothing reads it is a choice that did nothing.
 */
describe("the machine file's database.url", () => {
  const URL_ = 'postgresql://me:secret@localhost:5432/lingtai'

  it('is read from config.yml under LINGTAI_HOME', async () => {
    const home = await mkdtemp(join(tmpdir(), 'lingtai-home-'))
    expect(machineDatabaseUrl({ LINGTAI_HOME: home })).toBeUndefined()
    await writeFile(join(home, 'config.yml'), `runtime:\n  agent: claude-code\ndatabase:\n  url: ${URL_}\n`)
    expect(machineDatabaseUrl({ LINGTAI_HOME: home })).toBe(URL_)
  })

  it('refuses a file that does not parse by its path, rather than calling the URL unset', async () => {
    const home = await mkdtemp(join(tmpdir(), 'lingtai-home-'))
    await writeFile(join(home, 'config.yml'), 'database: [unclosed\n')
    expect(() => machineDatabaseUrl({ LINGTAI_HOME: home })).toThrow(join(home, 'config.yml'))
  })

  it('is read for an environment handed in that names its home, and never for a test', async () => {
    const home = await mkdtemp(join(tmpdir(), 'lingtai-home-'))
    await writeFile(join(home, 'config.yml'), `database:\n  url: ${URL_}\n`)
    // `lingtai doctor` hands in a copy of its environment and is owed the file.
    expect(postgresUrl({ LINGTAI_HOME: home })).toBe(URL_)
    expect(directUrlIfSet({ LINGTAI_HOME: home })).toBe(URL_)
    // A test environment never reaches it.
    expect(() => postgresUrl({ LINGTAI_HOME: home, VITEST: 'true' })).toThrow(/LINGTAI_TEST_DATABASE_URL is not set/)
  })
})

/**
 * #213. *Is a log configured* and *what is the Postgres URL* are two questions,
 * and for as long as every log was Postgres one function answered both — the
 * first by whether the second threw. `apps/cli/src/entry.ts` asked it that way
 * three times, and a `catch` is invisible to the compiler, so the day #178's
 * file-backed store made the answers differ nothing would have said so.
 */
describe('whether a log is configured', () => {
  const URL_ = 'postgresql://u:p@db.example.com:5432/postgres'

  it('is a boolean, where asking for the URL is a refusal', () => {
    // The pair, on one environment: the same absence, answered twice.
    expect(() => postgresUrl({})).toThrow(/LINGTAI_DATABASE_URL is not set/)
    expect(logConfigured({})).toBe(false)
    expect(postgresUrlIfSet({})).toBeUndefined()

    expect(logConfigured({ LINGTAI_DATABASE_URL: URL_ })).toBe(true)
    expect(postgresUrlIfSet({ LINGTAI_DATABASE_URL: URL_ })).toBe(URL_)
    expect(postgresUrl({ LINGTAI_DATABASE_URL: URL_ })).toBe(URL_)
  })

  it('says no to an empty variable, as every other name here does', () => {
    expect(logConfigured({ LINGTAI_DATABASE_URL: '' })).toBe(false)
  })

  /**
   * Unchanged, and deliberately: `postgresUrl` never read the direct name, so a
   * machine with only that one had no log before this had a name either. The
   * remedies that say *unset LINGTAI_DATABASE_URL* still name the one variable
   * this turns on.
   */
  it('is not turned on by the direct URL alone', () => {
    expect(logConfigured({ LINGTAI_DIRECT_DATABASE_URL: URL_ })).toBe(false)
    // Which is the one asymmetry worth stating: the direct one does fall back
    // to the pooled name, and the pooled one has never fallen back to it.
    expect(directPostgresUrl({ LINGTAI_DATABASE_URL: URL_ })).toBe(URL_)
  })

  it("reads the test side for a test, and never crosses to the operator's", () => {
    const test = { LINGTAI_TEST: '1' }
    expect(logConfigured({ ...test, LINGTAI_TEST_DATABASE_URL: URL_ })).toBe(true)
    expect(logConfigured({ ...test, LINGTAI_DATABASE_URL: URL_ })).toBe(false)
  })

  it('reads the machine file the way postgresUrl does', async () => {
    const home = await mkdtemp(join(tmpdir(), 'lingtai-home-'))
    await writeFile(join(home, 'config.yml'), `database:\n  url: ${URL_}\n`)
    // The same rule `postgresUrl` follows, so the two cannot disagree about
    // whether this machine has a log.
    expect(logConfigured({ LINGTAI_HOME: home })).toBe(true)
    expect(postgresUrl({ LINGTAI_HOME: home })).toBe(URL_)
  })

  it('agrees with the URL wherever the URL answers at all', () => {
    for (const env of [{}, { LINGTAI_DATABASE_URL: URL_ }, { LINGTAI_DATABASE_URL: '' }, { LINGTAI_TEST: '1' }]) {
      let url: string | null = null
      try {
        url = postgresUrl(env)
      } catch {
        url = null
      }
      expect(logConfigured(env)).toBe(url !== null)
      expect(postgresUrlIfSet(env) ?? null).toBe(url)
    }
  })
})
