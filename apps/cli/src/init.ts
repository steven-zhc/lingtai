import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
/**
 * `lingtai init`: from a machine with a binary and nothing else to the board,
 * on the wizard (#186, [doc/design/1.0.md](../../../doc/design/1.0.md) *The
 * first run*).
 *
 *   look       git, which runtimes are installed and signed in, what ~/.lingtai holds
 *   store      postgres or sqlite, written down — a URL connected to, its tables created
 *   project    github or local — github asks for the App (#393); local does not
 *   App        one already configured is verified by a real call; a new one
 *              waits with a deadline and a way to skip, never forever
 *   board      started only once the wizard needs one — creating the App, or
 *              picking a repository once one answers — never for a local
 *              project, which prints that `lingtai board` starts one instead
 *
 * **Nothing opens a browser or binds a port until the wizard asks for one**
 * (#434): `board` above is started inside `github.boardUrl()`'s first call, or
 * at the end for a path that opens the wizard on an App already configured —
 * never for a local project, and never merely because this ran with no
 * terminal behind it (`install.sh`), which must still exit. **The run ends by
 * printing what it decided**: the project's recipe, exactly as written, then
 * `doctor`'s report — which is printed and never sets the exit code — then one
 * line saying whether a board is running.
 *
 * **Resuming is not a mode.** Each choice is written to `~/.lingtai/config.yml`
 * the moment it is made and verified, and every run begins by reading what is
 * already there — so an interrupted init continues where it stopped, and a
 * finished one run with no flags reports and changes nothing, by the same code
 * path. There is no progress file to disagree with the configuration it
 * describes. `--database-url` is the one flag that can still change a finished
 * one — see below.
 *
 * **Nothing is written before its choice.** The URL is written after the
 * connection answered and the tables exist, and the App's key by the board's own page (`@lingtai/conductor/create-app`), which
 * is GitHub's manifest flow: the one step here that is a person on somebody
 * else's page.
 *
 * **A failure returns to the choice.** A URL that does not connect asks again —
 * never selects the other thing silently.
 *
 * **Which runtime runs is not this command's question** (`#372`, `#398`). It
 * is each project's, written in its recipe as `runtime.agent` (or `agent:` on
 * a step) — asked by `lingtai add`'s `agents.ts` for every project, never
 * here; a machine-wide default under every recipe was a choice no recipe
 * could be read for. This command still refuses a `config.yml` that names
 * one — see `machineRuntimeRefusal` — because that is a migration message
 * for a file written before `#372`, not a question.
 *
 * **The store is written, never inferred** (0056, #215). `database.store` is
 * `postgres` or `sqlite` and it is this command that puts it there: an empty
 * answer is the SQLite choice, and taking it *removes* `database.url` rather
 * than reporting one store while leaving the other's value behind. What is
 * confirmed at the end is `storeChoice()`'s reading of the file just written —
 * the same function a later command asks — so the screen and the machine cannot
 * disagree.
 *
 * **Either store finishes setup**, since #179: a written `sqlite` opens a log,
 * a projection and a beacon, so the run goes on to the App and the board
 * exactly as a Postgres one does. What is said about such a machine is
 * `SQLITE_MACHINE`, in one place.
 *
 * **A store that answers is asked about again** (0125 §6), as every recipe
 * question is: the answer defaults to the store that is written, an answer
 * equal to it writes nothing, and another is written and then said — the log
 * it opens is a new, empty one, and nothing is copied from the old
 * (0100 §9). `--defaults` keeps a store that is settled and answers; it does
 * not choose one on a machine that has none. Two things are still refused,
 * because the machine could not obey another answer: an exported
 * `LINGTAI_DATABASE_URL`, and an empty `--database-url`.
 *
 * **`--database-url <url>` given on its own is the one re-run that is still a
 * write** (#392): given to a machine already settled on another database that
 * still answers, it repoints straight to the one it names — connecting there,
 * creating its tables, and rewriting `database.url` — rather than reporting
 * the old one. A flag given to be explicit is not discarded for being
 * inconvenient. The same URL a settled machine already has is that same run,
 * written again rather than asked about; naming another behind an exported
 * `LINGTAI_DATABASE_URL` is refused rather than silently ignored, because
 * that is the one case this process cannot obey the flag at all.
 *
 * **`--store` answers the store question without a terminal** (#345), and it
 * answers it by the same lines the person would: `--store sqlite` is the empty
 * answer given in advance — the same write, the same `database.url` removed —
 * and `--store postgres --database-url` is `--database-url`, except that a URL
 * that fails is a refusal rather than a question. Where the machine would not
 * obey `--store sqlite`, it is refused by name and nothing is written: see
 * `sqliteRefused`.
 *
 * **Subscriptions are not Lingtai's business.** Whether a runtime can run is
 * asked of the runtime; whether it is paid for is not asked at all.
 *
 * **This now reads and writes the log, for the project question (#394).** The
 * local branch reduces every `prj-*` stream (`world.projects()` →
 * `loadAllProjects()`) and appends `ProjectConfigured` (`world.registerLocal()`
 * → `addLocal`), so `@lingtai/conductor/onboard` and `@lingtai/conductor/projects`
 * are imported statically at the top of this file, same as `first-project.ts`'s
 * own live seam — not lazily, the way `doc/design/394.md` asked for. That is
 * safe only because `@lingtai/event-store`'s own client is itself built lazily
 * inside its barrel (#179): importing the module does not yet need a database.
 * **If that ever stops being true** — an eager read added to `onboard.ts` or
 * `projects.ts` that does not go through the deferred client — `lingtai init`
 * breaks silently on the fresh machine it exists for, since nothing here
 * checks for it. Everything else outside this file is still reached through
 * `InitWorld`, so a test drives every other step and every interruption with
 * no database, network or browser.
 */
import { userInfo } from 'node:os'
import { basename, join } from 'node:path'

import { addEffect, addLocalEffect } from '@lingtai/conductor/onboard'
import { sandboxHostHere, signedInHere } from '@lingtai/conductor/projects'
import { liveHistoryEffect } from '@lingtai/conductor/ticket-history'
import { type ProjectState } from '@lingtai/domain'
import {
  SQLITE_MACHINE,
  type MachineFile,
  type StoreChoice,
  type StoreChosen,
  boardHost,
  boardOrigin,
  boardPort,
  boardReachHost,
  describeStore,
  githubAuthElectionFrom,
  machineFileFrom,
  redactUrl,
  stateDir,
  storeChoice,
} from '@lingtai/env'
import { paint } from '@lingtai/env/colour'
import type { Locker } from '@lingtai/env/lock'
import { createFileLocker, type HeldLock } from '@lingtai/env/lock'
import { type Queryable, type SchemaOutcome, createSchemaEffect } from '@lingtai/event-store/schema'
import type { EventStore } from '@lingtai/event-store/store'
import { ghStatusEffect, liveGh, type GhRun, type GhStatus } from '@lingtai/github'
import { loadAllProjectsEffect, projectsOnDisk, recipePath, recipeText, recipeValue } from '@lingtai/project'
import { kindsOf, resolveSource, ticketSourceOf, type SignedIn } from '@lingtai/recipe'
import { runSetupList, writeGithubAuth, writeStore, type SetupReader } from '@lingtai/setup'
import { askRuntimesEffect, runtimeStateSentence, type RuntimeFound } from '@lingtai/setup'
import { Effect } from 'effect'
import { Document, isMap, parseDocument } from 'yaml'

