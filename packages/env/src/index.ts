import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Config, ConfigProvider, Effect, Either, Option } from 'effect'
import { parse as parseYaml } from 'yaml'

/**
 * Where configuration values come from, for every package that needs one.
 *
 * **Two sources and no third**: `~/.lingtai/config.yml`, and the variables
 * exported into the process, the second overriding the first. There is no env
 * file. A checkout's `.env.local` used to be merged into `process.env` here at
 * import, which made every answer depend on the directory a process started in
 * — `pnpm lingtai` from the checkout and a launchd job started from `~` reached
 * opposite answers about the same machine, and neither could tell (0056 §4).
 *
 * Both sources are read through Effect's `Config`: one `ConfigProvider` per
 * source, and the names map onto each other mechanically — the file's
 * `github.app_id` is the environment's `LINGTAI_GITHUB_APP_ID`, `database.url`
 * is `LINGTAI_DATABASE_URL`, `board.port` is `LINGTAI_BOARD_PORT`. See
 * `environmentProvider` and `machineFile`.
 *
 * The file is read per call, so a value the board's setup page or `lingtai
 * init` writes there is seen by the next call in every process. A variable is
 * read from the environment the process was started with, so changing one is a
 * restart — the rule every other fact about a running daemon already follows.
 */
const here = dirname(fileURLToPath(import.meta.url))
/**
 * `packages/env/src` → the repository root. Bundled, `import.meta.url` is
 * `dist/lingtai.cjs`'s, and the root is one directory up (#183):
 * `apps/release/src/build.ts` defines `LINGTAI_BUNDLED`, and the source never does.
 */
declare const LINGTAI_BUNDLED: boolean | undefined
const root = resolve(here, typeof LINGTAI_BUNDLED === 'undefined' ? '../../..' : '..')

/**
 * Whether this process is a test run.
 *
 * Vitest sets `VITEST`; the explicit override exists for anything that runs the
 * suite by another name.
 */
function inTest(from: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(from['VITEST'] || from['LINGTAI_TEST'])
}

// ------------------------------------------------------------ the two sources --

/**
 * The environment as a `ConfigProvider`: `github.app_id` is looked up as
 * `LINGTAI_GITHUB_APP_ID`.
 *
 * Built from `from` rather than `ConfigProvider.fromEnv()`, which reads
 * `process.env` and nothing else — `lingtai doctor` and every test hand in an
 * environment of their own and are owed an answer about that one. An empty
 * value is no value, as `optional` has always said: `LINGTAI_GITHUB_APP_ID=`
 * exported blank must not win over a file that names one.
 */
export function environmentProvider(from: NodeJS.ProcessEnv = process.env): ConfigProvider.ConfigProvider {
  return exportedProvider(from).pipe(ConfigProvider.nested(PREFIX.slice(0, -1)), ConfigProvider.constantCase)
}

/**
 * The same environment, asked by its own names — `LINGTAI_DIRECT_DATABASE_URL`
 * as written. What `optional` reads, for the names that are variables only and
 * have no key in the file.
 */
function exportedProvider(from: NodeJS.ProcessEnv): ConfigProvider.ConfigProvider {
  const set = new Map<string, string>()
  for (const [name, value] of Object.entries(from)) if (value) set.set(name, value)
  return ConfigProvider.fromMap(set, { pathDelim: '_' })
}

/** `~/.lingtai/config.yml`, as it is on disk now — or why it could not be read. */
export interface MachineFile {
  /** The file asked, or null where this environment reads none (a test, below). */
  path: string | null
  /** What it parsed to; `{}` where there is no file. */
  provider: ConfigProvider.ConfigProvider
  /**
   * Why a file that exists could not be read — it would not parse, or it could
   * not be opened. **Never** *it does not exist*, which is an empty file.
   *
   * A file that cannot be opened is not *no file*: answered as `{}`, a
   * `config.yml` naming App 1850235 under another account's ownership read as
   * *no App here*, and the board offered to create a second one — which GitHub
   * hands its private key out for exactly once.
   */
  unreadable?: string
}

/**
 * Which `config.yml` this environment reads, or null where it reads none.
 *
 * An environment that names its own `LINGTAI_HOME` reads that one: it is how
 * `lingtai doctor` and a test are pointed at a home of their own. Otherwise
 * **a test reads no machine's file** — not this process's own environment
 * under vitest, and not one handed in by a test either — because the file on
 * the operator's machine is exactly the operator's log and App. Anything else
 * reads `stateDir()`'s.
 */
function machineFilePath(from: NodeJS.ProcessEnv): string | null {
  const ownHome = Boolean(from['LINGTAI_HOME'])
  if (!ownHome && (inTest(from) || inTest(process.env))) return null
  return join(stateDir(from), 'config.yml')
}

/**
 * Whether a read failed because nothing is there: no file, or a path through
 * something that is not a directory. Either is *no file*, never *unreadable*.
 */
export function absent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** A parsed YAML document as a `ConfigProvider`: `github.app_id` is `github: { app_id }`. */
export function yamlProvider(parsed: unknown): ConfigProvider.ConfigProvider {
  return ConfigProvider.fromJson(parsed !== null && typeof parsed === 'object' ? parsed : {})
}

/** The file, read and parsed now. Total: every failure is `unreadable`, never thrown. */
export function machineFile(from: NodeJS.ProcessEnv = process.env): MachineFile {
  const path = machineFilePath(from)
  if (path === null) return { path, provider: yamlProvider({}) }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if (absent(err)) return { path, provider: yamlProvider({}) }
    return { path, provider: yamlProvider({}), unreadable: `${path} could not be read: ${(err as Error).message}` }
  }
  try {
    return { path, provider: yamlProvider(parseYaml(text)) }
  } catch (err) {
    return {
      path,
      provider: yamlProvider({}),
      unreadable: `${path} could not be parsed as YAML: ${(err as Error).message}`,
    }
  }
}

/** One `Config` against one provider, as data rather than a thrown `ConfigError`. */
function readConfig<A>(config: Config.Config<A>, provider: ConfigProvider.ConfigProvider): Either.Either<A, string> {
  return Either.mapLeft(Effect.runSync(Effect.either(Effect.withConfigProvider(config, provider))), String)
}

/** A string at `path` in one provider, or undefined. A non-string there is no string. */
function stringAt(provider: ConfigProvider.ConfigProvider, ...path: [string, ...string[]]): string | undefined {
  const [name, ...outer] = [...path].reverse() as [string, ...string[]]
  let config: Config.Config<Option.Option<string>> = Config.option(Config.string(name))
  for (const section of outer) config = Config.nested(config, section)
  return Either.match(readConfig(config, provider), {
    onLeft: () => undefined,
    onRight: (value) => Option.getOrUndefined(Option.filter(value, (v) => v !== '')),
  })
}

