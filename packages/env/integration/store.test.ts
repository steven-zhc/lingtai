/**
 * Which store this machine runs, read from the one place it is written
 * ([0056](../../../doc/decisions-archive/0056-the-store-is-a-written-choice.md), #215).
 *
 * Every case here hands in an environment with a `LINGTAI_HOME` of its own, so
 * the file being read is the test's and never the operator's — and the four
 * answers are asserted as four, because three of them are refusals and a
 * refusal that nobody can tell apart from the others is a refusal that names
 * nothing.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SQLITE_LOG, type StoreChoice, describeStore, storeChoice } from '../src/index.ts'

const URL_ = 'postgresql://me:secret@db.example:5432/lingtai'

async function home(config?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lingtai-store-'))
  if (config !== undefined) await writeFile(join(dir, 'config.yml'), config)
  return dir
}

describe('the four answers', () => {
  it('refuses a machine that was never set up, and names the command that sets it up', async () => {
    const dir = await home()
    const choice = storeChoice({ LINGTAI_HOME: dir })
    expect(choice).toMatchObject({ because: 'nothing chosen' })
    expect(describeStore(choice)).toContain('lingtai init')

    // Written by #186, before the store was a value: a URL and no choice. It is
    // still *not set up* — the two states must not collapse into one (0016 §4)
    // — and the refusal says the URL is there, or it reads as a lie.
    const older = storeChoice({ LINGTAI_HOME: await home(`database:\n  url: ${URL_}\n`) })
    expect(older).toMatchObject({ because: 'nothing chosen' })
    expect(describeStore(older)).toContain('database.url')
    expect(describeStore(older)).toContain('lingtai init')
  })

  it("is SQLite where SQLite is written, under the machine's own directory", async () => {
    const dir = await home('database:\n  store: sqlite\n')
    expect(storeChoice({ LINGTAI_HOME: dir })).toEqual({
      store: 'sqlite',
      path: join(dir, SQLITE_LOG),
      where: 'config.yml',
      from: join(dir, 'config.yml'),
    })
  })

  it('is Postgres where Postgres is written with a URL', async () => {
    const dir = await home(`database:\n  store: postgres\n  url: ${URL_}\n`)
    expect(storeChoice({ LINGTAI_HOME: dir })).toMatchObject({ store: 'postgres', url: URL_, where: 'config.yml' })
  })

  it('refuses Postgres with no URL anywhere, saying where one is looked for', async () => {
    const dir = await home('database:\n  store: postgres\n')
    const choice = storeChoice({ LINGTAI_HOME: dir })
    expect(choice).toMatchObject({ because: 'no url' })
    const said = describeStore(choice)
    expect(said).toContain('LINGTAI_DATABASE_URL')
    expect(said).toContain('database.url')
    expect(said).toContain('nowhere else')
  })

  it('refuses SQLite beside a URL by quoting both, and never the password', async () => {
    const dir = await home(`database:\n  store: sqlite\n  url: ${URL_}\n`)
    const choice = storeChoice({ LINGTAI_HOME: dir })
    expect(choice).toMatchObject({ because: 'two keys' })
    const said = describeStore(choice)
    expect(said).toContain('database.store: sqlite')
    expect(said).toContain('database.url')
    expect(said).toContain('db.example')
    expect(said).not.toContain('secret')
  })

  it('refuses a store it has never heard of rather than picking one', async () => {
    const dir = await home('database:\n  store: mysql\n')
    expect(describeStore(storeChoice({ LINGTAI_HOME: dir }))).toContain('neither postgres nor sqlite')
  })
})

/**
 * **A refusal is data, never an exception** — the rule #213 settled one layer
 * down. `lingtai upgrade` and `lingtai uninstall` are the commands that repair
 * a broken install, and a `config.yml` truncated mid-write must not be what
 * stops them.
 */
describe('a file that cannot be read', () => {
  it('is a refusal naming the file, and nothing thrown', async () => {
    const dir = await home('database:\n  store: "postgres')
    let choice: StoreChoice | null = null
    expect(() => {
      choice = storeChoice({ LINGTAI_HOME: dir })
    }).not.toThrow()
    expect(choice).toMatchObject({ because: 'unreadable' })
    expect(describeStore(choice!)).toContain(join(dir, 'config.yml'))
  })

  it("is no file at all, answered without reading any machine's", () => {
    // An environment naming no home of its own reads nothing — which is what
    // lets a test assert this case at all.
    expect(storeChoice({})).toMatchObject({ because: 'nothing chosen' })
  })
})

/**
 * 0056 §3: an exported `LINGTAI_DATABASE_URL` decides and supplies the URL,
 * which is what makes CI, launchd and a container work with no file at all.
 */