import { type AddWorld, githubProjectEffect } from './add.ts'
import { checkAppEffect, pollForAppEffect, type AppCheck } from './app-check.ts'
import { boardAtEffect, boardLock, builtBoardDir, serveBoardEffect } from './board.ts'
import { liveSetupTokenRun } from './claude-token.ts'
import { askTokenFor, machineSetup, registeredRecipes } from './machine-askers.ts'
import { lift, recovering } from './exit.ts'
import {
  chooseFirstProjectEffect,
  type FirstProjectWorld,
  type GitResult,
  livePickerEffect,
  liveGitEffect,
  liveOpen,
  liveSetupReader,
  type RegisterLocalPayload,
  pathExistsEffect,
} from './first-project.ts'
import { APP_WAIT_MS, waitForAppEffect } from './github-app.ts'
import { liveMachineText } from './github-auth.ts'
import { checkoutIssueForms, NO_FORMS, type IssueForms } from './issue-forms.ts'
import { type RawStdin, waitForKeypress } from './keypress.ts'
import { addSteps, githubInitSteps, type Here, hereSteps, type IssueTakes, localInitSteps } from './next-steps.ts'
import { heading, keyValues, renderNextBlock, renderNextLine, section, symbol } from './output.ts'
import { interactivity, liveAsk, liveSpin, refusal } from './prompt.ts'
import { spunEffect, type QuestionWorld } from './question.ts'
import { issueTakeOf, type LeftBehind } from './setup-card.ts'
import { DOCTOR_VERBOSE, liveSetupDoctorEffect, printSetupEndEffect, type SetupDoctor } from './setup-end.ts'
import { ROUNDS_RETIRED, type WizardFlags } from './wizard-options.ts'

// -------------------------------------------------------------- the world --

export type { RuntimeFound }

export type DatabaseCheck = { ok: true; schema: SchemaOutcome } | { ok: false; why: string }

export type { AppCheck }

export interface InitWorld {
  /**
   * The environment every choice is read against — `storeChoice()`'s argument,
   * so a test drives the real reader by handing it a `LINGTAI_HOME` of its own
   * and, where it means the exported variable, a `LINGTAI_DATABASE_URL`.
   */
  env: NodeJS.ProcessEnv
  /**
   * `config.yml`, read and written without reaching for `node:fs` directly
   * (#435) — so a `unit/` test drives the whole of `init` with a `Map`
   * standing in for the file. The live one is today's fs code, moved
   * verbatim: `read` is `existsSync`/`readFileSync`, `write` is the mkdir,
   * the `.partial`, the `chmod 0600` and the rename, and `describeHome`
   * lists what is under `home` for the "look" line.
   */
  machine: {
    /** Null where the file is not there. */
    read: (path: string) => string | null
    write: (path: string, text: string) => void
    describeHome: (home: string, path: string) => string
  }
  log: (line: string) => void
  /** One line from the person. Null when nobody is at a terminal to answer. */
  ask: QuestionWorld['ask']
  /** `QuestionWorld.spin` — a slow step under a label; absent means just run it. */
  spin?: QuestionWorld['spin']
  /** `git --version`, or null when there is no git. */
  git: () => Effect.Effect<string | null, unknown>
  /** Every runtime, asked whether it is installed and signed in. */
  runtimes: () => Effect.Effect<readonly RuntimeFound[], unknown>
  /** `FirstProjectWorld.setupReader` (#431) — a real directory, over `node:fs`. */
  setupReader: (dir: string) => SetupReader
  /** `FirstProjectWorld.exists` — over `node:fs`. */
  exists: (path: string) => Effect.Effect<boolean, unknown>
  /** Connect, and create the tables where there are none. */
  database: (url: string) => Effect.Effect<DatabaseCheck, unknown>
  /** The App this machine is configured with, asked with a real call. */
  app: () => Effect.Effect<AppCheck, unknown>
  /** `gh auth status` (#706) — asked only when the GitHub-auth question is, or `--github-auth gh` is given. */
  ghStatus: () => Effect.Effect<GhStatus, unknown>
  /** `gh` with the terminal handed over (#712) — absent where there is no terminal, so the sign-in option is not offered. */
  gh?: GhRun
  /**
   * Succeeds once an App is configured and answers — written by the board's
   * first screen. Stops polling once interrupted; the loser of a race.
   */
  appeared: () => Effect.Effect<{ slug: string; owner: string }, unknown>
  /** Succeeds on any keypress at a TTY — the skip. Never, at no TTY, until interrupted. */
  pressed: () => Effect.Effect<void, unknown>
  /**
   * A Lingtai board already answering on this port — the machine's own, from
   * `lingtai board` or the service — as its URL, or null. Asked before one is
   * started, since a second on the same port is refused.
   */
  boardAt: (port: number) => Effect.Effect<string | null, unknown>
  /** Serve the board; the process stays up for it. */
  board: (port: number) => Effect.Effect<{ url: string } | { refused: string }, unknown>
  /** Open a browser. False when none could be. */
  open: (url: string) => Effect.Effect<boolean, unknown>
  /**
   * `FirstProjectWorld.git` (#394) — named distinctly from `git` above, which
   * answers `git --version` rather than running a command in a directory.
   */
  runGit: (dir: string, args: readonly string[]) => Effect.Effect<GitResult, unknown>
  /** `loadAllProjects` — registered and pending alike, keyed by name (#394). */
  projects: () => Effect.Effect<readonly ProjectState[], unknown>
  /** The checkout's issue forms (#1518), over `node:fs`; absent means none. It cannot fail. */
  issueForms?: (toplevel: string) => Effect.Effect<IssueForms>
  /** The lock an add is made under; the machine's file lock unless a test hands one in. */
  locker?: Locker
  /** The log a recipe written by the first project is recorded on: the process's own when absent. */
  store?: EventStore
  signedIn: SignedIn
  /** `FirstProjectWorld.register` for the local branch — appends `ProjectConfigured`. */
  registerLocal: (payload: RegisterLocalPayload) => Effect.Effect<{ line: string; updated: boolean }, unknown>
  /** `FirstProjectWorld.history` (#396) — `ticket-<project>-*` streams already in the log for this project. */
  history: (project: string) => Effect.Effect<readonly string[], unknown>
  /** `FirstProjectWorld.sandboxHost` (#1160): absent asks no sandbox question. */
  sandboxHost?: FirstProjectWorld['sandboxHost']
  /**
   * The report `lingtai doctor` would print, formatted — printed at the end
   * and never allowed to set the exit code (#434). The live one imports
   * `./doctor.ts` dynamically; this file's header warns why an eager one would
   * break a fresh machine.
   */
  doctor: () => Effect.Effect<SetupDoctor, unknown>
  /**
   * What `--github <owner>/<repo>` reaches GitHub with — the live ones where absent. `deps` and `labels` are
   * `AddWorld`'s own; `add` and `picker` are `FirstProjectWorld.github`'s.
   */
  githubProject?: {
    deps?: AddWorld['githubDeps']
    labels?: AddWorld['labels']
    add?: FirstProjectWorld['github']['add']
    picker?: FirstProjectWorld['github']['picker']
  }
  /** Whether there is a terminal to ask at; absent reads as true. Never inferred from `ask` answering nothing. */
  interactive?: boolean
  /** The directory `init` was run in (live: `process.cwd()`) — asked about when this machine already has projects (#756). */
  cwd: string
}