/**
 * The Postgres connection a caller that must have Postgres may use, which is
 * never the operator's.
 *
 * Since #275 the suite as a whole no longer needs this: `storeChoice` defaults
 * a test run with no `LINGTAI_TEST_DATABASE_URL` to a SQLite file of its own
 * (below), and most of the integration half runs on that. What is left calling
 * `postgresUrl()`/`directPostgresUrl()` under `inTest` is the handful of files
 * on `@lingtai/event-store/test/postgres`'s list — the ones asserting Postgres
 * itself, `LISTEN`/`NOTIFY`, two clients racing — and this is a choke point for
 * exactly those: the alternative, teaching each of them to pick a URL, leaves
 * every one I did not audit still pointing at the real database.
 *
 * It **throws** when the test URL is missing rather than falling back. A silent
 * fallback is how the operator's board came to hold twenty-four cards from ten
 * throwaway `esctest*` projects and not one real one: the suite had been
 * writing to the live log for as long as it had existed, and nothing said so.
 *
 * Deleting that afterwards is not cheap either. A projection can be truncated
 * and replayed, so the cards come back; the only way to remove them is to
 * delete from an append-only log, which is a thing this system should never
 * make routine.
 */
/**
 * Which variable to read for a connection, given who is asking.
 *
 * Exported because two callers cannot go through `postgresUrl()`: Prisma's
 * config and the bootstrap script both have to work with *nothing* configured
 * — `contract emit` and `migration plan` are offline commands — so they read
 * the variable rather than demanding it. They still have to obey the same rule
 * about which variable, and this is that rule, written once.
 *
 *   LINGTAI_TEST=1 pnpm --filter @lingtai/event-store db:bootstrap
 *
 * is how the test database gets its schema.
 */
export function dbVar(name: 'DATABASE_URL' | 'DIRECT_DATABASE_URL', from: NodeJS.ProcessEnv = process.env): string {
  return inTest(from) ? `${PREFIX}TEST_${name}` : `${PREFIX}${name}`
}

/**
 * **Every name Lingtai reads for itself begins with this** (`#63`).
 *
 * Not tidiness. Since 0021 the agent's environment is `process.env` merged with
 * the project's own file, the file winning — so a project whose file is missing
 * a `DATABASE_URL` line got **Lingtai's own log** under a name its application
 * connects to without hesitating, and `required: [DATABASE_URL]` could not tell
 * that apart from a correct line because the merged data had a value either
 * way. A missing line and a right one gave the same answer.
 *
 * `LINGTAI_DATABASE_URL` is a name no managed application asks for, so the
 * missing line becomes an ordinary absent one, which `required` catches loudly
 * before anything is claimed.
 *
 * [0021](../../../doc/decisions-archive/0021-the-recipe-decides-the-environment.md)
 * decided to remove `RESERVED` — the denylist that stopped a recipe naming
 * Lingtai's own credentials — on the grounds that exposure is the operator's to
 * manage. That removal is `#60` and has not landed yet; this makes it safe to
 * land, because after the prefix there is no generic name left in the
 * conductor's environment worth reaching for. Structural, rather than
 * remembered.
 *
 * `TEST_` goes *after* the prefix: `LINGTAI_TEST_DATABASE_URL`, so the rule
 * "begins with `LINGTAI_`" has no exceptions and is therefore checkable — see
 * `unit/prefix.test.ts`, which reads this file.
 *
 * **A project's own file is not covered.** `DATABASE_URL` in
 * `nextloom-ai-admin.env` stays `DATABASE_URL`, because that is what admin's
 * application reads. This is only about the names Lingtai uses for itself.
 */
export const PREFIX = 'LINGTAI_'

/**
 * The old, unprefixed name, when it is set and the new one is not.
 *
 * Only consulted on the path that was going to fail anyway, so an operator with
 * a `DATABASE_URL` of their own for something else is never bothered. Without
 * it the message is "LINGTAI_DATABASE_URL is not set" about a machine where
 * `DATABASE_URL` is plainly set, which reads as a bug in Lingtai.
 *
 * **Delete this once no machine running Lingtai predates `#63`** — in practice,
 * once this operator's configuration and `~/.lingtai/env/lingtai.env` are
 * renamed, which the same change did. It is kept only for a machine that
 * upgrades later.
 */
function renamedFrom(name: string, from: NodeJS.ProcessEnv): string | null {
  const old = name.startsWith(`${PREFIX}TEST_`)
    ? `TEST_${name.slice(`${PREFIX}TEST_`.length)}`
    : name.slice(PREFIX.length)
  return from[old] ? old : null
}

function testUrl(name: string, from: NodeJS.ProcessEnv = process.env): string {
  const full = `${PREFIX}TEST_${name}`
  const value = optional(full, from)
  if (!value) {
    const was = renamedFrom(full, from)
    throw new Error(
      `${full} is not set, and this caller needs Postgres. ` +
        (was ? `${was} is set — it was renamed to ${full} (#63). ` : '') +
        'Since #275 the suite runs on a SQLite file of its own without it — only the files on ' +
        "@lingtai/event-store/test/postgres's list, which assert Postgres itself, need " +
        `${full} and ${PREFIX}TEST_DIRECT_DATABASE_URL at a database of their own, exported into the shell that runs the suite.`,
    )
  }
  return value
}

function required(name: string, from: NodeJS.ProcessEnv = process.env): string {
  const v = from[name]
  if (!v) {
    const was = renamedFrom(name, from)
    throw new Error(
      `${name} is not set. ` +
        (was
          ? `${was} is set — it was renamed to ${name} (#63), so that a project's own ` +
            `${was} can never be confused with Lingtai's. Rename the line.`
          : name.includes('DATABASE_URL')
            ? 'lingtai init asks for one and writes it to ~/.lingtai/config.yml as database.url; exporting it also works.'
            : 'Write it in ~/.lingtai/config.yml or export it, and restart.'),
    )
  }
  return v
}

/**
 * `database.url` in `~/.lingtai/config.yml` — where `lingtai init` writes the
 * one it was given and verified (#186) — or undefined where the file names none.
 *
 * **Behind the environment, never in front of it**: a set
 * `LINGTAI_DATABASE_URL` wins, as a variable beats the file everywhere else
 * here. And **never for a test** — `postgresUrl` and `directUrlIfSet` do not ask
 * this while `inTest`, because a file on the operator's machine is exactly the
 * operator's log, and `testUrl` exists to refuse that.
 *
 * One URL, not two: 1.0's store has no pooled/direct split (doc/design/1.0.md),
 * so this stands in for both names. A file that cannot be read is refused by
 * name rather than read as no URL, which would say *not set* about a machine
 * where somebody plainly set one.
 */
