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
 *   board      started here; a browser is opened on the wizard's next screen —
 *              creating the App, or picking a repository once one answers — and
 *              a local project or a skipped App leaves one line printed instead
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
 * **Changing a store that answers is an edit, not a re-run** — 0056 left that
 * open and this settles it, for a run with no `--database-url`. A store
 * already written and connecting is reported and not asked about again:
 * re-asking would make every run of a finished `init` a chance to answer the
 * wrong way. To switch, set `database.store` in
 * `~/.lingtai/config.yml` and run `lingtai init`, which finds the half-state
 * that edit leaves — `store: sqlite` beside the old `url` — refuses it by
 * name, and completes the switch by asking. 0055 §3 is still the thing to know
 * before doing it: the other store is a new log, not the same one somewhere
 * else.
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
 * local branch folds every `prj-*` stream (`world.projects()` →
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
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { addLocal } from '@lingtai/conductor/onboard'
import { loadAllProjects, signedInHere } from '@lingtai/conductor/projects'
import { type ProjectState } from '@lingtai/domain'
import {
  SQLITE_MACHINE,
  type StoreChosen,
  boardPort,
  describeStore,
  redactUrl,
  stateDir,
  storeChoice,
} from '@lingtai/env'
import { paint } from '@lingtai/env/colour'
import { createFileLocker, type HeldLock } from '@lingtai/env/lock'
import { type SchemaOutcome, createSchema } from '@lingtai/event-store/schema'
import { diskFiles, readRecipeKey, type RecipeFiles, type SignedIn } from '@lingtai/recipe'
import { Document, isMap, parseDocument } from 'yaml'

import { checkApp, pollForApp, type AppCheck } from './app-check.ts'
import { boardAt, boardLock, builtBoardDir, serveBoard } from './board.ts'
import type { SetupReader } from './detect-setup.ts'
import {
  chooseFirstProject,
  type FirstProjectWorld,
  type GitResult,
  liveGit,
  liveSetupReader,
  type RegisterLocalPayload,
} from './first-project.ts'
import { APP_WAIT_MS, waitForApp } from './github-app.ts'
import { type RawStdin, waitForKeypress } from './keypress.ts'
import { liveAsk, question } from './question.ts'
import { askRuntimes, type RuntimeFound } from './runtimes.ts'
import { liveHistory } from './source.ts'

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
  log: (line: string) => void
  /** One line from the person. Null when nobody is at a terminal to answer. */
  ask: (question: string) => Promise<string | null>
  /** `git --version`, or null when there is no git. */
  git: () => Promise<string | null>
  /** Every runtime, asked whether it is installed and signed in. */
  runtimes: () => Promise<RuntimeFound[]>
  /** `FirstProjectWorld.setupReader` (#431) — a real directory, over `node:fs`. */
  setupReader: (dir: string) => SetupReader
  /** Connect, and create the tables where there are none. */
  database: (url: string) => Promise<DatabaseCheck>
  /** The App this machine is configured with, asked with a real call. */
  app: () => Promise<AppCheck>
  /**
   * Resolves once an App is configured and answers — written by the board's
   * first screen. Stops polling once `signal` aborts; the loser of a race.
   */
  appeared: (signal: AbortSignal) => Promise<{ slug: string; owner: string }>
  /** Resolves on any keypress at a TTY — the skip. Never, at no TTY, until `signal` aborts. */
  pressed: (signal: AbortSignal) => Promise<void>
  /**
   * A Lingtai board already answering on this port — the machine's own, from
   * `lingtai board` or the service — as its URL, or null. Asked before one is
   * started, since a second on the same port is refused.
   */
  boardAt: (port: number) => Promise<string | null>
  /** Serve the board; the process stays up for it. */
  board: (port: number) => Promise<{ url: string } | { refused: string }>
  /** Open a browser. False when none could be. */
  open: (url: string) => Promise<boolean>
  /**
   * `FirstProjectWorld.git` (#394) — named distinctly from `git` above, which
   * answers `git --version` rather than running a command in a directory.
   */
  runGit: (dir: string, args: readonly string[]) => Promise<GitResult>
  /** `loadAllProjects` — registered and pending alike, keyed by name (#394). */
  projects: () => Promise<readonly ProjectState[]>
  files: RecipeFiles
  signedIn: SignedIn
  /** `FirstProjectWorld.register` for the local branch — appends `ProjectConfigured`. */
  registerLocal: (payload: RegisterLocalPayload) => Promise<string>
  /** `FirstProjectWorld.history` (#396) — `wi-<project>-*` streams already in the log for this project. */
  history: (project: string) => Promise<readonly string[]>
}