const USAGE =
  'lingtai init [--store sqlite|postgres] [--database-url <postgres url>] [--port <n>] ' +
  '[--project github|local] [--local <dir>] [--base <branch>] [--github-app create|skip] [--github-auth gh|app] ' +
  '[--agent <id>] [--model <id>] [--reviewer <id>] [--reviewer-model <id>] [--install <cmd>] ' +
  '[--build <cmd>] [--tickets github|db] [--kinds <a,b,c>] [--land <branch>] [--refusal-fixes <n>] [--conflict-resolutions <n>] ' +
  '[--wall <duration>] [--budget <amount>] [--defaults|--yes]'

/** What `--store` names: the store question answered from the command line, as the person at a terminal would. */
type StoreFlag = 'postgres' | 'sqlite'

// ---------------------------------------------------------- config.yml --

export function configPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), 'config.yml')
}

/** The machine file as a document, so a write keeps every comment and key it did not choose. */
function readConfig(path: string, read: InitWorld['machine']['read']): Document | { refused: string } {
  const text = read(path)
  if (text === null) return new Document({})
  const doc = parseDocument(text)
  if (doc.errors.length > 0) {
    return { refused: `${path} does not parse as YAML (${doc.errors[0]!.message}) — fix it and run lingtai init again` }
  }
  if (doc.contents === null) return new Document({})
  if (!isMap(doc.contents)) return { refused: `${path} is not a mapping — fix it and run lingtai init again` }
  return doc
}

/** `world.machine`'s file, as `storeChoice`/`boardPort` read it — never `machineFile(env)`'s own fs read (#435). */
function machineFor(world: Pick<InitWorld, 'machine'>, path: string): MachineFile {
  return machineFileFrom(path, world.machine.read(path))
}

/**
 * A URL fit to print: the password is never shown.
 *
 * `@lingtai/env`'s, because the store's own refusals quote a `database.url`
 * too — one redaction, so there is one place a password could escape from.
 */
export { redactUrl as redact } from '@lingtai/env'

// ------------------------------------------------------------ the command --

function refuse(world: Pick<InitWorld, 'log'>, line: string, code = 1): number {
  world.log(`${symbol.fail()} ${paint.fail(line)}`)
  return code
}

/** One block of facts under its heading, printed as soon as the facts are known (0121 §1). */
function fact(
  world: Pick<InitWorld, 'log'>,
  title: string,
  pairs: readonly (readonly [string, string])[],
  note?: string,
) {
  world.log(section(title, [...keyValues(pairs), ...(note === undefined ? [] : [note])]))
}

/** `fact`, held back instead of printed: whether the run ends on the card is not known yet. */
function heldFact(held: string[], title: string, pairs: readonly (readonly [string, string])[], note?: string) {
  held.push(section(title, [...keyValues(pairs), ...(note === undefined ? [] : [note])]))
}