export function machineDatabaseUrl(from: NodeJS.ProcessEnv = process.env): string | undefined {
  const machine = machineDatabase(from)
  if (machine.unreadable !== undefined) throw new Error(machine.unreadable)
  return machine.url
}

interface MachineDatabase {
  /** `database.url`, where the file has one. */
  url?: string
  /** Why the file could not be read at all — never *it names no URL*. */
  unreadable?: string
}

/**
 * What the file says, as data: a URL, nothing, or a file that could not be read
 * at all — **three answers and not two**, so that a caller which must not refuse
 * does not have to catch one (#213).
 *
 * `machineDatabaseUrl` is this plus the refusal, for the callers that are about
 * to connect; `machineUrlIfReadable` is this without it, for the two readers
 * that only look.
 */
function machineDatabase(from: NodeJS.ProcessEnv): MachineDatabase {
  const file = machineFile(from)
  if (file.unreadable !== undefined) {
    return { unreadable: `${file.unreadable} — so its database.url could not be read` }
  }
  const url = stringAt(file.provider, 'database', 'url')
  return url === undefined ? {} : { url }
}

/** The machine file's URL, never in a test. */
function machineUrl(from: NodeJS.ProcessEnv): string | undefined {
  return inTest(from) ? undefined : machineDatabaseUrl(from)
}

/**
 * The same, **total**: a `config.yml` that cannot be read is undefined here
 * rather than a thrown error.
 *
 * The refusal is not lost, it is moved to the caller it belongs to — the one
 * opening a connection, which is where naming the broken file is a remedy
 * (#186). `postgresUrlIfSet`, `directUrlIfSet` and so `logConfigured` are
 * questions *about* configuration, and a question about configuration that
 * throws is the same defect #213 is about, one layer down: `lingtai upgrade`
 * and `lingtai uninstall` are the two commands that repair a broken install,
 * and a half-written `config.yml` must not be what stops them.
 */
function machineUrlIfReadable(from: NodeJS.ProcessEnv): string | undefined {
  return inTest(from) ? undefined : machineDatabase(from).url
}

// --------------------------------------------------------------- the store --

/** The two stores a machine can run (0055). */
export type Store = 'postgres' | 'sqlite'

/** Where a choice was read: this process's real environment, or the machine file. */
export type StoreSource = 'environment' | 'config.yml'

export type StoreChosen =
  | {
      store: 'postgres'
      url: string
      /**
       * The session-mode connection **to the database `url` names**, for the
       * one thing that cannot go through a transaction pooler: `LISTEN`/
       * `NOTIFY` (0009).
       *
       * It is part of the choice rather than a second lookup because
       * `directPostgresUrl()` answers a different question — *what connection
       * string can this process find* — and its answer need not be the same
       * database. It falls back to `LINGTAI_DATABASE_URL`, so a machine whose
       * `config.yml` says `url: A` beside an exported `LINGTAI_DATABASE_URL=B`
       * would open the store on B and could register the `LISTEN` elsewhere:
       * every append lands in one database, no notification from it ever
       * reaches a session on the other, and each subscriber drains once on
       * connect and is never nudged again. Silent, and exactly the split-log
       * failure 0056 exists to remove. Here there is no such fallback, and the
       * session-mode name is taken only where it names **the same database as
       * `url`** — so the waker is on the store's own database, and never on a
       * second one.
       *
       * So it is `url` itself unless this process names a session-mode URL on
       * that database — the one legitimate second string, because on Supabase
       * the pooled and direct strings genuinely differ in their port (0009). A
       * stale one, left over from a database this machine has been pointed away
       * from, names another and is ignored. A `config.yml` carries one URL and
       * it stands in for both names, which is what `machineDatabaseUrl` already
       * says.
       */
      directUrl: string
      where: StoreSource
      from: string
    }
  | { store: 'sqlite'; path: string; where: StoreSource; from: string }

/**
 * Which refusal it is.
 *
 * A caller that only reports prints `refused` and needs none of this. `lingtai
 * init` is the one caller that *repairs* them, and it treats them differently:
 * nothing chosen is the question it is about to ask anyway, while the other two
 * are a file it is fixing and says so first.
 */
export type StoreUnchosen = 'nothing chosen' | 'no url' | 'two keys' | 'unreadable'

export interface StoreRefused {
  refused: string
  because: StoreUnchosen
}

export type StoreChoice = StoreChosen | StoreRefused

/** The log's file when a machine chose SQLite, under `stateDir()` (doc/design/1.0.md). */
export const SQLITE_LOG = 'lingtai.db'

/**
 * **The one sentence anything operator-facing says about a SQLite machine.**
 *
 * A constant because the last attempt to change what this claim says had to
 * edit six copies of it — `lingtai init`'s amber line, a `doctor` row's detail,
 * the README, `.env.example`, `doc/operating.md` and an ADR — and the review
 * that refused it named the six as the reason it could not be read (#215). Six
 * copies is also six chances for one of them to go on saying the old thing
 * after #179 lands.
 *
 * The documents point here rather than restating it. A caller may add its own
 * remedy after it — which command *it* offers is its own business — and must
 * not rewrite the claim.
 *
 * **#179 rewrote it, because #179 is what made the old sentence false**, and
 * the two readers moved in the same edit — which is the whole argument for a
 * constant. They are both under `apps/cli/`: `lingtai init`'s line about the
 * store, which printed this in amber and returned 1 without serving a board,
 * and a `doctor` row, which rendered the machine `warn`. A store opens from a
 * written `sqlite` now
 * ([0056](../../../doc/decisions-archive/0056-the-store-is-a-written-choice.md)) —
 * `packages/daemon/integration/the-written-choice.test.ts` appends, folds
 * `task_view`, renders the board's cards and beats the beacon on one, in a
 * process where opening a socket throws — so `init` goes on to the board and
 * the row is `ok`.
 *
 * What is left to say about such a machine is what is *true* of it and not
 * obvious: the log is that one file, and no second reader can reach it.
 */
export const SQLITE_MACHINE =
  'SQLite is the whole log, in one file under ~/.lingtai — no server, and no second machine: nothing outside this one ' +
  'can read it, and switching stores later is a new log rather than the same one somewhere else (0055 §3)'

/**
 * The session-mode connection that goes with a chosen Postgres URL — see
 * `StoreChosen.directUrl` for why it is part of the choice and not a second
 * lookup.
 *
 * The direct name and nothing else: `directUrlIfSet`'s fallback to
 * `LINGTAI_DATABASE_URL` is the one that could name a different database, and
 * here the fallback is the chosen `url`. **And only where it names the same
 * database as `url`**: a stale `LINGTAI_DIRECT_DATABASE_URL` left exported
 * after `config.yml` was pointed somewhere else would otherwise register the
 * `LISTEN` on the old database — where nothing is ever appended, so no
 * notification arrives, and nothing errors (#157, 0009).
 */