const USAGE =
  'lingtai init [--store sqlite|postgres] [--database-url <postgres url>] [--port <n>] ' +
  '[--project github|local] [--local <dir>] [--base <branch>] [--github-app create|skip] ' +
  '[--agent <id>] [--model <id>] [--reviewer <id>] [--reviewer-model <id>] [--install <cmd>] ' +
  '[--build <cmd>] [--tickets github|db] [--kinds <a,b,c>] [--land <branch>] [--rounds <n>] ' +
  '[--wall <duration>] [--budget <amount>] [--defaults]'

/** What `--store` names: the store question answered from the command line, as the person at a terminal would. */
type StoreFlag = 'postgres' | 'sqlite'

// ---------------------------------------------------------- config.yml --

export function configPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), 'config.yml')
}

/** The machine file as a document, so a write keeps every comment and key it did not choose. */
function readConfig(path: string): Document | { refused: string } {
  if (!existsSync(path)) return new Document({})
  const doc = parseDocument(readFileSync(path, 'utf8'))
  if (doc.errors.length > 0) {
    return { refused: `${path} does not parse as YAML (${doc.errors[0]!.message}) — fix it and run lingtai init again` }
  }
  if (doc.contents === null) return new Document({})
  if (!isMap(doc.contents)) return { refused: `${path} is not a mapping — fix it and run lingtai init again` }
  return doc
}

/**
 * Beside, then renamed over: an interruption mid-write leaves the old file or
 * the new one, never half of either. `0600`, because a database URL carries its
 * password.
 */
function writeConfig(path: string, doc: Document, home: string): void {
  mkdirSync(home, { recursive: true })
  const partial = `${path}.${process.pid}.partial`
  writeFileSync(partial, doc.toString(), { mode: 0o600 })
  chmodSync(partial, 0o600)
  renameSync(partial, path)
}

/**
 * A URL fit to print: the password is never shown.
 *
 * `@lingtai/env`'s, because the store's own refusals quote a `database.url`
 * too — one redaction, so there is one place a password could escape from.
 */
export { redactUrl as redact } from '@lingtai/env'

// ------------------------------------------------------------ the command --

function parseArgs(
  argv: readonly string[],
): { flags: Record<string, string>; repeated: Record<string, string[]> } | { refused: string } {
  const flags: Record<string, string> = {}
  const repeated: Record<string, string[]> = {}
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]!
    if (
      ![
        '--store',
        '--database-url',
        '--port',
        '--project',
        '--local',
        '--base',
        '--github-app',
        '--agent',
        '--model',
        '--reviewer',
        '--reviewer-model',
        '--install',
        '--build',
        '--tickets',
        '--kinds',
        '--land',
        '--rounds',
        '--wall',
        '--budget',
        '--defaults',
      ].includes(name)
    )
      return { refused: `${USAGE} — no ${name}` }
    // The one boolean flag here: without this branch, `--defaults` would
    // read the next token as its own value — another flag, which is then
    // refused by name instead of parsed (`--defaults --store sqlite` would
    // refuse "no sqlite"), or nothing, which is refused as `--defaults takes
    // a value` (#433).
    if (name === '--defaults') {
      flags['defaults'] = ''
      ;(repeated['defaults'] ??= []).push('')
      continue
    }
    const value = argv[i + 1]
    if (value === undefined) return { refused: `${USAGE} — ${name} takes a value` }
    flags[name.slice(2)] = value
    ;(repeated[name.slice(2)] ??= []).push(value)
    i++
  }
  return { flags, repeated }
}