export function initCommandEffect(args: WizardFlags, world: InitWorld): Effect.Effect<number, unknown> {
  return Effect.gen(function* () {
    const { flags, repeated } = args
    // The heading, `Machine` and `Store` are printed only by a run that does not end on the card (#773).
    const held: string[] = []
    // What a change of store leaves behind (#1474): on the card where there is one, and said here where there is not.
    const storeLeft: LeftBehind[] = []
    const flush = (): void => {
      for (const line of held.splice(0)) world.log(line)
      for (const l of storeLeft.splice(0)) world.log(`left behind: ${l.what}`)
    }
    const stop = (line: string, code = 1): number => {
      flush()
      return refuse(world, line, code)
    }
    const buildFlags = repeated['build'] ?? []
    const asked = flags['port'] === undefined ? null : Number(flags['port'])
    if (asked !== null && (!Number.isInteger(asked) || asked <= 0))
      return stop(`${USAGE} — --port takes a port number`, 2)
    const named = flags['store'] ?? null
    if (named !== null && named !== 'sqlite' && named !== 'postgres')
      return stop(`${USAGE} — --store takes sqlite or postgres`, 2)
    // Two stores named in one command: neither is guessed at, and nothing is written (#345).
    if (named === 'sqlite' && flags['database-url'] !== undefined) {
      return stop(`${USAGE} — --store sqlite and --database-url name two different stores. Nothing was written`, 2)
    }

    const home = stateDir(world.env)
    const path = configPath(world.env)

    // ---- look -----------------------------------------------------------------
    held.push(heading('init'))
    const git = yield* world.git()
    const runtimes = yield* spunEffect(world, 'looking for runtimes', world.runtimes())
    heldFact(held, 'Machine', [
      ['git', git ? git : paint.fail('not on PATH')],
      ...runtimes.map((r) => {
        const state = r.signedIn ? r.detail : runtimeStateSentence(r.id, r.state, r.detail).slice(r.id.length + 1)
        return [r.id, state] as const
      }),
      ['home', `${home} — ${world.machine.describeHome(home, path)}`],
    ])
    if (!git) {
      return stop(
        'git is not on PATH — the mirror and the worktrees are git. Install it and run lingtai init again; nothing was written',
      )
    }

    let hadConfig = false
    const config = readConfig(path, (p) => {
      const text = world.machine.read(p)
      hadConfig = text !== null
      return text
    })
    if ('refused' in config) return stop(config.refused)

    // ---- the agent --------------------------------------------------------
    // Which runtime runs is each project's question now (`#372`, `#398`),
    // asked by `lingtai add`'s `agents.ts` — never here. This still refuses a
    // `config.yml` naming one: that is a migration message for a file written
    // before `#372`, not a question `init` is asking.
    const agentRefusal = machineRuntimeRefusal(config, path)
    if (agentRefusal !== null) return stop(agentRefusal)

    // ---- the machine's questions ----------------------------------------------
    // One ordered list, defined in `@lingtai/setup` and asked from the top on every run (0125 §9, #1522):
    // the store, how this machine reaches GitHub, the daily ceiling, the Claude Code token (on demand).
    // What is checked here is flag parsing; every default, every skip and every write is the runner's.
    if (named === 'sqlite') {
      const refused = sqliteRefused(world, path)
      if (refused !== null) return stop(refused)
    }
    const databaseFlag = flags['database-url'] ?? null
    if (databaseFlag !== null && databaseFlag.trim() === '') {
      const given = named === 'postgres' ? '--store postgres --database-url' : '--database-url'
      return stop(
        `${USAGE} — ${given} takes a postgres:// URL. Leave it out entirely for SQLite. Nothing was written`,
        2,
      )
    }
    const preset = storeChoice(world.env, machineFor(world, path))
    const exportedPostgres = !('refused' in preset) && preset.where === 'environment' && preset.store === 'postgres'
    if (exportedPostgres && databaseFlag !== null && databaseFlag.trim() !== preset.url) {
      const given = named === 'postgres' ? '--store postgres --database-url' : '--database-url'
      return stop(exportedUrlRefusal(given, redactUrl(databaseFlag), preset.from, redactUrl(preset.url)))
    }
    if (named === 'postgres' && databaseFlag === null && !exportedPostgres) {
      return stop(
        `${USAGE} — --store postgres takes --database-url <postgres url>, or an exported LINGTAI_DATABASE_URL. Nothing was written`,
        2,
      )
    }

    const interactive = world.interactive ?? true
    const machine = machineSetup(
      {
        ask: world.ask,
        log: world.log,
        ...(world.spin === undefined ? {} : { spin: world.spin }),
        env: world.env,
        machine: world.machine,
        path,
        interactive,
        database: world.database,
        app: world.app,
        ghStatus: world.ghStatus,
        ...(world.gh === undefined ? {} : { gh: world.gh }),
        recipes: () =>
          registeredRecipes({
            projects: () => world.projects(),
            home,
            ...(world.store === undefined ? {} : { store: world.store }),
          }),
        run: liveSetupTokenRun(),
      },
      { githubRequired: false, command: 'lingtai init' },
    )

    // A machine set up before the store was a written value (#186) has a `database.url` and no `store`: that is
    // the choice nobody recorded. It is verified and recorded once, ahead of the list, and the store is then in
    // force like any other — asked about, with the URL as its default.
    if (
      'refused' in preset &&
      preset.because === 'nothing chosen' &&
      named !== 'sqlite' &&
      databaseFlag === null
    ) {
      const older = config.getIn(['database', 'url'])
      if (typeof older === 'string' && older !== '') {
        const check = yield* spunEffect(world, 'connecting to the database', world.database(older))
        if (check.ok) {
          writeStore(world.machine, path, { url: older })
        } else {
          flush()
          world.log(paint.fail(`${redactUrl(older)} does not answer — ${check.why}`))
        }
      }
    }

    const beforeStore = storeChoice(world.env, machineFor(world, path))
    let homeIsNewNow = false
    const keptNow = () => {
      const now = storeChoice(world.env, machineFor(world, path))
      homeIsNewNow = !hadConfig && world.machine.read(path) !== null
      return initKept({ choice: now, configPath: path, startedWithConfig: hadConfig, wrote: homeIsNewNow })
    }
    const defaults = flags['defaults'] !== undefined
    const listed = yield* runSetupList(
      machine.list,
      machine.input({
        flags,
        defaults,
        log: (line) => {
          flush()
          world.log(paint.fail(line))
        },
        kept: (written) => (written.length === 0 ? { kept: 'Nothing was written' } : keptNow()),
      }),
    )
    if (listed.refused !== undefined) return stop(listed.refused)
    const storeEntry = listed.entries.find((e) => e.id === 'store')
    const githubEntry = listed.entries.find((e) => e.id === 'github')

    const storeNow = storeChoice(world.env, machineFor(world, path))
    if ('refused' in storeNow) return stop(storeNow.refused)
    if (storeEntry?.wrote === true) {
      const read = confirm(world, stop, path, storeNow.store)
      if (typeof read === 'number') return read
      storeSwitched(storeLeft, beforeStore, read)
    }
    const homeIsNew = !hadConfig && world.machine.read(path) !== null
    const storeKept = initKept({
      choice: storeNow,
      configPath: path,
      startedWithConfig: hadConfig,
      wrote: homeIsNew,
    })
    if (storeNow.store === 'sqlite') {
      sqliteChosen(held, storeNow)
    } else {
      const schema = machine.schemaOf(storeNow.url)
      heldFact(held, 'Store', [
        ['store', paint.pass(`${describeStore(storeNow)}${schema === undefined ? '' : ` · ${describeSchema(schema)}`}`)],
      ])
    }
    // A value the environment supplies is in force: not asked, not written, and said so.
    for (const entry of listed.entries) {
      const was = entry.before
      if (was !== null && was.from === 'environment' && was.value !== undefined && entry.id !== 'store') {
        const q = machine.list.find((x) => x.id === entry.id)
        if (q !== undefined) heldFact(held, q.name, [[q.id, `${q.row(was.value, was)} — from the environment`]])
      }
    }

    // ---- how this machine reaches GitHub, as the list left it --------------------
    // Read off the file this world was handed and the environment, not off the disk. A refused `github.auth`
    // was refused by the list, by name, before anything else was asked (0114 §1).
    const authElection = githubAuthElectionFrom(world.env, machineFor(world, path))
    if ('refused' in authElection) return stop(`${authElection.refused}. Fix it and run lingtai init again`)
    const ghMachine = authElection.kind === 'gh'
    const answeredAuth =
      githubEntry?.after ??
      (githubEntry?.before != null && 'value' in githubEntry.before ? githubEntry.before.value : 'none')
    const decidedAuth = {
      auth: answeredAuth as 'gh' | 'app' | 'none',
      pending: githubEntry?.pending === true,
    }

    // A `gh` machine's App, if it carries one, is never consulted (0114 §1).
    const app: AppCheck = ghMachine ? { configured: false } : yield* machine.app()
    // ---- which project ---------------------------------------------------------
    // Registering a project *is* the record of the answer (#394) — nothing
    // machine-wide holds "local" or "github". A machine that already has
    // projects is told what it has and how to add another, rather than asked
    // the question again; an explicit --project or --local names what to do
    // next and reopens the question on one. `--github <owner>/<repo>` names the
    // project outright and runs `lingtai add`'s own path for it (`githubProjectEffect`).
    if (flags['github'] !== undefined && (flags['local'] !== undefined || flags['project'] === 'local')) {
      return stop(
        `--github ${flags['github']} and ${flags['local'] !== undefined ? `--local ${flags['local']}` : '--project local'} name two different projects. Pass one or the other. Nothing was written`,
      )
    }
    const explicitChoice =
      flags['project'] !== undefined || flags['local'] !== undefined || flags['github'] !== undefined
    // Whether the project question is asked at all this run — false when the
    // machine already has projects and nothing named which to add, so the
    // question is not asked again (below), only answered by what is printed
    // here (#394's finding 3: this must not itself end the run — the board
    // still has to start, and the port flag still has to be obeyed).
    let askProject = true
    // Where `init` was run, when the machine already has projects: what the closing block is built from (#756).
    let here: Here | null = null
    if (!explicitChoice) {
      const registered = yield* world.projects()
      if (registered.length > 0) {
        const listed: string[] = []
        for (const p of registered) {
          if (p.owner !== null) {
            listed.push(`${p.owner}/${p.project} — github`)
            continue
          }
          // `owner: null` is a local project, and also a GitHub one registered
          // before `ProjectConfigured` carried an owner (#352's `unrecorded`):
          // only the remote a local registration writes tells the two apart.
          const remote =
            p.project === null
              ? null
              : yield* recipeValue(p.project, ['repo', 'remote'], {
                  home,
                  ...(world.store === undefined ? {} : { store: world.store }),
                })
          listed.push(
            typeof remote === 'string'
              ? `${p.project} — local, ${remote}`
              : `${p.project} — owner not recorded; lingtai add <owner>/${p.project} records it`,
          )
        }
        here = yield* whereAmI(world, registered, home)
        flush()
        world.log(
          section('Projects', [
            ...listed,
            paint.muted(
              'lingtai add <owner>/<repo> or lingtai init --github <owner>/<repo> sets up a GitHub project, or ' +
                'changes one already added; lingtai add asks GitHub-or-directory for another; lingtai init ' +
                '--project github sets up the GitHub App on a machine that has only local projects',
            ),
          ]),
        )
        // Nothing below here reaches `chooseFirstProject`, so nothing reads any
        // of these flags — refused by name instead of silently discarded, the
        // same reason `runGithubBranch`'s own guard exists (#396 fix round,
        // finding 3; #431 fix round, finding 1 — the ten `askRecipe` flags got
        // no equivalent guard here, and this path never reaches
        // `runGithubBranch`'s own).
        if (flags['base'] !== undefined) {
          return stop(`--base is now --main: pass --main ${flags['base']}. The store chosen above is kept`)
        }
        const discardedFlag = [
          'main',
          'tickets',
          'kinds',
          'agent',
          'model',
          'reviewer',
          'reviewer-model',
          'install',
          'build',
          'check-build',
          'land',
          'rounds',
          'refusal-fixes',
          'conflict-resolutions',
          'wall',
          'budget',
        ].find((name) => flags[name] !== undefined)
        if (flags['rounds'] !== undefined) return stop(ROUNDS_RETIRED)
        if (discardedFlag !== undefined) {
          return stop(
            `--${discardedFlag} ${flags[discardedFlag]}, but this machine already has a project and none is named ` +
              'to set up here — pass --project github, --project local, or --local <dir>, or use lingtai add for ' +
              'one that already exists. The store chosen above is kept',
          )
        }
        askProject = false
      }
    }

    // ---- the board, started lazily --------------------------------------------
    // The port is decided here and not at the top: `board.port` is read out of
    // the same file `readConfig` above refuses by name, and a file that does not
    // parse should say so once, in its own words, rather than through the port.
    //
    // **Started only once the wizard asks for a URL** (#434): a board started
    // unconditionally here, as it used to be, keeps a process with no terminal
    // behind it (`install.sh`) alive forever once it serves one. `startBoard`
    // is memoised, so `boardUrl()` below calls it at most once per run, and a
    // local project never calls it at all.
    const port = asked ?? boardPort(world.env, machineFor(world, path))
    type BoardStart = { url: string; started: boolean } | { refused: string }
    // A settled value, not a cached promise: every call here is already
    // awaited before the next one starts, so there is no race to memoise
    // against — only the repeat call `startBoard` exists to avoid.
    let boardResult: BoardStart | null = null
    const startBoard = (): Effect.Effect<BoardStart, unknown> =>
      Effect.gen(function* () {
        if (boardResult !== null) return boardResult
        // A board already up is this machine's, and the wizard is on it: a
        // re-run uses it rather than failing on its port.
        const running = yield* world.boardAt(port)
        if (running !== null) {
          boardResult = { url: running, started: false }
          return boardResult
        }
        const started = yield* world.board(port)
        boardResult = 'refused' in started ? { refused: started.refused } : { url: started.url, started: true }
        return boardResult
      })
    // A function, not a bare read of `boardResult`: TypeScript does not narrow
    // a `let` this far from its declaration once a nested closure (`startBoard`
    // above) assigns to it, and reports every later `boardResult !== null`
    // check against `null` alone rather than `BoardStart`. Going through a
    // function with its own return type annotation sidesteps that.
    const boardSoFar = (): BoardStart | null => boardResult
    const boardRefused = (why: string): number =>
      stop(
        `the board did not start — ${why}. Everything chosen above is kept, and lingtai init again continues from here`,
      )

    // *this machine* alone, for a GitHub run that has no repository yet: no project group, and a ready
    // line without a recipe. `how` is the one row about GitHub.
    const machineCard = (how: string): Effect.Effect<string | undefined, unknown> =>
      Effect.gen(function* () {
        held.length = 0
        const end = yield* printSetupEndEffect(
          world,
          {
            command: 'init',
            updated: false,
            home,
            homeIsNew,
            userHome: world.env['HOME'] ?? '',
            store: storeNow,
            runtimes,
            github: how,
            ...(storeLeft.length === 0 ? {} : { leftBehind: storeLeft }),
          },
          [],
        )
        return end.fix
      })
    const reachRow = (viaGh: boolean): Effect.Effect<string, unknown> =>
      Effect.gen(function* () {
        if (viaGh) {
          const status = yield* world.ghStatus()
          return status.ok
            ? status.login === ''
              ? 'gh, signed in'
              : `gh, signed in as ${status.login}`
            : 'gh, not signed in'
        }
        return app.configured && app.ok ? `the App ${app.slug}` : 'no App yet'
      })

    let github = false
    // What a failed doctor closes on; undefined when it did not fail.
    let fix: string | undefined
    // A local run's doctor report is part of the card; every other path prints it whole, below.
    let cardDrawn = false
    // What `lingtai init --github` closes on: the project's own numbered block, as `lingtai add` does.
    let githubClosing: Parameters<typeof addSteps>[0] | undefined
    // The board's `/setup/repository` page, when the App was just made here.
    let githubSetupUrl: string | undefined
    if (askProject) {
      // Built from `world` directly rather than through a live default (#394's
      // finding 6): every seam `chooseFirstProject` reaches for — `git`, the
      // log, the App — is the one this test or process was
      // handed, never `checkApp`, `loadAllProjects`, a bare `stateDir()`
      // reached for underneath it.
      const firstProjectWorld: FirstProjectWorld = {
        ask: world.ask,
        log: world.log,
        git: world.runGit,
        projects: world.projects,
        locker: world.locker,
        by: `human:${userInfo().username}`,
        ...(world.store === undefined ? {} : { store: world.store }),
        home,
        signedIn: world.signedIn,
        // Already probed above, for the "look" lines — a second probe for the
        // same run would ask every runtime whether it is signed in twice.
        runtimes: () => Effect.succeed(runtimes),
        ...(world.sandboxHost === undefined ? {} : { sandboxHost: world.sandboxHost }),
        // The list's own entry, run again once the recipe is final: a first `init` has none until the project path
        // has made one. An entry asked at its place above is not in `deferred`, so it is asked at most once.
        claudeToken: (recipe, given) => askTokenFor(machine, world, given, recipe, listed.deferred),
        setupReader: world.setupReader,
        exists: world.exists,
        register: world.registerLocal,
        history: world.history,
        // The store above is already written by the time this runs — the same
        // reason `askFirstProject` carries this sentence (#394 finding 2).
        kept: storeKept.kept,
        ...(storeKept.startOver === undefined ? {} : { startOver: storeKept.startOver }),
        command: 'lingtai init',
        // `init`'s only (first-project.ts): a configured App already answers
        // *is the project*, and `--project`/`--github-app` naming anything else
        // is refused rather than asked past.
        githubAppIsTheProject: true,
        github: {
          // The same election `githubAuthKind` makes, over the file this world
          // was handed — a refusal of it already stopped the run above.
          auth: () => {
            const elected = githubAuthElectionFrom(world.env, machineFor(world, path))
            if ('refused' in elected) throw new Error(elected.refused)
            return elected.kind
          },
          decided: decidedAuth,
          ghStatus: world.ghStatus,
          ...(world.gh === undefined ? {} : { gh: world.gh }),
          writeAuth: (kind) => Effect.try({ try: () => writeGithubAuth(world.machine, path, kind), catch: (e) => e }),
          // Already fetched by the list, for the "the App" line — a second real call
          // (`GET /app`) for the same run would answer the same question twice.
          app: () => machine.app(),
          // The trap: a refused start answers null here, same as no board
          // running at all — `runGithubBranch` turns that into its own
          // sentence, written for `lingtai add`, absurd inside `init`. The
          // check below, after `chooseFirstProject` returns, replaces it with
          // the board's own refusal whenever this was the reason.
          boardUrl: () => startBoard().pipe(Effect.map((started) => ('url' in started ? started.url : null))),
          waitForApp: (boardUrl) =>
            waitForAppEffect(
              { log: world.log, open: world.open, appeared: world.appeared, pressed: world.pressed },
              boardUrl,
              { waitMs: APP_WAIT_MS },
            ),
          // `chooseFirstProject` is given a slug only through `--github <owner>/<repo>`, which
          // `githubProjectEffect` hands it; `--project github` has none, and returns before either of these runs.
          picker: world.githubProject?.picker ?? livePickerEffect,
          add: world.githubProject?.add ?? ((opts, log) => addEffect(opts, log)),
        },
      }
      const githubSlug = flags['github']
      if (githubSlug !== undefined && githubSlug !== '') {
        // The project is named, so there is nothing to pick: the same function `lingtai add` runs, after the machine's questions.
        const done = yield* githubProjectEffect(
          githubSlug,
          flags,
          buildFlags,
          {
            project: firstProjectWorld,
            ...(world.githubProject?.deps === undefined ? {} : { githubDeps: world.githubProject.deps }),
            ...(world.githubProject?.labels === undefined ? {} : { labels: world.githubProject.labels }),
            error: (line) => {
              flush()
              refuse(world, line)
            },
            log: world.log,
            doctor: world.doctor,
            store: () => storeNow,
            userHome: world.env['HOME'] ?? '',
          },
          { command: 'init', homeIsNew, leftBehind: storeLeft },
        )
        if (done.exit !== 0) return done.exit
        held.length = 0
        fix = done.fix
        githubClosing = done.closing
        cardDrawn = true
      } else {
        const chosen = yield* chooseFirstProjectEffect(firstProjectWorld, flags, buildFlags)
        if ('refused' in chosen) {
          // `boardUrl()` above is the only caller of `startBoard` on this path —
          // if it was ever asked for, a refusal it hit is the real reason, over
          // the GitHub-add sentence `chosen.refused` carries for a null URL.
          const soFar = boardSoFar()
          if (soFar !== null && 'refused' in soFar) return boardRefused(soFar.refused)
          return stop(chosen.refused)
        }

        if (chosen.project === 'local') {
          if (decidedAuth.pending) {
            world.log(
              'github.auth stays unwritten until a GitHub App exists — run lingtai init --project github',
            )
          }
          const recipeFile = recipePath(chosen.name, home)
          // Read back like `summariseRecipe` does: a recipe that cannot be read draws no card.
          if (
            (yield* recipeText(chosen.name, { home, ...(world.store === undefined ? {} : { store: world.store }) })) ===
            null
          ) {
            return stop(`the recipe could not be read back from ${recipeFile}`)
          }
          held.length = 0
          const end = yield* printSetupEndEffect(
            world,
            {
              command: 'init',
              project: chosen.name,
              updated: chosen.updated,
              ...(chosen.unchanged === true ? { unchanged: true } : {}),
              home,
              homeIsNew,
              userHome: world.env['HOME'] ?? '',
              store: storeNow,
              runtimes,
              recipe: chosen.card,
              trial: chosen.trial,
              recipePath: recipeFile,
              ...(storeLeft.length + (chosen.leftBehind?.length ?? 0) === 0
                ? {}
                : { leftBehind: [...storeLeft, ...(chosen.leftBehind ?? [])] }),
            },
            chosen.hints,
          )
          fix = end.fix
          cardDrawn = true
        } else {
          github = true
          let how = yield* reachRow(chosen.auth === 'gh')
          if (chosen.auth === 'gh') {
            // No App to start a board for: the saved `gh` login is the whole of
            // the auth, and a repository is named to `lingtai add`, not picked.
          } else if (chosen.app === 'already') {
            // Nothing upstream asked for a URL on this path — `app.configured` was
            // already true, so `boardUrl()` above was never called.
            const started = yield* startBoard()
            if ('refused' in started) return boardRefused(started.refused)
            const wizard = `${started.url}/setup/repository`
            world.log(
              (yield* world.open(wizard))
                ? paint.pass(`opened ${wizard}`)
                : `no browser could be opened here — open ${wizard}`,
            )
          } else if ('made' in chosen.app) {
            // Already started, successfully, to hand `waitForApp` its URL above —
            // this reads the same memo rather than starting a second one.
            const started = yield* startBoard()
            const url = 'url' in started ? started.url : ''
            githubSetupUrl = `${url}/setup/repository`
            how = `the App ${chosen.app.made.slug}`
          }
          // `skipped` and `timedOut` are already logged by `chooseFirstProject`'s
          // own call to `waitForApp` (`appComeBackLine`).
          //
          // `init`'s GitHub branch never has a slug, so there is no recipe file
          // to name here — it exists once a repository is picked.
          fix = yield* machineCard(how)
          cardDrawn = true
        }
      }
    } else if (app.configured && !ghMachine) {
      github = true
      // Nothing new was asked — the machine already has projects, told above —
      // but a configured App still has its one remaining screen: the wizard
      // that picks a repository for it. Nothing upstream asked for a board yet.
      const started = yield* startBoard()
      if ('refused' in started) return boardRefused(started.refused)
      const wizard = `${started.url}/setup/repository`
      world.log(
        (yield* world.open(wizard))
          ? paint.pass(`opened ${wizard}`)
          : `no browser could be opened here — open ${wizard}`,
      )
      fix = yield* machineCard(yield* reachRow(ghMachine))
      cardDrawn = true
    }

    if (!cardDrawn) {
      flush()
      const said = yield* world.doctor().pipe(
        Effect.map((done) => ({ done }) as const),
        recovering((err) => Effect.succeed({ threw: err.message || String(err) } as const)),
      )
      if ('threw' in said) {
        world.log(`doctor did not finish — ${said.threw}`)
        fix = DOCTOR_VERBOSE
      } else {
        // `failed` counts failures only, never warnings: a fresh machine
        // nearly always warns, and `--verbose` on every first init would be noise.
        world.log(said.done.blocks)
        if (said.done.toFix.failed) fix = said.done.next ?? DOCTOR_VERBOSE
      }
    }
    let needBoard = false

    // The board is never printed about unless it refused: the card has no row for it, and
    // `next:` is what tells a person to start one.
    const started = boardSoFar()
    if (started === null) {
      // Nothing here asked for a board, but one may already be serving this
      // machine (#434 fix round) — `lingtai board` refuses by name rather than
      // confirm that, so the operator is told which is true before reaching for it.
      const running = yield* world.boardAt(port)
      needBoard = running === null
      if (!cardDrawn) {
        world.log(heading('Board'))
        world.log(
          running !== null
            ? paint.muted(`the board was already running at ${running} — this started none`)
            : paint.muted('no board was started'),
        )
      }
    } else {
      needBoard = 'refused' in started
      if (!cardDrawn) world.log(heading('Board'))
      if ('refused' in started) world.log(paint.fail(`the board did not start — ${started.refused}`))
      else if (started.started) {
        // Said on the card's paths too: it is why this terminal does not return, and how to stop it.
        world.log(
          paint.muted('the board keeps running in this terminal — ctrl-c stops it, and lingtai board starts it again'),
        )
      } else if (!cardDrawn) {
        world.log(paint.muted(`the board was already running at ${started.url} — this started none`))
      }
    }
    // The last thing printed (0121 §1): a failure closes on one line, anything else on the path's numbered block.
    if (fix !== undefined) {
      world.log(renderNextLine(fix))
    } else {
      const closing =
        here !== null
          ? hereSteps(here)
          : githubClosing !== undefined
            ? { steps: addSteps(githubClosing) }
            : { steps: github ? githubInitSteps(githubSetupUrl) : localInitSteps(needBoard) }
      if (closing.preface !== undefined) world.log(closing.preface)
      for (const line of renderNextBlock(closing.steps)) world.log(line)
    }
    return 0
  })
}