function sessionUrlFor(url: string, from: NodeJS.ProcessEnv): string {
  const named = optional(dbVar('DIRECT_DATABASE_URL', from), from)
  return named !== undefined && sameDatabase(named, url) ? named : url
}

/**
 * Whether two connection strings name **one database** — 0009's whole demand of
 * the pair ("Two variables, one database"), and the same relation `lingtai
 * doctor`'s environment row already fails a machine for breaking.
 *
 * Host and database, never the port: the port is exactly what the two
 * legitimately differ in — 6543 pooled beside 5432 session, "the same host and
 * credentials on port 5432 with the `pgbouncer` flag dropped" (0009). Nor the
 * credentials, for the reason `describeUrl` does not print them.
 *
 * A string that will not parse is **not** a match: the waker then falls back to
 * `url`, which is the store's own database by construction. Guessing the other
 * way is the split this exists to make impossible.
 */
function sameDatabase(a: string, b: string): boolean {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.hostname === y.hostname && x.pathname === y.pathname
  } catch {
    return false
  }
}

function notSetUp(name: string, path: string | null, url?: string): StoreRefused {
  return {
    because: 'nothing chosen',
    refused:
      'nothing on this machine says which store it runs' +
      (path === null ? '' : `: ${path} names no database.store`) +
      (url === undefined
        ? ''
        : ', though it names a database.url — which store that URL is for was never written down') +
      ` — lingtai init asks and writes the choice. An exported ${name} also decides, and supplies the URL with it.`,
  }
}

/**
 * **Which store this machine runs is a value somebody wrote down**, and this is
 * the one function that reads it
 * ([0056](../../../doc/decisions-archive/0056-the-store-is-a-written-choice.md)).
 *
 * Nothing infers it from a variable being unset. *Unset* is not a fact a
 * process can establish: the URL `postgresUrl()` reads used to have a third
 * source, a `.env.local` found by walking up from this file, so `pnpm lingtai`
 * from the checkout and a launchd job started from `~` reached opposite answers
 * about whether anything was there, and neither could tell.
 * Four processes, four stores, and every append into the empty one reported as
 * success — which, for a system whose first rule is that the log settles it, is
 * the worst failure available.
 *
 * So there are **four answers and three of them are refusals**, returned as
 * data rather than thrown: `lingtai upgrade` and `lingtai uninstall` are the
 * commands that repair a broken install, and a half-written `config.yml` must
 * not be what stops them (#213).
 *
 * | `config.yml` | this says |
 * |---|---|
 * | no `database.store` | refused — this machine has not been set up, `lingtai init` |
 * | `store: sqlite` | SQLite, under `stateDir()` |
 * | `store: postgres` with a URL | Postgres |
 * | `store: postgres`, no URL anywhere | refused, saying where a URL is looked for |
 * | `store: sqlite` beside a `url` | refused, quoting both |
 *
 * An exported `LINGTAI_DATABASE_URL` wins and supplies the URL, which is what
 * makes CI, launchd and a container work with no file at all (0056 §3).
 *
 * **What opens the store it names is `chosenStore()` below** (#179): the three
 * factories — the log, the projections and the beacon — each ask that, and no
 * other file in the repository reads a variable or a file to decide.
 */
export function storeChoice(from: NodeJS.ProcessEnv = process.env): StoreChoice {
  // The test side for a test, as every other read here does — so a suite that
  // exists to assert Postgres can never be answered by the operator's machine.
  const name = dbVar('DATABASE_URL', from)
  const url = optional(name, from)
  if (url !== undefined) {
    return {
      store: 'postgres',
      url,
      directUrl: sessionUrlFor(url, from),
      where: 'environment',
      from: `${name}, exported into this process`,
    }
  }

  const file = machineFile(from)
  const path = file.path
  if (path === null) {
    // **The test side, since #275.** `machineFile` answers null here in the
    // two cases that matter: this process's own environment under `inTest`,
    // and a test's hand-built `from` naming no `LINGTAI_HOME` of its own —
    // never for a `from` that names one, which is a machine file a test is
    // simulating on purpose (see `packages/env/integration/store.test.ts`'s
    // "four answers") and goes on being read below as it always was.
    //
    // A test run that named no `LINGTAI_TEST_DATABASE_URL` used to refuse here
    // unconditionally, which is right for the operator's machine and wrong for
    // the suite: nothing here needs Postgres to run, and demanding a second
    // database nobody wants to keep was the whole of this ticket (#275).
    // `LINGTAI_TEST_SQLITE_PATH` is set by
    // `packages/event-store/test-support/teardown.ts`'s `setup()`, to a file
    // under a directory made for this run alone — never `stateDir()`, which on
    // a machine that chose SQLite is the operator's own log (0055 §2, 0056 §4;
    // see 0074).
    if (inTest(from)) {
      const sqlitePath = optional(`${PREFIX}TEST_SQLITE_PATH`, from)
      if (sqlitePath !== undefined) {
        return {
          store: 'sqlite',
          path: sqlitePath,
          where: 'environment',
          from: `${PREFIX}TEST_SQLITE_PATH, exported into this process`,
        }
      }
      return notSetUp(`${name} or ${PREFIX}TEST_SQLITE_PATH`, null)
    }
    return notSetUp(name, null)
  }
  if (file.unreadable !== undefined) {
    return {
      because: 'unreadable',
      refused:
        `${file.unreadable} — so which store this machine runs went unanswered. ` +
        'Fix that file, or lingtai init writes it again',
    }
  }
  // No file is no choice, and it is the same sentence: a machine that has not
  // been set up is not a machine that chose SQLite.
  const written = stringAt(file.provider, 'database', 'url')
  const store = stringAt(file.provider, 'database', 'store')
  if (store === undefined) return notSetUp(name, path, written)
  if (store !== 'postgres' && store !== 'sqlite') {
    return {
      because: 'nothing chosen',
      refused:
        `${path} sets database.store to ${JSON.stringify(store)}, which is neither postgres nor sqlite, so which ` +
        'store this machine runs went unanswered — lingtai init writes one of the two',
    }
  }
  if (store === 'sqlite') {
    if (written !== undefined) {
      return {
        because: 'two keys',
        refused:
          `${path} says database.store: sqlite and names database.url: ${redactUrl(written)} — two keys disagreeing ` +
          'about which store this machine runs, and neither is guessed at. lingtai init writes the one you choose and ' +
          'removes the other',
      }
    }
    return { store: 'sqlite', path: join(stateDir(from), SQLITE_LOG), where: 'config.yml', from: path }
  }
  if (written === undefined) {
    return {
      because: 'no url',
      refused:
        `${path} says database.store: postgres and names no database.url — a URL is looked for in ${name} exported ` +
        `into this process, then in database.url in that file, and nowhere else. lingtai init asks for one and writes it`,
    }
  }
  return {
    store: 'postgres',
    url: written,
    directUrl: sessionUrlFor(written, from),
    where: 'config.yml',
    from: `${path} database.url`,
  }
}