describe('an exported variable', () => {
  it('wins over the file, and says that it did', async () => {
    const dir = await home('database:\n  store: sqlite\n')
    const choice = storeChoice({ LINGTAI_HOME: dir, LINGTAI_DATABASE_URL: URL_ })
    expect(choice).toMatchObject({ store: 'postgres', url: URL_, where: 'environment' })
    expect(describeStore(choice)).toContain('exported into this process')
    // And the password is not in the line somebody reads.
    expect(describeStore(choice)).not.toContain('secret')
  })

  it("is the test side for a test, so a suite is never answered by the operator's machine", async () => {
    const dir = await home('database:\n  store: sqlite\n')
    const test = { LINGTAI_TEST: '1', LINGTAI_HOME: dir }
    expect(storeChoice({ ...test, LINGTAI_DATABASE_URL: URL_ })).toMatchObject({ store: 'sqlite' })
    expect(storeChoice({ ...test, LINGTAI_TEST_DATABASE_URL: URL_ })).toMatchObject({ store: 'postgres', url: URL_ })
  })
})

/**
 * **A Postgres choice carries both its connections**, and the second one is
 * the reason this is part of the choice rather than a lookup beside it.
 *
 * `LISTEN`/`NOTIFY` needs a session-mode connection (0009), and the obvious
 * way to get one — `directPostgresUrl()`, asked when a waker is built — reads
 * this process's environment with its own fallback to `LINGTAI_DATABASE_URL`.
 * That is a different question from *which store does this machine run*, and
 * the two can answer differently. A log opened that way appends to one
 * database and registers its `LISTEN` on another, so every subscriber drains
 * once on connect and is never nudged again while the board goes on rendering
 * that one drain — silent, and the split-log failure 0056 exists to remove.
 */
describe('the session-mode connection that goes with a choice', () => {
  it('is the chosen URL itself, where nothing else was exported', async () => {
    const dir = await home(`database:\n  store: postgres\n  url: ${URL_}\n`)
    expect(storeChoice({ LINGTAI_HOME: dir })).toMatchObject({ url: URL_, directUrl: URL_ })
  })

  it("is the exported session-mode name where there is one, which is 0009's case", async () => {
    const dir = await home(`database:\n  store: postgres\n  url: ${URL_}\n`)
    const direct = 'postgresql://me:secret@db.example:5433/lingtai'
    expect(storeChoice({ LINGTAI_HOME: dir, LINGTAI_DIRECT_DATABASE_URL: direct })).toMatchObject({
      url: URL_,
      directUrl: direct,
    })
  })

  /**
   * **And a direct name on a *different* database decides nothing**, which is
   * what makes the case above a rule rather than a hope.
   *
   * 0009 is "two variables, **one database**", and a stale direct name left
   * exported after `lingtai init --database-url …@db.NEW…` rewrote
   * `config.yml` would otherwise answer for a machine that has been pointed
   * somewhere else. The store opens on NEW and the `LISTEN` registers on OLD, where
   * nothing is ever appended — every subscriber drains once at connect and is
   * never nudged again, `task_view` stops folding, the board renders stale
   * cards, and nothing errors. It is the split-log failure 0056 exists to
   * remove.
   */
  it('is not a direct name on another database, however this process came by it', async () => {
    const dir = await home(`database:\n  store: postgres\n  url: ${URL_}\n`)
    const elsewhere = 'postgresql://me:secret@db.elsewhere:5432/lingtai'
    expect(storeChoice({ LINGTAI_HOME: dir, LINGTAI_DIRECT_DATABASE_URL: elsewhere })).toMatchObject({
      url: URL_,
      directUrl: URL_,
    })

    // Nor the same host with another database on it — a second log is a second
    // log whichever half of the string names it.
    const otherDb = 'postgresql://me:secret@db.example:5432/other'
    expect(storeChoice({ LINGTAI_HOME: dir, LINGTAI_DIRECT_DATABASE_URL: otherDb })).toMatchObject({
      url: URL_,
      directUrl: URL_,
    })

    // And a string nothing can parse is not a match either: the waker falls
    // back to the store's own database rather than to a guess.
    expect(storeChoice({ LINGTAI_HOME: dir, LINGTAI_DIRECT_DATABASE_URL: 'not a url' })).toMatchObject({
      directUrl: URL_,
    })
  })

  /**
   * The same rule where the store came from an exported variable rather than
   * from the file — one function answers both, and a pair that disagrees there
   * is the same split.
   */
  it('holds for a store the environment named, not only one the file did', () => {
    const direct = 'postgresql://me:secret@db.example:5433/lingtai'
    expect(storeChoice({ LINGTAI_DATABASE_URL: URL_, LINGTAI_DIRECT_DATABASE_URL: direct })).toMatchObject({
      url: URL_,
      directUrl: direct,
    })

    expect(
      storeChoice({
        LINGTAI_DATABASE_URL: URL_,
        LINGTAI_DIRECT_DATABASE_URL: 'postgresql://me:secret@db.elsewhere:5432/lingtai',
      }),
    ).toMatchObject({ url: URL_, directUrl: URL_ })
  })
})