/**
 * Whether `cwd` is a registered project's checkout, an unregistered repository, or neither (#756). The rule is
 * the one `add --local` keys a project by: `basename` of `git rev-parse --show-toplevel`, case-insensitive.
 * A git failure is "not inside a repository"; a recipe that cannot be read leaves the ticket line out.
 */
function whereAmI(world: InitWorld, registered: readonly ProjectState[], home: string): Effect.Effect<Here, unknown> {
  return Effect.gen(function* () {
    const top = yield* world
      .runGit(world.cwd, ['rev-parse', '--show-toplevel'])
      .pipe(recovering(() => Effect.succeed(null)))
    if (top === null || !top.ok || top.stdout.trim() === '') return { kind: 'outside' } as const
    const toplevel = top.stdout.trim()
    const name = basename(toplevel).toLowerCase()
    const match = registered.find((p) => typeof p.project === 'string' && p.project.toLowerCase() === name)
    if (match === undefined || match.project === null) return { kind: 'unregistered', toplevel } as const
    const project = match.project
    // The effective settings, as the conductor resolves them: an omitted `tickets` is github, and kinds may sit under a `queue:`.
    let tickets: 'db' | 'github' | null = null
    let kinds: string[] = []
    let takes: IssueTakes | null = null
    yield* Effect.gen(function* () {
      const path = recipePath(project, home)
      const text = yield* recipeText(project, { home, ...(world.store === undefined ? {} : { store: world.store }) })
      if (text !== null) {
        const recipe = resolveSource(text, path, path).recipe
        tickets = ticketSourceOf(recipe)
        kinds = [...kindsOf(recipe)]
        takes = issueTakeOf(recipe)
      }
    }).pipe(
      recovering(() => {
        tickets = null
        return Effect.void
      }),
    )
    const forms =
      world.issueForms === undefined || tickets !== 'github'
        ? NO_FORMS
        : yield* world.issueForms(toplevel).pipe(Effect.catchCause(() => Effect.succeed(NO_FORMS)))
    return {
      kind: 'registered',
      project,
      tickets,
      kinds,
      takes,
      forms,
      slug: match.owner === null ? null : `${match.owner}/${match.project}`,
    } as const
  })
}