/**
 * The choice, or the refusal **thrown by name** — what a factory that is about
 * to open a store calls (#179).
 *
 * `storeChoice` is total because `lingtai upgrade`, `lingtai uninstall` and
 * `lingtai doctor` report on a machine rather than open it. This is the other
 * face, for the three factories that cannot carry on without an answer: the
 * log (`@lingtai/event-store`), the projections (`@lingtai/projector`) and the
 * beacon (`@lingtai/daemon`).
 *
 * **It throws where nothing was written, and never defaults.** A machine that
 * has not been set up is not a machine that chose SQLite
 * ([0056](../../../doc/decisions-archive/0056-the-store-is-a-written-choice.md) §2),
 * and the refusal it throws names `lingtai init`. That is the whole of the
 * blocker that refused #179's ninth pass: under a rule that read *absence* as
 * *SQLite*, a process that could not see the checkout's `.env.local` opened a
 * second, empty log and reported every append into it as success.
 *
 * **At first use and not at import.** `eventStore` and `log` are deferred
 * (`@lingtai/event-store/choose`), so `lingtai version`, `upgrade`, `rollback`,
 * `uninstall` and `init` load the modules that reach a store and are refused by
 * nothing — the refusal arrives at the first append, read or beat, which is the
 * first moment a process needs the answer.
 */
export function chosenStore(from: NodeJS.ProcessEnv = process.env): StoreChosen {
  const choice = storeChoice(from)
  if ('refused' in choice) throw new Error(choice.refused)
  return choice
}

/**
 * The choice as a line somebody reads — **derived from the choice, never
 * composed beside it**.
 *
 * `lingtai init` confirms what it wrote with this, and `lingtai doctor` reports
 * with it, so the screen at the end of setup and the answer a later command
 * gets cannot drift apart. They did: the last attempt printed *SQLite* from the
 * answer that was typed while the file still held a `database.url` that went on
 * selecting Postgres (#215).
 */
export function describeStore(choice: StoreChoice): string {
  if ('refused' in choice) return choice.refused
  return choice.store === 'postgres'
    ? `Postgres, ${redactUrl(choice.url)} ← ${choice.from}`
    : `SQLite, ${choice.path} ← ${choice.from}`
}

/**
 * A URL fit to print: the password is never shown.
 *
 * Here because both sides of the choice quote URLs — `lingtai init`'s
 * confirmation, and the refusal that quotes a `database.url` beside a
 * `store: sqlite` — and a second copy of this is a second chance to print a
 * password.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = '***'
    return parsed.toString()
  } catch {
    return '(a URL that does not parse)'
  }
}

/**
 * The board's port (#187). `17820`, and no configuration is required to get it.
 *
 * **Here rather than in `apps/board/package.json`**, which held it as
 * `next dev -p 3200` until now: somebody who installed Lingtai has no
 * `package.json` to edit, and the CLI, the service files and the URL in a
 * notification each need the same number. One constant, read by all of them.
 *
 * **Not higher.** macOS hands out `49152–65535` as ephemeral ports and Linux
 * `32768–60999`, so a default in either range is one the kernel also gives to
 * other processes — it would collide at random, intermittently, and mostly not
 * at all, which is harder to find than a fixed clash. `10000–32767` is the band.
 */
export const BOARD_PORT = 17820

/**
 * Reserved, and **bound by nothing**.
 *
 * The daemon listens on no port at all: everything reaches it through the log
 * (0014, 0022), its hook socket is a unix socket path and its liveness beacon
 * is a file (#46). So there is one listener here, and `17821` is kept beside it
 * for the second one — the board's GitHub webhook receiver moving to the
 * daemon, if it ever does (doc/design/installing.md).
 *
 * It is reserved rather than bound because **a port with no use is a port the
 * next reader has to explain**, and the two ways that ends — inventing a
 * purpose for it, or deleting it — are both worse than a number written down.
 * `packages/env/integration/board-port.test.ts` reads every package's `src` and fails
 * if any mention of the number **or of this name** is anything but prose — an
 * import of `RESERVED_PORT` included, since importing it is the only way to
 * bind the port without writing the digits.
 */
export const RESERVED_PORT = 17821

/**
 * `board.port`, or undefined where nothing names one — `LINGTAI_BOARD_PORT`
 * exported, over `board.port` in `~/.lingtai/config.yml`.
 *
 * The file need not exist. A value that is not a port number is refused by name
 * rather than ignored, which would serve the board on 17820 and say nothing
 * about the number somebody plainly wrote down.
 */
export function machineBoardPort(from: NodeJS.ProcessEnv = process.env): number | undefined {
  const port = Config.option(Config.nested(Config.port('port'), 'board'))
  const exported = readConfig(port, environmentProvider(from))
  if (Either.isLeft(exported)) {
    throw new Error(
      `${PREFIX}BOARD_PORT is not a port number, so no port was read: ${exported.left} — ` +
        `unset it to have the default, ${BOARD_PORT}`,
    )
  }
  if (Option.isSome(exported.right)) return exported.right.value
  const file = machineFile(from)
  if (file.unreadable !== undefined) throw new Error(`${file.unreadable} — so its board.port could not be read`)
  const written = readConfig(port, file.provider)
  if (Either.isLeft(written)) {
    // Not "17820 is the default": nothing fell back to it, and a sentence that
    // named the default beside the refusal read as though the value had been
    // ignored and the board served on 17820 anyway.
    throw new Error(
      `${file.path} sets board.port to something that is not a port number, so no port was read: ${written.left} — ` +
        `take that line out to have the default, ${BOARD_PORT}`,
    )
  }
  return Option.getOrUndefined(written.right)
}

/** The port the board is served on and linked to: the file's, else `BOARD_PORT`. */
export function boardPort(from: NodeJS.ProcessEnv = process.env): number {
  return machineBoardPort(from) ?? BOARD_PORT
}

/** Where the board answers, for a link somebody clicks. Loopback: 0008 gave it no authentication. */
export function boardUrl(from: NodeJS.ProcessEnv = process.env): string {
  return `http://127.0.0.1:${boardPort(from)}`
}