function refuse(world: Pick<InitWorld, 'log'>, line: string, code = 1): number {
  world.log(paint.fail(line))
  return code
}

export async function initCommand(argv: readonly string[], world: InitWorld): Promise<number> {
  const parsed = parseArgs(argv)
  if ('refused' in parsed) return refuse(world, parsed.refused, 2)
  const { flags, repeated } = parsed
  const buildFlags = repeated['build'] ?? []
  const asked = flags['port'] === undefined ? null : Number(flags['port'])
  if (asked !== null && (!Number.isInteger(asked) || asked <= 0))
    return refuse(world, `${USAGE} — --port takes a port number`, 2)
  const named = flags['store'] ?? null
  if (named !== null && named !== 'sqlite' && named !== 'postgres')
    return refuse(world, `${USAGE} — --store takes sqlite or postgres`, 2)
  // Two stores named in one command: neither is guessed at, and nothing is written (#345).
  if (named === 'sqlite' && flags['database-url'] !== undefined) {
    return refuse(
      world,
      `${USAGE} — --store sqlite and --database-url name two different stores. Nothing was written`,
      2,
    )
  }

  const home = stateDir(world.env)
  const path = configPath(world.env)

  // ---- look -----------------------------------------------------------------
  world.log(paint.accent('looking before asking'))
  const git = await world.git()
  world.log(git ? `  git          ${git}` : paint.fail('  git          not on PATH'))
  const runtimes = await world.runtimes()
  for (const r of runtimes) {
    const state = !r.installed ? 'not installed' : r.signedIn ? r.detail : `installed, not signed in — ${r.detail}`
    world.log(`  ${r.id.padEnd(12)} ${state}`)
  }
  world.log(`  ${'home'.padEnd(12)} ${home} — ${describeHome(home, path)}`)
  if (!git) {
    return refuse(
      world,
      'git is not on PATH — the mirror and the worktrees are git. Install it and run lingtai init again; nothing was written',
    )
  }

  const config = readConfig(path)
  if ('refused' in config) return refuse(world, config.refused)

  // ---- the store ------------------------------------------------------------
  const store = await chooseStore(world, config, path, home, flags['database-url'] ?? null, named)
  if (store !== null) return store

  // ---- the agent --------------------------------------------------------
  // Which runtime runs is each project's question now (`#372`, `#398`),
  // asked by `lingtai add`'s `agents.ts` — never here. This still refuses a
  // `config.yml` naming one: that is a migration message for a file written
  // before `#372`, not a question `init` is asking.
  const agentRefusal = machineRuntimeRefusal(config, path)
  if (agentRefusal !== null) return refuse(world, agentRefusal)

  // ---- the App --------------------------------------------------------------
  const app = await world.app()
  if (app.configured && !app.ok) {
    return refuse(
      world,
      `the GitHub App configured here does not answer — ${app.why}. A second App is not created beside it: ` +
        'fix its credentials, or remove them, and run lingtai init again',
    )
  }
  world.log(
    app.configured
      ? paint.pass(`app          ${app.slug}, owned by ${app.owner} — it answered`)
      : "app          none yet — the board's first screen creates it through GitHub's manifest flow",
  )

  // ---- which project ---------------------------------------------------------
  // Registering a project *is* the record of the answer (#394) — nothing
  // machine-wide holds "local" or "github". A machine that already has
  // projects is told what it has and how to add another, rather than asked
  // the question again; an explicit --project or --local names what to do
  // next and reopens the question on one. (`--github` is `lingtai add`'s own
  // flag, not `init`'s — `parseArgs` above refuses it, so a GitHub project
  // here is always named through `--project github` instead; checking for it
  // below was dead, since it could never be set.)
  const explicitChoice = flags['project'] !== undefined || flags['local'] !== undefined
  // Whether the project question is asked at all this run — false when the
  // machine already has projects and nothing named which to add, so the
  // question is not asked again (below), only answered by what is printed
  // here (#394's finding 3: this must not itself end the run — the board
  // still has to start, and the port flag still has to be obeyed).
  let askProject = true
  if (!explicitChoice) {
    const registered = await world.projects()
    if (registered.length > 0) {
      for (const p of registered) {
        if (p.owner !== null) {
          world.log(`  ${p.owner}/${p.project} — github`)
          continue
        }
        // `owner: null` is a local project, and also a GitHub one registered
        // before `ProjectConfigured` carried an owner (#352's `unrecorded`):
        // only the remote a local registration writes tells the two apart.
        const remote =
          p.project === null ? null : await readRecipeKey(p.project, ['repo', 'remote'], { home, files: world.files })
        world.log(
          typeof remote === 'string'
            ? `  ${p.project} — local, ${remote}`
            : `  ${p.project} — owner not recorded; lingtai add <owner>/${p.project} records it`,
        )
      }
      world.log(
        paint.muted(
          'lingtai add asks GitHub-or-directory for another project; lingtai init --project github sets up ' +
            'the GitHub App on a machine that has only local projects',
        ),
      )
      // Nothing below here reaches `chooseFirstProject`, so nothing reads any
      // of these flags — refused by name instead of silently discarded, the
      // same reason `runGithubBranch`'s own guard exists (#396 fix round,
      // finding 3; #431 fix round, finding 1 — the ten `askRecipe` flags got
      // no equivalent guard here, and this path never reaches
      // `runGithubBranch`'s own).
      const discardedFlag = [
        'tickets',
        'kinds',
        'agent',
        'model',
        'reviewer',
        'reviewer-model',
        'install',
        'build',
        'land',
        'rounds',
        'wall',
        'budget',
      ].find((name) => flags[name] !== undefined)
      if (discardedFlag !== undefined) {
        return refuse(
          world,
          `--${discardedFlag} ${flags[discardedFlag]}, but this machine already has a project and none is named ` +
            'to set up here — pass --project github, --project local, or --local <dir>, or use lingtai add for ' +
            'one that already exists. The store chosen above is kept',
        )
      }
      askProject = false
    }
  }

  // ---- the board, on the wizard ---------------------------------------------
  // The port is decided here and not at the top: `board.port` is read out of
  // the same file `readConfig` above refuses by name, and a file that does not
  // parse should say so once, in its own words, rather than through the port.
  const port = asked ?? boardPort(world.env)
  // A board already up is this machine's, and the wizard is on it: a re-run uses it rather than failing on its port.
  const running = await world.boardAt(port)
  const board = running !== null ? { url: running } : await world.board(port)
  if ('refused' in board) {
    return refuse(
      world,
      `the board did not start — ${board.refused}. Everything chosen above is kept, and lingtai init again continues from here`,
    )
  }

  if (askProject) {
    // Built from `world` directly rather than through a live default (#394's
    // finding 6): every seam `chooseFirstProject` reaches for — `git`, the
    // log, the recipe files, the App — is the one this test or process was
    // handed, never `checkApp`, `loadAllProjects`, a bare `stateDir()` or
    // `diskFiles` reached for underneath it.
    const firstProjectWorld: FirstProjectWorld = {
      ask: world.ask,
      log: world.log,
      git: world.runGit,
      projects: world.projects,
      files: world.files,
      home,
      signedIn: world.signedIn,
      // Already probed above, for the "look" lines — a second probe for the
      // same run would ask every runtime whether it is signed in twice.
      runtimes: async () => runtimes,
      setupReader: world.setupReader,
      register: world.registerLocal,
      history: world.history,
      // The store above is already written by the time this runs — the same
      // reason `askFirstProject` carries this sentence (#394 finding 2).
      kept: 'the store chosen above is kept',
      // `init`'s only (first-project.ts): a configured App already answers
      // *is the project*, and `--project`/`--github-app` naming anything else
      // is refused rather than asked past.
      githubAppIsTheProject: true,
      github: {
        // Already fetched above, for the "the App" line — a second real call
        // (`GET /app`) for the same run would answer the same question twice.
        app: async () => app,
        boardUrl: async () => board.url,
        waitForApp: (boardUrl) =>
          waitForApp({ log: world.log, open: world.open, appeared: world.appeared, pressed: world.pressed }, boardUrl, {
            waitMs: APP_WAIT_MS,
          }),
        // `init` never gives `chooseFirstProject` a slug — `--github` is
        // `lingtai add`'s own flag, refused by `parseArgs` above, so
        // `runGithubBranch`'s `givenSlug` is always null here and returns
        // before either of these runs (#394's dead-seam finding: `InitWorld`
        // used to carry a `picker` and an `addGithub` that nothing called).
        picker: () => {
          throw new Error('unreachable: lingtai init never gives chooseFirstProject a slug')
        },
        add: () => {
          throw new Error('unreachable: lingtai init never gives chooseFirstProject a slug')
        },
      },
    }
    const chosen = await chooseFirstProject(firstProjectWorld, flags, buildFlags)
    if ('refused' in chosen) return refuse(world, chosen.refused)

    if (chosen.project === 'local') {
      world.log(paint.pass(`project      local — ${chosen.name}, registered with its own origin as repo.remote`))
    } else if (chosen.app === 'already') {
      const wizard = `${board.url}/setup/repository`
      world.log(
        (await world.open(wizard))
          ? paint.pass(`opened ${wizard}`)
          : paint.signal(`no browser could be opened here — open ${wizard}`),
      )
    } else if ('made' in chosen.app) {
      world.log(`next, install it and pick a repository: ${board.url}/setup/repository`)
    }
    // `skipped` and `timedOut` are already logged by `chooseFirstProject`'s own
    // call to `waitForApp` (`appComeBackLine`).
  } else if (app.configured) {
    // Nothing new was asked — the machine already has projects, told above —
    // but a configured App still has its one remaining screen: the wizard
    // that picks a repository for it.
    const wizard = `${board.url}/setup/repository`
    world.log(
      (await world.open(wizard))
        ? paint.pass(`opened ${wizard}`)
        : paint.signal(`no browser could be opened here — open ${wizard}`),
    )
  }

  world.log(
    running !== null
      ? paint.muted(`the board was already running at ${running} — this started none`)
      : paint.muted('the board keeps running in this terminal — ctrl-c stops it, and lingtai board starts it again'),
  )
  return 0
}