function describeSchema(schema: SchemaOutcome): string {
  if (schema.created) return `tables created (${schema.applied.length} steps)`
  return schema.repaired.length > 0 ? `tables present; put back ${schema.repaired.join(', ')}` : 'tables present'
}

/**
 * The card's line for another store (ADR 0100 §9): the log it opens is a new, empty one, and nothing was copied
 * from the old. Said only where a store was settled before this run — a first choice leaves nothing behind.
 */
function storeSwitched(into: LeftBehind[], before: ReturnType<typeof storeChoice>, now: StoreChosen): void {
  if ('refused' in before) return
  if (before.store === now.store && (before.store === 'sqlite' || (now.store === 'postgres' && before.url === now.url)))
    return
  into.push({
    what:
      `the log is a new, empty one — nothing was copied from ${describeStore(before)}, ` +
      'and every project is added again',
  })
}

/**
 * Why `--store sqlite` cannot be obeyed here, or null when it can (#345).
 *
 * **A choice the machine will not obey is refused by name, never written.**
 * One way it would not be: an exported `LINGTAI_DATABASE_URL`, which
 * `storeChoice()` reads before the file (0056 §3) — writing `sqlite` under it
 * shows SQLite and runs Postgres, which is #215. A file that already says
 * `postgres` is not refused: another store is a change, written and then said
 * (0125 §6), and the log it opens is a new, empty one (0100 §9).
 */