/**
 * **Whether a log is configured at all** — and never *is Postgres configured*,
 * which is the question next door (#213).
 *
 * `databaseUrl()` was read as this one three times in `apps/cli/src/entry.ts`,
 * written `try { databaseUrl() } catch { return false }`. While every log is
 * Postgres the two sentences have the same answer, so the conflation reads as
 * prose and not as a type error: the answer is a thrown exception caught by a
 * one-line `catch`, which goes on compiling and starts lying the day a log
 * needs no URL. #178 landed a store that is a file, so the two stopped having
 * to be the same claim — nothing chooses between them yet, and that is #179.
 *
 * So: a boolean, **read rather than caught**. The shape matters as much as the
 * name — a `try`/`catch` around a getter is what made this invisible for five
 * passes of #179. Where a log stops having to be Postgres, this body changes
 * and its callers do not: one place decides, and no caller decides again by
 * catching.
 *
 * It is still exactly what `postgresUrl()` reads, and **since #179 that is no
 * longer the same set of machines as *has a log*.** A machine that wrote
 * `store: sqlite` runs one, in a file, and this answers false about it; so does
 * a machine that carries a `database.url` and no `database.store`, which 0056
 * calls not set up and must not collapse into *chose SQLite* (0056 §2).
 *
 * That is left standing deliberately and it is not this function's decision to
 * make, and [#214](https://github.com/steven-zhc/lingtai/issues/214) answered
 * it where it belonged — in the commands. `lingtai uninstall` and `lingtai
 * upgrade` no longer ask this: `logWhere` on their `World` says **where the log
 * is** (`apps/cli/src/world.ts`'s `logLocation`), because on a machine that
 * wrote `store: sqlite` the answer here is `false` about a log that exists, is
 * a file under `~/.lingtai`, and is inside what an uninstall removes.
 *
 * **One caller is left and it is the right one.** `logLocation` asks this where
 * `storeChoice` *refuses* — a machine that named a `database.url` and wrote no
 * `database.store`, which 0056 §2 calls not set up — and asks it for exactly
 * what it says: **is there a log somewhere else**, which is a different
 * question from whether a `lingtai.db` is sitting under `stateDir()`. That one
 * is answered by looking, on every machine and not only under a refusal,
 * because a chosen Postgres is no more a promise that no file is there than a
 * refusal is: an operator who exported `LINGTAI_DATABASE_URL` over a machine
 * that had been recording into a file is both at once, and an uninstall has to
 * say both.
 *
 * **Total.** It answers on every machine, including one whose `config.yml` was
 * truncated mid-write: `false`, because nothing here names a log, while
 * `postgresUrl()` refuses by that file's path and `lingtai doctor` fails the
 * environment row on it. A boolean that can throw would be the `catch` back in
 * a different shape, and it would land on the two commands — `upgrade` and
 * `uninstall` — that exist to repair a broken install.
 */
export function logConfigured(from: NodeJS.ProcessEnv = process.env): boolean {
  return postgresUrlIfSet(from) !== undefined
}

/**
 * The pooled Postgres URL where one is configured; undefined where none is.
 *
 * Reads, and never refuses — **including a `~/.lingtai/config.yml` it cannot
 * parse**, which is undefined here and a refusal in `postgresUrl()`. `lingtai
 * doctor` wants this face too: it reports on an environment rather than
 * demanding one, and reports the unreadable file as its own failing row.
 *
 * `postgresUrl()` is this plus the refusal and `logConfigured()` is this plus
 * `!== undefined`, so *is there one* and *what is it* are one read and cannot
 * drift apart: wherever this is undefined, `postgresUrl()` refuses.
 */
export function postgresUrlIfSet(from: NodeJS.ProcessEnv = process.env): string | undefined {
  return optional(dbVar('DATABASE_URL', from), from) ?? machineUrlIfReadable(from)
}

/**
 * Pooled. Ordinary reads and writes, **against Postgres** — which is not the
 * same claim as *the log*, however long the two have coincided. A caller that
 * opens a `pg` connection wants this one; a caller deciding whether anything is
 * configured wants `logConfigured()`.
 */
export function postgresUrl(from: NodeJS.ProcessEnv = process.env): string {
  return (
    postgresUrlIfSet(from) ??
    // `machineUrl` again, and not for the value: the reader above is silent
    // about a `config.yml` it could not parse, and this caller is about to
    // connect — so the file is named here (#186) rather than reported as *not
    // set* on a machine where somebody plainly set one.
    machineUrl(from) ??
    (inTest(from) ? testUrl('DATABASE_URL', from) : required(`${PREFIX}DATABASE_URL`, from))
  )
}

/**
 * Session mode, against the same database.
 *
 * Migrations and `LISTEN/NOTIFY` both need a connection that is not handed to
 * someone else between statements. No lock does: every lock is a file
 * (`./lock.ts`, 0052). Through a
 * transaction pooler each of those fails **silently** — a cross-connection
 * NOTIFY simply never arrives, which would leave the system looking merely slow
 * rather than broken. Measured against Supabase's pooler on 2026-08-31; see
 * doc/decisions-archive/0009-two-connections.md.
 *
 * On a plain Postgres this may be the same string as `postgresUrl()`, and then
 * it need not be written at all: see `directUrlIfSet`. Neither set still
 * refuses, by the direct name.
 *
 * **It is about pooling and never about whether a log exists** (#213), which is
 * why the separation next door leaves its meaning exactly as it was and changes
 * only the word that said *database* where it meant *Postgres*. Nothing asks
 * this one whether anything is configured; `logConfigured()` is that question.
 */
export function directPostgresUrl(from: NodeJS.ProcessEnv = process.env): string {
  return (
    directUrlIfSet(from) ??
    // As `postgresUrl`: the reader is silent about a `config.yml` it could not
    // parse, and a caller that is about to connect is told which file it is.
    machineUrl(from) ??
    (inTest(from) ? testUrl('DIRECT_DATABASE_URL', from) : required(`${PREFIX}DIRECT_DATABASE_URL`, from))
  )
}

/**
 * The direct URL, or the pooled one standing in for it when the direct one is
 * absent (#176). Undefined when neither is set.
 *
 * Two URLs are Supabase's artifact rather than the architecture's — 0009: "On a
 * plain Postgres the two may be identical" — so a plain install writes one.
 * The fallback **only fills a gap**: a set direct URL always wins, because on
 * Supabase the two genuinely differ, and the pooled one there is exactly the
 * connection that breaks `LISTEN/NOTIFY` silently. `lingtai doctor`'s session
 * mode check is what catches a pooled URL standing in where it cannot.
 *
 * **The `TEST_` pair falls back the same way, and only within itself.** What
 * `testUrl` refuses is the operator's log; `LINGTAI_TEST_DATABASE_URL` standing
 * in for `LINGTAI_TEST_DIRECT_DATABASE_URL` is still the test database, so the
 * fallback cannot cross that line — `dbVar` picks both names from the same side.
 * `test-support/teardown.ts` already read the pair this way.
 *
 * Exported for the callers that must work with nothing configured (Prisma's
 * config, the bootstrap script), which read rather than demand.
 */