function describeHome(home: string, path: string): string {
  if (!existsSync(home)) return 'nothing yet'
  const said: string[] = [existsSync(path) ? 'config.yml' : 'no config.yml']
  try {
    const entries = readdirSync(home, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
    const projects = entries.filter((name) => existsSync(join(home, name, 'recipe.yml')))
    said.push(projects.length > 0 ? `projects: ${projects.join(', ')}` : 'no projects')
    if (entries.includes('versions')) {
      const versions = readdirSync(join(home, 'versions')).filter((v) => !v.startsWith('.'))
      said.push(`versions: ${versions.join(', ') || 'none'}`)
    }
  } catch {
    // An unreadable home says only what the file check could.
  }
  return said.join(' · ')
}

function describeSchema(schema: SchemaOutcome): string {
  if (schema.created) return `tables created (${schema.applied.length} steps)`
  return schema.repaired.length > 0 ? `tables present; put back ${schema.repaired.join(', ')}` : 'tables present'
}

/**
 * Null once the store is settled; an exit code when it cannot be.
 *
 * **Choosing is an edit** (0056, #215): each answer is written as `store` and a
 * `url` that agrees with it, and the other store's value is taken out in the
 * same write. Then the file is read back with `storeChoice()` — the function a
 * later command asks — and *that* is what is printed, so the line at the end of
 * setup is a reading of the machine rather than a report of what was typed.
 */
async function chooseStore(
  world: InitWorld,
  config: Document,
  path: string,
  home: string,
  flag: string | null,
  named: StoreFlag | null,
): Promise<number | null> {
  // `--store sqlite` is refused, before anything else is looked at, wherever
  // the machine would not obey it — writing it there would be #215 again.
  if (named === 'sqlite') {
    const refused = sqliteRefused(world, config, path)
    if (refused !== null) return refuse(world, refused)
  }

  // `--database-url` given as the empty string names nothing to connect to,
  // with or without --store postgres beside it: unlike flag === null, it is
  // not the question's business to answer, because reading it as the
  // question's own empty answer would silently rewrite a settled Postgres
  // machine to SQLite with no connection attempted (the only thing a flag
  // given to be explicit should never do, #392). This runs ahead of the
  // exported-URL check below, so an empty flag is refused for what it is
  // rather than reported as naming a database the export does not.
  if (flag !== null && flag.trim() === '') {
    const given = named === 'postgres' ? '--store postgres --database-url' : '--database-url'
    return refuse(
      world,
      `${USAGE} — ${given} takes a postgres:// URL. Leave it out entirely for SQLite. Nothing was written`,
      2,
    )
  }

  // An exported LINGTAI_DATABASE_URL decides and supplies the URL (0056 §3),
  // and nothing is written for it: it is the process's answer, not the file's,
  // and this command does not own the process a daemon will be started in.
  const preset = storeChoice(world.env)
  if (!('refused' in preset) && preset.where === 'environment' && preset.store === 'postgres') {
    // `--database-url` naming a database the exported URL does not is a
    // choice this process would not obey — whether or not `--store postgres`
    // named it too: refused, rather than connecting to the other one and
    // reporting it as though it were what was asked (naming the same database
    // is that same run; naming another is refused, never ignored).
    if (flag !== null && flag.trim() !== preset.url) {
      const given = named === 'postgres' ? '--store postgres --database-url' : '--database-url'
      return refuse(
        world,
        `${given} ${redactUrl(flag)}, but ${preset.from} names ${redactUrl(preset.url)}, and ` +
          'an exported URL wins over the file (0056 §3). Unset it, or leave out --database-url. Nothing was written',
      )
    }
    const check = await world.database(preset.url)
    if (!check.ok) {
      return refuse(
        world,
        `the database ${preset.from} names, ${redactUrl(preset.url)}, does not answer — ${check.why}. ` +
          "It is not this command's to replace: fix it, or remove it, and run lingtai init again",
      )
    }
    world.log(paint.pass(`store        ${describeStore(preset)} · ${describeSchema(check.schema)}`))
    return null
  }

  // `--store postgres` names the store and the URL comes from `--database-url`.
  // Without one at all there is nothing to connect to, and the question it
  // would fall back on is not a Postgres question: its empty answer is
  // SQLite. (An empty `--database-url` is refused above, ahead of the
  // exported-URL check, rather than here.)
  if (named === 'postgres' && flag === null) {
    return refuse(
      world,
      `${USAGE} — --store postgres takes --database-url <postgres url>, or an exported LINGTAI_DATABASE_URL. Nothing was written`,
      2,
    )
  }

  // `--database-url <url>` is a given answer that bypasses what follows
  // entirely — settled, inherited and the question alike — so that a URL
  // that fails to connect refuses on its own account rather than falling
  // through to whatever the file already says. That holds whether or not
  // `--store postgres` named it too: a flag given without `--store` is still
  // a flag, not silently discarded because nothing named the store.
  if (flag === null) {
    // The settled-store check runs once: a machine already answering is
    // reported and not asked about again (this file's header).
    const settled = storeChoice(world.env)
    if (!('refused' in settled)) {
      if (settled.store === 'sqlite') return sqliteChosen(world, settled)
      const check = await world.database(settled.url)
      if (check.ok) {
        world.log(paint.pass(`store        ${describeStore(settled)} · ${describeSchema(check.schema)}`))
        return null
      }
      world.log(paint.fail(`store        ${describeStore(settled)} does not answer — ${check.why}`))
    } else if (settled.because === 'unreadable') {
      // `readConfig` refused this already; it is here because the two readers
      // are separate and one of them must not be the only one that looks.
      return refuse(world, settled.refused)
    } else {
      // *Nothing chosen* is the question this command is about to ask, so it
      // is asked rather than reported — a refusal naming `lingtai init` is
      // absurd inside `lingtai init`. The other two are a file being
      // repaired, and what was wrong with it is said before asking again.
      if (settled.because !== 'nothing chosen') world.log(paint.fail(settled.refused))

      // The inherited-URL check runs once, ahead of the question, and never
      // through the seam: a machine set up before the store was a written
      // value (#186) has a `database.url` and no `store`. That URL is the
      // choice nobody recorded — it is verified and recorded, not asked for,
      // and tried only this once. Taking it again on the next pass would be a
      // loop that never reaches the question, since what makes it
      // inheritable — a `url` with no `store` — is still true after it failed.
      const older = config.getIn(['database', 'url'])
      if (settled.because === 'nothing chosen' && typeof older === 'string' && older !== '') {
        const check = await world.database(older)
        if (check.ok) {
          config.setIn(['database', 'store'], 'postgres')
          config.setIn(['database', 'url'], older)
          writeConfig(path, config, home)
          const read = confirm(world, path, 'postgres')
          if (typeof read === 'number') return read
          world.log(paint.pass(`store        ${describeStore(read)} · ${describeSchema(check.schema)}`))
          return null
        }
        world.log(paint.fail(`${redactUrl(older)} does not answer — ${check.why}`))
      }
    }
  }

  // Everything settled or inherited failed to answer the question, so one
  // question is asked — `--store sqlite` is the empty answer, given in
  // advance, with no terminal needed to give it (#345).
  let schema: SchemaOutcome | null = null
  const result = await question(world, {
    name: 'the store',
    flag: '--store sqlite, or --store postgres --database-url <url>',
    given: named === 'sqlite' ? '' : flag,
    prompt: 'a Postgres URL for the log — empty for SQLite',
    fallback: '',
    show: redactUrl,
    validate: async (answer) => {
      if (answer === '') return null
      if (!/^postgres(ql)?:\/\//.test(answer)) {
        return 'that is not a Postgres URL — it begins postgres:// or postgresql://. Nothing was written'
      }
      const check = await world.database(answer)
      if (!check.ok) return `${redactUrl(answer)} does not answer — ${check.why}. Nothing was written`
      schema = check.schema
      return null
    },
  })
  if ('refused' in result) return refuse(world, result.refused)

  if (result.answer === '') {
    // The SQLite choice, written — and `database.url` removed in the same
    // write. Left behind it would go on selecting Postgres under a screen
    // that had just said SQLite, which is the whole of #215.
    config.setIn(['database', 'store'], 'sqlite')
    config.deleteIn(['database', 'url'])
    writeConfig(path, config, home)
    const read = confirm(world, path, 'sqlite')
    return typeof read === 'number' ? read : sqliteChosen(world, read)
  }

  config.setIn(['database', 'store'], 'postgres')
  config.setIn(['database', 'url'], result.answer)
  writeConfig(path, config, home)
  const read = confirm(world, path, 'postgres')
  if (typeof read === 'number') return read
  world.log(paint.pass(`store        ${describeStore(read)} · ${describeSchema(schema!)}`))
  return null
}

/**
 * Why `--store sqlite` cannot be obeyed here, or null when it can (#345).
 *
 * **A choice the machine will not obey is refused by name, never written.**
 * Three ways it would not be:
 *
 * - an exported `LINGTAI_DATABASE_URL`, which `storeChoice()` reads before the
 *   file (0056 §3) — writing `sqlite` under it shows SQLite and runs Postgres,
 *   which is #215;
 * - a file that already says `postgres`, with its URL or without one — taking
 *   the other store is a new, empty log rather than this one moved (0055 §3),
 *   and changing a store is an edit, not a re-run (this file's header);
 * - a `database.url` with no store written beside it, which is a Postgres log
 *   set up before the store was a written value (#186): the question adopts
 *   that URL, and a flag must not silently drop it instead.
 *
 * `store: sqlite` beside a `url` is **not** refused: that is the half-state the
 * documented switch leaves, and the empty answer completes it in the same way.
 */
function sqliteRefused(world: Pick<InitWorld, 'env'>, config: Document, path: string): string | null {
  const read = storeChoice(world.env)
  // The way through, and it works with no terminal: the edit leaves the
  // two-keys half-state, which `--store sqlite` completes.
  const edit =
    'another store is a new, empty log rather than this one moved (0055 §3), so changing it is an edit and not a ' +
    `flag: set database.store: sqlite in ${path}, then run lingtai init --store sqlite again. Nothing was written`
  if (!('refused' in read) && read.where === 'environment' && read.store === 'postgres') {
    return (
      `--store sqlite, but ${read.from}, and an exported URL wins over the file (0056 §3) — this machine would ` +
      'say SQLite and run Postgres. Unset it, or leave out --store sqlite. Nothing was written'
    )
  }
  if (('refused' in read && read.because === 'no url') || (!('refused' in read) && read.store === 'postgres')) {
    return `--store sqlite, but ${path} already says database.store: postgres — ${edit}`
  }
  // A `url` with no store this command can read beside it — none, or a value
  // that is neither name — is what the question would adopt as Postgres (#186).
  const older = config.getIn(['database', 'url'])
  if ('refused' in read && read.because === 'nothing chosen' && typeof older === 'string' && older !== '') {
    return `--store sqlite, but ${path} names database.url: ${redactUrl(older)} and no valid database.store beside it — ${edit}`
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
function confirm(world: InitWorld, path: string, expected: 'postgres' | 'sqlite'): StoreChosen | number {
  const read = storeChoice(world.env)
  if ('refused' in read || read.store !== expected) {
    return refuse(
      world,
      `${expected} was written to ${path}, and reading it back does not say so — ${describeStore(read)}`,
    )
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
function sqliteChosen(world: Pick<InitWorld, 'log'>, choice: StoreChosen): null {
  world.log(paint.pass(`store        ${describeStore(choice)}`))
  world.log(paint.muted(SQLITE_MACHINE))
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

export function liveInitWorld(): InitWorld {
  return {
    env: process.env,
    log: (line) => console.log(line),
    ask: liveAsk,
    git: async () => {
      const said = spawnSync('git', ['--version'], { encoding: 'utf8' })
      return said.status === 0 ? said.stdout.trim() : null
    },
    runtimes: askRuntimes,
    setupReader: liveSetupReader,
    database: async (url) => {
      const pg = (await import('pg')).default
      const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 })
      try {
        await client.connect()
        return { ok: true, schema: await createSchema(client) }
      } catch (err) {
        return { ok: false, why: (err as Error).message || String(err) }
      } finally {
        await client.end().catch(() => {})
      }
    },
    app: checkApp,
    appeared: pollForApp,
    pressed: (signal) => waitForKeypress(process.stdin, signal),
    boardAt,
    board: async (port) => {
      const host = '127.0.0.1'
      // The same lock `lingtai board start` takes (#187), and for the same
      // reason: a board this process serves and no lock names is one that
      // `lingtai board status` calls nobody's and `lingtai board stop` cannot
      // stop. Held for as long as this process serves — `kept` is module scope
      // so nothing collects the handle out from under the lock.
      const taken = await createFileLocker().tryLock(boardLock(port), `board on ${port}`)
      if (!taken.ok) {
        return {
          refused: `a board is already on ${port} — held by ${taken.holder ?? 'a holder that has not named itself'}`,
        }
      }
      kept = taken.lock
      try {
        await serveBoard({ dir: builtBoardDir(), port, host })
      } catch (err) {
        await kept.release()
        kept = null
        return { refused: (err as Error).message }
      }
      return { url: `http://${host}:${port}` }
    },
    open: (url) =>
      new Promise((resolve) => {
        const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
        const child = spawn(opener, [url], { stdio: 'ignore', detached: true })
        child.once('error', () => resolve(false))
        child.once('spawn', () => {
          child.unref()
          resolve(true)
        })
      }),
    runGit: liveGit,
    projects: () => loadAllProjects(),
    files: diskFiles,
    signedIn: signedInHere,
    registerLocal: (payload) =>
      addLocal(
        { project: payload.project, base: payload.base, configHash: payload.configHash, fromSha: payload.fromSha },
        payload.resolved,
        (line) => console.log(line),
      ),
    history: liveHistory,
  }
}