/** `--database-url` (or `--store postgres --database-url`) named a URL other than the exported one. */
export function exportedUrlRefusal(given: string, flag: string, from: string, exported: string): string {
  return (
    `${given} ${flag}, but ${from} names ${exported}, and ` +
    'an exported URL wins over the file. Unset it, or leave out --database-url. Nothing was written'
  )
}

/** `--store sqlite` while an exported URL says Postgres. */
export function sqliteExportedRefusal(from: string): string {
  return (
    `--store sqlite, but ${from}, and an exported URL wins over the file — this machine would ` +
    'say SQLite and run Postgres. Unset it, or leave out --store sqlite. Nothing was written'
  )
}

function sqliteRefused(world: Pick<InitWorld, 'env' | 'machine'>, path: string): string | null {
  const read = storeChoice(world.env, machineFor(world, path))
  if (!('refused' in read) && read.where === 'environment' && read.store === 'postgres') {
    return sqliteExportedRefusal(read.from)
  }
  return null
}

/**
 * What the machine says now, read back after the write — or an exit code.
 *
 * The confirmation is derived from `storeChoice()` and never composed from the
 * answer that was typed, which is how the screen and the file came apart in the
 * first place. A disagreement between them is that defect, so it is a refusal
 * naming both rather than a line nobody would read.
 */
function confirm(
  world: InitWorld,
  stop: (line: string) => number,
  path: string,
  expected: 'postgres' | 'sqlite',
): StoreChosen | number {
  const read = storeChoice(world.env, machineFor(world, path))
  if ('refused' in read || read.store !== expected) {
    return stop(`${expected} was written to ${path}, and reading it back does not say so — ${describeStore(read)}`)
  }
  return read
}

/**
 * The store is chosen and recorded, and **setup goes on from here** — null, as
 * the Postgres branch returns when its URL answered.
 *
 * It used to return 1 with an amber line, on the grounds that there was no
 * board to serve because no log opened from this choice. #179 opened one, so
 * the exit code went with the claim: a machine that is set up correctly must
 * not be told to run `init` again with a Postgres URL instead.
 *
 * There is no `world.database()` check to make first. A Postgres URL has to be
 * connected to and its tables created before anything is written; a SQLite log
 * is a file this machine will create on first open, with its own schema
 * (`openSqliteLog`), so the write above *is* the verification — and `confirm`
 * has already read the file back with the function every later command asks.
 *
 * The claim itself is `SQLITE_MACHINE`, said in one place. Muted rather than
 * amber: nothing here needs doing.
 */
/**
 * What Ctrl+C at a question after the store is written says is kept (#762).
 * `startOver` is set only on a home that had no `config.yml` and where this run
 * wrote one — the files it names are then all this run made. It never names the
 * URL: a Postgres `database.url` carries a password.
 */
export function initKept(o: { choice: StoreChoice; configPath: string; startedWithConfig: boolean; wrote: boolean }): {
  kept: string
  startOver?: string
} {
  if (o.startedWithConfig) return { kept: "this machine's store and projects are unchanged" }
  if ('refused' in o.choice) return { kept: 'the store chosen above is kept' }
  if (o.choice.store === 'postgres') {
    if (!o.wrote) return { kept: `the store is kept, Postgres, chosen by ${o.choice.from}` }
    return {
      kept: `the store is kept, Postgres, chosen in ${o.configPath}`,
      startOver: 'to start over, delete that file',
    }
  }
  const db = o.choice.path
  if (!o.wrote) return { kept: `the store is kept, SQLite at ${db}, chosen by ${o.choice.from}` }
  return {
    kept: `the store is kept, SQLite at ${db}, chosen in ${o.configPath}`,
    startOver: `to start over, delete those two files, and the -wal and -shm files beside the database if they exist`,
  }
}