export function directUrlIfSet(from: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    optional(dbVar('DIRECT_DATABASE_URL', from), from) ??
    optional(dbVar('DATABASE_URL', from), from) ??
    // Total, as `postgresUrlIfSet` is: `lingtai doctor` reads this one to
    // report on an environment, and must not be the command a broken
    // `config.yml` stops.
    machineUrlIfReadable(from)
  )
}

/** Set, or undefined. For values whose absence is a legitimate state. Empty is unset. */
export function optional(name: string, from: NodeJS.ProcessEnv = process.env): string | undefined {
  return stringAt(exportedProvider(from), name)
}

/**
 * Where Lingtai keeps what it owns on this machine — clones, worktrees, the
 * per-project env files, the hook sockets, and `config.yml`.
 *
 * Here rather than beside the worktrees because it is not about worktrees: it
 * is a fact about the machine, which is what this package is for, and three
 * packages need it without needing each other. There were two copies before
 * (`conductor/worktree.ts` and `daemon/reconcile.ts`), differing in how they
 * fell back when `HOME` was unset.
 */
export function stateDir(from: NodeJS.ProcessEnv = process.env): string {
  return from['LINGTAI_HOME'] ?? join(from['HOME'] ?? homedir(), '.lingtai')
}

/**
 * Where a locker that was not handed a `dir` of its own takes its files (#273).
 *
 * **An environment that names its own `LINGTAI_HOME` reads that one**, exactly
 * as `machineFilePath` does: `join(stateDir(from), 'locks')`, so a test that
 * already redirects `LINGTAI_HOME` — `doctor.test.ts`, `doctor-recipe.test.ts`,
 * the children `world.test.ts` spawns — keeps locking inside the directory it
 * redirected everything else to, and needs no second variable.
 *
 * **Otherwise, under test, `LINGTAI_TEST_LOCK_DIR`** — a directory
 * `test-support/teardown.ts`'s `setup()` makes fresh for the run, never a fixed
 * name under `tmpdir()`, which two worktrees running the suite at once would
 * share. Unset there, this **throws** rather than falling back: that fallback
 * is exactly how the integration suite came to leave 4567 files in the
 * operator's own `~/.lingtai/locks/` (#273) — a locker that could not tell it
 * was under test from one that could not find its directory.
 *
 * Outside a test, `join(stateDir(from), 'locks')`, as it always was.
 */
export function lockDir(from: NodeJS.ProcessEnv = process.env): string {
  if (from['LINGTAI_HOME']) return join(stateDir(from), 'locks')
  if (inTest(from)) {
    const dir = from['LINGTAI_TEST_LOCK_DIR']
    if (!dir) {
      throw new Error(
        'LINGTAI_TEST_LOCK_DIR is not set, and this process is a test run — the integration suite’s ' +
          'globalSetup (test-support/teardown.ts) makes one fresh per run; a lock taken without it would land in ' +
          'the operator’s own ~/.lingtai/locks (#273)',
      )
    }
    return dir
  }
  return join(stateDir(from), 'locks')
}

/**
 * A path from configuration, made absolute.
 *
 * `~` is expanded, because configuration is exactly where someone writes it and
 * nothing else expands it there: a shell does not touch a YAML file, and
 * `path.resolve` would produce a directory *named* `~`.
 *
 * A relative path is relative to `against` — the repository root by default,
 * not whichever directory a command happened to start in. `config.yml`'s own
 * paths pass `stateDir()`, because bundled, the root is under `versions/` and
 * moves with every upgrade (#183).
 */
export function resolvePath(path: string, against: string = root): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2))
  return isAbsolute(path) ? path : resolve(against, path)
}

/**
 * The checkout Lingtai is running from — where `prompts/` and the hook binary
 * live.
 *
 * Already the anchor `resolvePath` uses; exported because it is also read by
 * something other than a command. `#104` shows the next attempt's prompt on the
 * board before it is sent, and the template is `prompts/ticket.md` at this root
 * — the same file `conduct.ts` reads to run one. Two ways of finding it would be
 * two prompts the moment either moved.
 *
 * **Not the managed project's checkout.** That is a clone under `stateDir()`,
 * and a mirror of it under `repos/`; this is Lingtai's own source, which 0010
 * runs unbuilt.
 */
export function repoRoot(): string {
  return root
}

// ---------------------------------------------------------------- the App --

/**
 * The GitHub App's credentials.
 *
 * An App rather than a personal access token, because a fine-grained PAT can be
 * wrong in a way nothing reports: on 2026-08-30 one covered the admin
 * repository's submodule but not the repository itself, and every CI run failed
 * with a 403 that said nothing about scope. An installation makes reachability
 * explicit. See doc/decisions-archive/0006-github-app.md.
 *
 * The private key is a real secret. It is read from a file by default so it
 * never has to be pasted into a shell, and it never appears in any log — a
 * caller that needs to show configuration shows `keySource`, not the key.
 */
export interface GitHubAppCredentials {
  appId: string
  privateKey: string
  /**
   * Where the key came from, for diagnostics. Never the key itself: the
   * absolute path it was read from, or `LINGTAI_GITHUB_APP_PRIVATE_KEY` for one
   * carried inline.
   */
  keySource: string
  /** Which source answered for the App: `"environment"`, or the `config.yml` path. */
  source: string
}

/**
 * The App's names, as one `github:` section — `github.app_id` in the file is
 * `LINGTAI_GITHUB_APP_ID` exported, and so on for each.
 *
 * There is an inline key because some hosts can only carry the key as one line
 * of environment; nothing stops a file naming one too, though the path is what
 * `lingtai init` and the setup page write.
 */
const GITHUB_APP = Config.nested(
  Config.all({
    appId: Config.option(Config.string('app_id')),
    privateKeyPath: Config.option(Config.string('app_private_key_path')),
    privateKey: Config.option(Config.string('app_private_key')),
    webhookSecret: Config.option(Config.string('webhook_secret')),
  }),
  'github',
)

/** What one source says about the App. An empty value is no value. */
export interface GitHubAppSection {
  appId?: string
  privateKeyPath?: string
  privateKey?: string
  webhookSecret?: string
}

/** `github:` as one provider has it. Total: a malformed section is an empty one. */
export function githubSection(provider: ConfigProvider.ConfigProvider): GitHubAppSection {
  return Either.match(readConfig(GITHUB_APP, provider), {
    onLeft: () => ({}),
    onRight: (section) => {
      const out: GitHubAppSection = {}
      for (const [name, value] of Object.entries(section) as [keyof GitHubAppSection, Option.Option<string>][]) {
        if (Option.isSome(value) && value.value !== '') out[name] = value.value
      }
      return out
    },
  })
}