function sqliteChosen(held: string[], choice: StoreChosen): null {
  heldFact(held, 'Store', [['store', paint.pass(describeStore(choice))]], paint.muted(SQLITE_MACHINE))
  return null
}

/**
 * Null when the file names no runtime; the refusal to print when it does.
 *
 * **A migration message, not a question** (`#398`): `config.yml` is not where
 * a runtime is chosen any more — each project's recipe is, asked by `lingtai
 * add`'s `agents.ts` — so a file still carrying one is a leftover from before
 * `#372` and is refused rather than read. Nothing is written either way: a
 * pure function of the file, testable on its own in `unit/`.
 */
export function machineRuntimeRefusal(config: Document, path: string): string | null {
  if (config.has('runtime') || config.has('projects')) {
    return (
      `${path} still names a runtime under runtime: or projects: — which one runs is each project's now, written ` +
      "as runtime.agent in that project's recipe (~/.lingtai/<project>/recipe.yml). Move it there, remove it " +
      'here, and run lingtai init again; nothing was written'
    )
  }
  return null
}

// ------------------------------------------------------------- live world --

export { type RawStdin, waitForKeypress }

/** The board lock this process holds while `lingtai init` serves one. See `board` below. */
let kept: HeldLock | null = null

/**
 * `InitWorld.machine` built for real — `node:fs`, exactly as `readConfig`,
 * `writeConfig` and `describeHome` did before #435 moved them behind this
 * seam. Exported so `integration/init.test.ts`'s fixture reads and writes the
 * same real `config.yml` this live world does, rather than a second
 * implementation of the same three functions.
 */
export function liveMachine(): InitWorld['machine'] {
  return {
    ...liveMachineText(),
    describeHome: (home, path) => {
      if (!existsSync(home)) return 'nothing yet'
      const said: string[] = [existsSync(path) ? 'config.yml' : 'no config.yml']
      try {
        const entries = readdirSync(home, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
        const projects = projectsOnDisk(home)
        said.push(projects.length > 0 ? `projects: ${projects.join(', ')}` : 'no projects')
        if (entries.includes('versions')) {
          const versions = readdirSync(join(home, 'versions')).filter((v) => !v.startsWith('.'))
          said.push(`versions: ${versions.join(', ') || 'none'}`)
        }
      } catch {
        // An unreadable home says only what the file check could.
      }
      return said.join(' · ')
    },
  }
}

/** A Postgres client as `database` uses it: what `createSchemaEffect` queries, and the two ends of a connection. */
export interface DatabaseClient extends Queryable {
  connect: () => PromiseLike<unknown>
  end: () => PromiseLike<unknown>
}

/**
 * Connect, and create the tables where there are none. A failure and a defect alike answer `{ ok: false, why }`
 * — `createSchemaEffect`'s failures are defects (0101 §6) — and an interruption is let through. The client is
 * ended when the check is over, however it ended, and a failure to end it is not the check's.
 */
export const databaseCheck = (
  url: string,
  open: (url: string) => Effect.Effect<DatabaseClient, unknown>,
): Effect.Effect<DatabaseCheck> =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* Effect.acquireRelease(open(url), (opened) => lift(() => opened.end()).pipe(Effect.ignore))
      yield* lift(() => client.connect())
      const schema = yield* createSchemaEffect(client)
      return { ok: true, schema } as DatabaseCheck
    }),
  ).pipe(recovering((err) => Effect.succeed({ ok: false, why: err.message || String(err) } as DatabaseCheck)))

/** `import('pg')` stays inside: a fresh machine has no store configured, and `entry.ts` keeps `init` lazy. */
const pgClient = (url: string): Effect.Effect<DatabaseClient, unknown> =>
  lift(() => import('pg')).pipe(
    Effect.map(({ default: pg }) => new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 })),
  )

export function liveInitWorld(): InitWorld {
  return {
    env: process.env,
    machine: liveMachine(),
    log: (line) => console.log(line),
    ask: liveAsk,
    spin: liveSpin,
    git: () =>
      Effect.try({
        try: () => {
          const said = spawnSync('git', ['--version'], { encoding: 'utf8' })
          return said.status === 0 ? said.stdout.trim() : null
        },
        catch: (e) => e,
      }),
    runtimes: askRuntimesEffect,
    setupReader: liveSetupReader,
    exists: pathExistsEffect,
    database: (url) => databaseCheck(url, pgClient),
    app: checkAppEffect,
    ghStatus: () => ghStatusEffect(),
    ...(refusal('', interactivity(false)) === null ? { gh: liveGh } : {}),
    appeared: pollForAppEffect,
    // Handed an aborted signal when the race it is in is lost, so raw mode is undone.
    pressed: () => Effect.tryPromise({ try: (signal) => waitForKeypress(process.stdin, signal), catch: (e) => e }),
    // A host that is not an address finds no board here, so `board` below is
    // asked and refuses it by name: the probe never answers for a setting
    // that is invalid, whatever happens to be listening on loopback.
    boardAt: (port) =>
      Effect.gen(function* () {
        let reach: string
        try {
          reach = boardReachHost(boardHost())
        } catch {
          return null
        }
        return yield* boardAtEffect(port, reach)
      }),
    board: (port) =>
      Effect.gen(function* () {
        let host: string
        try {
          host = boardHost()
        } catch (err) {
          return { refused: (err as Error).message }
        }
        // The same lock `lingtai board start` takes (#187), and for the same
        // reason: a board this process serves and no lock names is one that
        // `lingtai board status` calls nobody's and `lingtai board stop` cannot
        // stop. Held for as long as this process serves — `kept` is module scope
        // so nothing collects the handle out from under the lock.
        const taken = yield* lift(() => createFileLocker().tryLock(boardLock(port), `board on ${port}`))
        if (!taken.ok) {
          return {
            refused: `a board is already on ${port} — held by ${taken.holder ?? 'a holder that has not named itself'}`,
          }
        }
        kept = taken.lock
        // The lock's own release, never this handler's scope: the board outlives the command (`entry.ts`),
        // and a lock that will not let go is a defect, as `serveBoard`'s face made it.
        const release = lift(() => kept?.release() ?? Promise.resolve()).pipe(
          Effect.orDie,
          Effect.andThen(
            Effect.sync(() => {
              kept = null
            }),
          ),
        )
        const failed = yield* serveBoardEffect({ dir: builtBoardDir(), port, host, release }).pipe(
          Effect.as(null),
          recovering((err) => Effect.succeed(err)),
        )
        if (failed !== null) {
          yield* release
          return { refused: failed.message }
        }
        return { url: boardOrigin(boardReachHost(host), port) }
      }),
    open: (url) => lift(() => liveOpen(url)),
    runGit: liveGitEffect,
    issueForms: checkoutIssueForms,
    projects: () => loadAllProjectsEffect(),
    signedIn: signedInHere,
    registerLocal: (payload) =>
      addLocalEffect(
        { project: payload.project, base: payload.base, configHash: payload.configHash, fromSha: payload.fromSha },
        payload.resolved,
      ),
    history: liveHistoryEffect,
    sandboxHost: () => sandboxHostHere(),
    // Dynamic, never a static import of `./doctor.ts` — this file's header
    // warns that an eager log read breaks a fresh machine (`setup-end.ts` keeps that).
    doctor: liveSetupDoctorEffect,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    cwd: process.cwd(),
  }
}