/** What `config.yml` says about the App, with the file it said it in. */
export interface MachineGithub {
  /** The file asked, or null where this environment reads none. */
  path: string | null
  section: GitHubAppSection
  /** Why the file could not be read, where it could not. */
  unreadable?: string
}

/** The `github:` section of a file already read. */
function machineGithub(file: MachineFile): MachineGithub {
  const github: MachineGithub = { path: file.path, section: githubSection(file.provider) }
  if (file.unreadable !== undefined) github.unreadable = file.unreadable
  return github
}

/** The App as elected: one source for every name, or none. */
export interface ElectedGitHubApp {
  /** `"environment"`, the `config.yml` path, or null where nothing names an id. */
  source: string | null
  values: GitHubAppSection
  /** Why `config.yml` could not be read, where it could not — so *not set* is never said about it. */
  unreadable?: string
}

/**
 * **One source answers for the App, and it answers every name.**
 *
 * The environment overrides the file — but as a whole section, never name by
 * name. The id, the key and the webhook secret belong to one App, and asked
 * one at a time they pair App 222's id from one source with App 111's key or
 * secret from the other: every JWT signed with a key GitHub does not hold for
 * that id, or every delivery refused with a secret configured for a different
 * App. So whichever source names the id is asked for the rest, and a name it
 * does not carry is absent rather than borrowed.
 *
 * Pure, over sources already read, so the pairing is a unit test.
 *
 * A relative key path from the file is resolved against `home` — the file's
 * own directory, `stateDir()` — and never against the checkout, which bundled
 * is under `versions/`.
 */
export function electGithubApp(environment: GitHubAppSection, machine: MachineGithub, home: string): ElectedGitHubApp {
  const unreadable = machine.unreadable === undefined ? {} : { unreadable: machine.unreadable }
  if (environment.appId !== undefined) return { source: 'environment', values: environment, ...unreadable }
  if (machine.path !== null && machine.section.appId !== undefined) {
    const values = { ...machine.section }
    if (values.privateKeyPath !== undefined) values.privateKeyPath = resolvePath(values.privateKeyPath, home)
    return { source: machine.path, values }
  }
  return { source: null, values: {}, ...unreadable }
}

/** The election, against this environment and its `config.yml` as it is now. */
export function githubAppValues(from: NodeJS.ProcessEnv = process.env): ElectedGitHubApp {
  return electGithubApp(githubSection(environmentProvider(from)), machineGithub(machineFile(from)), stateDir(from))
}

/**
 * The secret `/api/webhook` verifies deliveries with — the elected App's, and
 * no other's.
 *
 * Undefined where the App that won names none, even if the other source does:
 * that secret belongs to a different App. The file is read per call, so a
 * secret the setup page writes into `config.yml` is seen by the next delivery;
 * an exported one is seen after a restart, like every other variable.
 */
export function githubWebhookSecret(from: NodeJS.ProcessEnv = process.env): string | undefined {
  return githubAppValues(from).values.webhookSecret
}

/**
 * Where the webhook secret is looked for, as a sentence a refusal can carry.
 *
 * `/api/webhook` answers every delivery with this when no secret is
 * configured, rather than a bare 503: a name that is not there is refused by
 * name, with the place it belongs.
 */
export function githubWebhookSecretMissing(from: NodeJS.ProcessEnv = process.env): string {
  const elected = githubAppValues(from)
  const file = machineFilePath(from) ?? join(stateDir(from), 'config.yml')
  if (elected.source === 'environment') {
    return (
      `${PREFIX}GITHUB_WEBHOOK_SECRET is not exported, and the App in this process's environment is the one ` +
      'that answers — export it beside the id and restart'
    )
  }
  return (
    `no webhook secret: ${file} names no github.webhook_secret` +
    (elected.unreadable === undefined ? '' : ` (${elected.unreadable})`) +
    ` — write it there, or export ${PREFIX}GITHUB_WEBHOOK_SECRET beside ${PREFIX}GITHUB_APP_ID and restart`
  )
}

/**
 * `from` exists so that a caller which was *handed* an environment reports on
 * that one. `lingtai doctor` takes an environment as an argument and is supposed to
 * be a function of it; reading past it to `process.env` made its report partly
 * about the argument and partly about the machine, which showed up the moment
 * the operator configured a real App and a test asserting "not configured"
 * started failing for a reason that had nothing to do with the code.
 */
export function githubApp(from: NodeJS.ProcessEnv = process.env): GitHubAppCredentials {
  const elected = githubAppValues(from)
  const { appId, privateKeyPath, privateKey } = elected.values
  if (elected.source === null || appId === undefined) {
    const file = machineFilePath(from) ?? join(stateDir(from), 'config.yml')
    throw new Error(
      `${PREFIX}GITHUB_APP_ID is not set. ` +
        (renamedFrom(`${PREFIX}GITHUB_APP_ID`, from)
          ? `GITHUB_APP_ID is set — it was renamed (#63). Rename the line.`
          : `${file} names no github.app_id, and nothing exported does — the board's setup page or ` +
            'lingtai init writes it there.') +
        (elected.unreadable === undefined ? '' : ` ${elected.unreadable}.`),
    )
  }
  if (privateKeyPath) {
    const absolute = resolvePath(privateKeyPath)
    return { appId, privateKey: readFileSync(absolute, 'utf8'), keySource: absolute, source: elected.source }
  }
  if (privateKey) {
    // Some hosts can only carry the key as one line; \n restores the PEM.
    return {
      appId,
      privateKey: privateKey.replace(/\\n/g, '\n'),
      keySource: `${PREFIX}GITHUB_APP_PRIVATE_KEY`,
      source: elected.source,
    }
  }
  throw new Error(
    elected.source === 'environment'
      ? `${PREFIX}GITHUB_APP_ID is exported but neither ${PREFIX}GITHUB_APP_PRIVATE_KEY_PATH nor ` +
          `${PREFIX}GITHUB_APP_PRIVATE_KEY is — the App in the environment answers every name, so export its key ` +
          'beside it and restart.'
      : `${elected.source} names github.app_id but neither github.app_private_key_path nor github.app_private_key. ` +
          'See doc/decisions-archive/0006-github-app.md for creating the App.',
  )
}

/** Whether the App is configured at all, without throwing to find out — the same election as `githubApp`. */
export function hasGitHubApp(from: NodeJS.ProcessEnv = process.env): boolean {
  const { values } = githubAppValues(from)
  return Boolean(values.appId && (values.privateKeyPath || values.privateKey))
}
