import { existsSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { isSea } from 'node:sea'
import { pathToFileURL } from 'node:url'
import { constants, Script } from 'node:vm'

import { boardHost, boardOrigin, boardPort, boardReachHost, machineOtlpEndpoint, repoRoot } from '@lingtai/env'
import type { FileLocker, HeldLock } from '@lingtai/env/lock'
import { Cause, Effect, Option } from 'effect'

import { lift } from './exit.ts'
import { symbol, keyValues, heading } from './output.ts'
import { BOARD_JOB, BOARD_WAIT_MS, UNLOAD_WAIT_MS, type Exec, type Keeper } from './service.ts'

/**
 * The built board, served from this process (#183).
 *
 * `pnpm build` puts the board beside the CLI bundle as Next's `standalone`
 * output — `dist/lingtai.cjs` and `dist/board/` — and a monorepo keeps the
 * workspace path, so the entry is `board/apps/board/server.js`.
 *
 * **`import()`, never `require()`.** The board's `server.js` is ESM (its
 * package is `"type": "module"`) and the bundle is CJS, because a SEA's main is.
 * A dynamic `import()` is the one way across that Node promises, and it is what
 * `apps/release/integration/build.test.ts` runs rather than asserts.
 */
export function boardEntry(dir: string): string {
  return join(dir, 'apps', 'board', 'server.js')
}

/**
 * A Lingtai board already answering on `port` — this machine's own, from
 * `lingtai init`, `lingtai board` or the service — as its URL, or null.
 *
 * Checked by the board's own title, so a port some other server holds is not
 * mistaken for it (#394 reuses this for `lingtai add`, which starts no board
 * of its own and must find one already running or refuse by name).
 */
export const boardAtEffect = (port: number, reach: string): Effect.Effect<string | null> => {
  const url = boardOrigin(reach, port)
  return Effect.tryPromise(() =>
    fetch(`${url}/setup/github-app`, { signal: AbortSignal.timeout(5000) })
      .then((res) => res.text())
      .then((body) => (body.includes('<title>Lingtai</title>') ? url : null)),
  ).pipe(Effect.orElseSucceed(() => null))
}

/** `boardAtEffect`, for the callers that are still promises. */
export function boardAt(port: number, reach: string): Promise<string | null> {
  return Effect.runPromise(boardAtEffect(port, reach))
}

/**
 * Where `pnpm build` put the board — **two places, because there are two ways
 * to be running**.
 *
 * Beside the file this was bundled into, first: bundled,
 * `import.meta.filename` is the bundle's — or the binary's, which
 * `apps/release/src/build.ts` makes it inside a SEA.
 *
 * **Then `<root>/dist/board`, which is the only one a source checkout has**
 * (#187). Run from source there is nothing beside `apps/cli/src`, and
 * `lingtai service`'s board job runs exactly that path — `keeper` asserts
 * `<root>/apps/cli/src/lingtai.ts` — so a `builtBoardDir` that looked only
 * beside itself made the installed job a thing that exits at once and is
 * respawned every thirty seconds for ever. `pnpm build` writes `dist/` at the
 * checkout root (`apps/release/src/build.ts`), and a board there is a board.
 *
 * Where neither holds one, the first is returned: `serveBoard` names it, and
 * beside-the-CLI is what a reader of a shipped install expects to be told.
 */
export function builtBoardDir(self: string = import.meta.filename, root: string = repoRoot()): string {
  const beside = join(dirname(self), 'board')
  if (existsSync(boardEntry(beside))) return beside
  const built = join(root, 'dist', 'board')
  return existsSync(boardEntry(built)) ? built : beside
}

/**
 * The board's port, or why there is none — **a value and never a throw**.
 *
 * `boardPort()` refuses a `board.port` that is not a port number, which is
 * right for `lingtai board`, whose whole subject is the board, and wrong for
 * everything else. Read where a `ServiceOptions` is built, one typo in a UI
 * setting threw before `serviceCommand` was entered (#187): `lingtai service
 * shutdown "moving the database"` drained nothing, unloaded nothing, and said
 * one thing, about the board's port. The conductor is not held up by the UI's
 * port, so the refusal is carried as a fact for the board's own leg to report.
 */
export function boardPortOrWhy(
  env: NodeJS.ProcessEnv = process.env,
): { port: number; reach: string } | { why: string } {
  try {
    return { port: boardPort(env), reach: boardReachHost(boardHost(env)) }
  } catch (err) {
    return { why: (err as Error).message }
  }
}

export interface BoardOptions {
  dir: string
  port: number
  host: string
  /** Lets go of the board lock; the caller holds it, so the caller supplies this. */
  release: Effect.Effect<void>
}

/** `BoardOptions` for `serveBoard`, whose callers still hold the lock in a promise. */
export interface BoardOptionsPromise extends Omit<BoardOptions, 'release'> {
  release: () => Promise<void>
}

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))

/** What `serveBoardWith` does IO through — a record so a unit test can fail one step. */
export interface ServeDeps {
  exists: (path: string) => boolean
  checkTelemetry: () => void
  portIsFree: (host: string, port: number) => Effect.Effect<void, Error>
  importFile: (url: string) => Effect.Effect<unknown, Error>
  listening: (host: string, port: number) => Effect.Effect<void, Error>
  installStopOnSignal: (release: () => Promise<void>) => void
}

/**
 * Start the board in this process. Resolves once the server is listening; the
 * server keeps the process alive after that.
 *
 * `server.js` reads `PORT` and `HOSTNAME` from the environment and nothing
 * else, and `chdir`s into its own directory. The host is always set: 0008's
 * board has no auth, and it serves `board.host` — every address by default, `0.0.0.0` (0111 §2) — so
 * Next's own default is never what decides where it listens.
 *
 * **Loading `server.js` is not listening.** Its `startServer` is not awaited, so
 * `import()` settles before the port is bound, and a port somebody else holds
 * only surfaces afterwards, as Next's own `EADDRINUSE` and `process.exit(1)`.
 * So the port is taken and let go first — a refusal before anything is loaded —
 * and this resolves only once a connection to it is answered.
 *
 * **`NEXT_MANUAL_SIG_HANDLE` is set before the `import()`** because Next reads
 * it inside `startServer` (`start-server.js:387`), which `server.js` starts and
 * does not await: set afterwards, Next has already installed its own SIGINT and
 * SIGTERM `cleanup`, which waits for every open connection and so never ends
 * while a page's event stream is open (#726). It is deleted once the server is
 * listening, since git, agents and a managed project's own `next` inherit this
 * process's environment and would otherwise install no handler either.
 */
export const serveBoardWith =
  (deps: ServeDeps) =>
  (options: BoardOptions): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      // The handler runs from a Node signal callback, so it carries this fiber's services.
      const context = yield* Effect.context()
      const entry = boardEntry(options.dir)
      if (!deps.exists(entry)) {
        return yield* Effect.fail(
          new Error(
            `no built board at ${entry}. pnpm build writes one into dist/; from the source, pnpm --filter @lingtai/board dev`,
          ),
        )
      }
      // A bad telemetry endpoint is refused by name before anything is loaded (#775).
      yield* Effect.try({ try: deps.checkTelemetry, catch: toError })
      yield* deps.portIsFree(options.host, options.port)
      const reach = boardReachHost(options.host)
      process.env['PORT'] = String(options.port)
      process.env['HOSTNAME'] = options.host
      process.env['NEXT_MANUAL_SIG_HANDLE'] = '1'
      yield* deps.importFile(pathToFileURL(entry).href).pipe(
        Effect.andThen(deps.listening(reach, options.port)),
        Effect.ensuring(
          Effect.sync(() => {
            delete process.env['NEXT_MANUAL_SIG_HANDLE']
          }),
        ),
      )
      // Installed only once the board is up: on a failure the caller releases the
      // lock itself, and before that Node's default ends the process.
      deps.installStopOnSignal(() => Effect.runPromiseWith(context)(options.release))
    })

/** A release that hangs must not break the two seconds `board stop` allows. */
const RELEASE_BUDGET_MS = 1000

/**
 * The handler for SIGINT and SIGTERM while a board is served: release the lock,
 * say so, exit 130 or 143 (what Next's own `cleanup` exited with). A second
 * signal exits at once. Exiting drops every open connection.
 *
 * **It exits the process for every SIGINT**, so a path that serves the board
 * and then hands the terminal to a child that must survive Ctrl+C has to deal
 * with that.
 */
export function stopOnSignal(deps: {
  release: () => Promise<void>
  exit: (code: number) => void
  say: (line: string) => void
}): (signal: 'SIGINT' | 'SIGTERM') => void {
  let stopping = false
  return (signal) => {
    const code = signal === 'SIGINT' ? 130 : 143
    if (stopping) {
      deps.exit(code)
      return
    }
    stopping = true
    deps.say(`${signal}: stopped the board\n`)
    let timer: NodeJS.Timeout | undefined
    const capped = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, RELEASE_BUDGET_MS)
    })
    const released = Promise.resolve()
      .then(() => deps.release())
      .catch(() => {})
    void Promise.race([released, capped]).then(() => {
      clearTimeout(timer)
      deps.exit(code)
    })
  }
}

let signalsInstalled = false

function installStopOnSignal(release: () => Promise<void>): void {
  if (signalsInstalled) return
  signalsInstalled = true
  const handle = stopOnSignal({
    release,
    exit: (code) => process.exit(code),
    say: (line) => process.stderr.write(line),
  })
  process.on('SIGINT', () => handle('SIGINT'))
  process.on('SIGTERM', () => handle('SIGTERM'))
}

/**
 * `import()`, from wherever this is running.
 *
 * **Inside a SEA (#185) a plain `import()` only reaches built-in modules** — the
 * embedder's loader answers `No such built-in module: file:///…/server.js` — so
 * there it is compiled in a script that asks for the main context's default
 * loader, which reads the file system as `node lingtai.cjs` does. Still an
 * `import()`, never a `require()`. The option is experimental in Node, and
 * `apps/release/src/binary.ts` turns that warning off in the binary.
 */
function importFile(url: string): Promise<unknown> {
  if (!isSea()) return import(url)
  const load = new Script('(url) => import(url)', {
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  }).runInThisContext() as (url: string) => Promise<unknown>
  return load(url)
}

function portIsFree(host: string, port: number): Effect.Effect<void, Error> {
  return Effect.callback<void, Error>((resume) => {
    const probe = createServer()
    probe.once('error', (err: NodeJS.ErrnoException) => {
      resume(
        Effect.fail(
          new Error(
            err.code === 'EADDRINUSE'
              ? `${host}:${port} is already in use; lingtai board --port <n> picks another`
              : `cannot listen on ${host}:${port}: ${err.message}`,
          ),
        ),
      )
    })
    probe.listen(port, host, () => probe.close(() => resume(Effect.void)))
    return Effect.sync(() => {
      probe.close()
    })
  })
}

/** Whether anything accepts a connection on `host:port`. Never fails. */
export const socketAnswers = (host: string, port: number): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const socket = connect(port, host)
    socket.once('connect', () => {
      socket.destroy()
      resume(Effect.succeed(true))
    })
    socket.once('error', () => resume(Effect.succeed(false)))
    return Effect.sync(() => {
      socket.destroy()
    })
  })

/** Until `host:port` answers. A server that fails to start exits the process. */
const listening = (host: string, port: number): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const deadline = Date.now() + 60_000
    for (;;) {
      if (yield* socketAnswers(host, port)) return
      if (Date.now() > deadline) return yield* Effect.fail(new Error(`the board never listened on ${host}:${port}`))
      yield* Effect.sleep(100)
    }
  })

const liveServeDeps: ServeDeps = {
  exists: existsSync,
  checkTelemetry: () => {
    machineOtlpEndpoint()
  },
  portIsFree,
  importFile: (url) => Effect.tryPromise({ try: () => importFile(url), catch: toError }),
  listening,
  installStopOnSignal,
}

export const serveBoardEffect: (options: BoardOptions) => Effect.Effect<void, Error> = serveBoardWith(liveServeDeps)

/** `serveBoardEffect`, for the callers that are still promises. */
export function serveBoard(options: BoardOptionsPromise): Promise<void> {
  return Effect.runPromise(serveBoardEffect({ ...options, release: Effect.promise(options.release) }))
}

// ---------------------------------------------------------- the lifecycle --

/**
 * `lingtai board start|stop|restart|status` (#187) — the UI's lifecycle, beside
 * the conductor's.
 *
 * ## `stop`, and deliberately not `shutdown`
 *
 * `lingtai shutdown` means *finish the pass in flight*, and waits as long as
 * `runtime.limits.wall` — an hour here. **A board has no pass to finish.**
 * Giving it the same verb would make somebody wait for nothing, or believe the
 * conductor was draining when it was not. So the board stops at once, and the
 * word for it is `stop`.
 *
 * The same for `restart`: `lingtai restart` refuses a `HEAD` the tracking
 * remote does not have, a dirty worktree and a red `lingtai doctor` before it
 * drains (0042). `lingtai board restart` is stop-then-start and claims nothing
 * more — there is nothing to lose by restarting a UI at the wrong commit.
 *
 * ## Which board, and how it is stopped
 *
 * There is no log to send a request down, so the board is found the way
 * everything else on this machine is found: **the file lock under
 * `~/.lingtai/locks/` (#193)**, the same locker the conductor and a decision
 * take. `board start` holds `board` while it serves, and the
 * holder's name carries its pid and host — so `stop` has something to signal
 * and `status` has something to report, and a killed board leaves nothing
 * behind, because the kernel drops a file lock with the process.
 *
 * **The supervisor is asked first, and that is the whole of the race.** A board
 * launchd keeps would be signalled here and respawned thirty seconds later,
 * behind whatever this terminal started in the meantime — so when a supervisor
 * keeps the job, `stop` and `restart` are its calls and not a signal of ours.
 * `start` needs no such check: a supervised board holds the lock, and a second
 * one is refused by it in words.
 */
export const BOARD_START_NOTE =
  'it serves in this terminal — ctrl-c stops it. Under lingtai service it is a job: lingtai board stop'

export const supervisorRefusal = (what: string): string =>
  `the supervisor refused to ${what} the board's job — lingtai service status says what it has`

export const BOARD_STOPPED_NOTE =
  "stopped the board's job. It stays stopped: lingtai service start starts it again with the conductor"

export const stillAnsweringNote = (seconds: number): string =>
  `the supervisor still has the board's job ${seconds}s after the stop — ` +
  'it may still be answering. lingtai service status says what the supervisor has'

export const noAnswerNote = (url: string, seconds: number): string =>
  `nothing answers on ${url} ${seconds}s after the restart — lingtai service status says what the supervisor has`

export type BoardVerb = 'start' | 'stop' | 'restart' | 'status'

/**
 * The lock `board start` holds while it serves, **one per port**.
 *
 * The port and not the word `board`, because the port is what a second board
 * would collide over: two on different ports share nothing and are refused by
 * nothing, and `apps/release/integration/build.test.ts` starts exactly that pair.
 * `stop` and `status` take a port too, so all three name the same lock.
 */
export function boardLock(port: number): string {
  return `board:${port}`
}

/**
 * How long `stop` waits for a signalled board to let the lock go: ten seconds.
 *
 * Counted in polls rather than measured against the clock, so the wait is the
 * injected `sleep`'s and a test that makes it a no-op does not sit here for ten
 * real seconds.
 */
const STOP_POLL_MS = 100
const STOP_POLLS = 100

/**
 * How long `restart` waits for a board to answer again — **`service`'s own
 * `BOARD_WAIT_MS`, because it is the same Next standalone boot**.
 *
 * It was ten seconds of its own, and a cold machine — a fresh login, a `pnpm
 * build` running beside it — takes longer than that to bind: the command
 * reported failure and exited 1 for a board that came up two seconds later,
 * while `service install` was budgeting 75s for the same boot (#187). One
 * estimate, in one place. (`serveBoard`'s `listening` allows less, and is a
 * different question: that one waits on a server this process started, and
 * gives up because nothing is coming.)
 *
 * **Counted and also timed**, because an ask is not free: `answering` carries
 * its own five-second timeout, so against something that accepts TCP and never
 * replies the polls alone would be far longer than the seconds this reports.
 * The count still bounds a test's loop, where nothing takes any time; the
 * deadline bounds the wait, where each ask takes all of its own.
 */
const ANSWER_POLL_MS = 250
const ANSWER_WAIT_MS = BOARD_WAIT_MS
const ANSWER_POLLS = ANSWER_WAIT_MS / ANSWER_POLL_MS

/**
 * How long a supervised `stop` waits for the supervisor to say the job is gone
 * — **`service`'s own `UNLOAD_WAIT_MS`, because it is the same `bootout`**.
 *
 * `launchctl bootout` returns once it has *asked* for the job's termination,
 * which `service.ts`'s `unloadJob` waits past for exactly this reason. Counted
 * as well as timed, for the reason `ANSWER_POLLS` is: the count bounds a test's
 * loop, where a no-op `sleep` takes no time, and the clock bounds the wait.
 */
const GONE_POLL_MS = 500
const GONE_POLLS = UNLOAD_WAIT_MS / GONE_POLL_MS

/** What `boardCommand` runs: the verb, with the port and the directory decided. */
export interface BoardCommand {
  verb: BoardVerb
  port: number
  dir: string
  /** False under a supervisor, which has nobody at a browser (`BOARD_JOB.argv`). */
  open: boolean
}

export interface BoardWorld {
  /** Where the board listens (`board.host`). Never format a URL or connect to it. */
  host: string
  /** Where to reach it — a link, a probe — from `boardReachHost(host)`. */
  reach: string
  /** The Lingtai home this board serves (#767): the path, and as a person reads it (`~` for `$HOME`). */
  home: { path: string; shown: string }
  /** Whether that home has nothing set up — `nothingSetUp` over its store choice and its `config.yml`. */
  notSetUp: () => boolean
  /** This machine's name, as the lock records it — so a holder elsewhere is not signalled here. */
  hostname: string
  /** Whether a Lingtai board answers on this port — its URL, or null. Never "is the port bound". */
  answering: (port: number) => Effect.Effect<string | null>
  /** Whether *anything* holds the port, which a board that is still starting also does. */
  bound: (port: number) => Effect.Effect<boolean>
  locker: Pick<FileLocker, 'tryLock' | 'holder'>
  /**
   * Whether a supervisor keeps a board **on this port** — `keeper(…,
   * BOARD_JOB)`, asked only where the job would be serving the port named.
   *
   * **The port is the argument, and that is the whole of it.** The job runs
   * `lingtai board start --no-open` with no `--port`, so the board a supervisor
   * keeps is on `boardPort()` and on no other. Asked without the port, a
   * `board stop --port 18080` beside a supervised board on 17820 answered
   * *kept*, booted the 17820 job out, reported it stopped, and left the board
   * that was named on the command line running (#187).
   */
  keeper: (port: number) => Keeper
  exec: Exec
  serve: (options: BoardOptions) => Effect.Effect<void, Error>
  open: (url: string) => Effect.Effect<boolean>
  /** SIGTERM to `pid`. False when there is no such process to signal. */
  signal: (pid: number) => boolean
  sleep: (ms: number) => Effect.Effect<void>
  /**
   * The clock a wait is measured against, beside the `sleep` it is spent in.
   * `restart`'s wait for an answer needs both — see `ANSWER_WAIT_MS`.
   */
  now: () => number
  /** Where the port is set, said wherever the port is the trouble. */
  whereThePortIsSet: string
  log: (line: string) => void
  error: (line: string) => void
}

/**
 * The lock, held for as long as this process serves.
 *
 * Module scope and not a local: a `HeldLock` dropped on the floor is a SQLite
 * handle nothing references, and the lock it stands for is not this process's
 * to lose to a collector.
 */
let held: HeldLock | null = null

/** The pid in a lock holder's name — `board on 17820 pid 500 on host` — with the host it is on. */
export function holdingProcess(holder: string): { pid: number; host: string } | null {
  const said = /\bpid (\d+) on (\S+)/.exec(holder)
  return said ? { pid: Number(said[1]), host: said[2]! } : null
}

/**
 * `board status`'s three facts and the port, **each one read on its own** — an
 * unreadable one is `{ unread }` inside its own key and does not fail the others.
 */
export interface BoardStatus {
  port: number
  url: string
  portSetIn: string
  serving: { holder: string | null } | { unread: string }
  answering: { url: string | null } | { unread: string }
  supervisor: Keeper
}

/** An outcome with its failure kept: a typed error or a defect is `{ ok: false }`, an interruption passes through. */
type Attempt<A> = { ok: true; value: A } | { ok: false; error: unknown }

const attempt = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<Attempt<A>, never, R> =>
  Effect.catchCause(
    Effect.map(self, (value): Attempt<A> => ({ ok: true, value })),
    (cause): Effect.Effect<Attempt<A>> => {
      // An interruption is not a failure: it is not answered as one.
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>)
      const typed = Cause.findErrorOption(cause)
      return Effect.succeed({ ok: false, error: Option.isSome(typed) ? typed.value : Cause.squash(cause) })
    },
  )

/** A probe whose failure, of any kind, is "no answer". */
const orNull = <A, E, R>(self: Effect.Effect<A | null, E, R>): Effect.Effect<A | null, never, R> =>
  Effect.map(attempt(self), (r) => (r.ok ? r.value : null))

export const readBoardStatus = (command: Pick<BoardCommand, 'port'>, world: BoardWorld): Effect.Effect<BoardStatus> =>
  Effect.gen(function* () {
    // Three facts, none concluded from another: who serves it, whether a board
    // answers, and whether anything would start one again by itself.
    const held_ = yield* attempt(lift(() => world.locker.holder(boardLock(command.port))))
    const serving: BoardStatus['serving'] = held_.ok
      ? { holder: held_.value }
      : { unread: (held_.error as Error).message }
    const asked = yield* attempt(world.answering(command.port))
    const answering: BoardStatus['answering'] = asked.ok
      ? { url: asked.value }
      : { unread: (asked.error as Error).message }
    return {
      port: command.port,
      url: boardOrigin(world.reach, command.port),
      portSetIn: world.whereThePortIsSet,
      serving,
      answering,
      supervisor: world.keeper(command.port),
    }
  })

export function renderBoardStatus(s: BoardStatus): string[] {
  const serving =
    'unread' in s.serving
      ? `could not be read — ${s.serving.unread}`
      : (s.serving.holder ?? "nobody — no board of this machine's holds the lock")
  const answering =
    'unread' in s.answering
      ? `could not be asked — ${s.answering.unread}`
      : s.answering.url === null
        ? `nothing answers on ${s.url}`
        : `answers on ${s.answering.url}`
  const supervisor =
    'unread' in s.supervisor
      ? s.supervisor.unread
      : s.supervisor.kept
        ? `${s.supervisor.platform} keeps it (${s.supervisor.path})`
        : "none keeps it — a board here is a terminal's"
  return [
    heading(`board on ${s.port}`),
    ...keyValues([
      ['serving', serving],
      ['answering', answering],
      ['supervisor', supervisor],
      ['port', `${s.port}, set in ${s.portSetIn}`],
    ]).map((line) => `  ${line}`),
  ]
}

/** `board status --json`: a fact that could not be read is `{ unread }` in its own key, never an error document. */
export function boardStatusJson(s: BoardStatus): Record<string, unknown> {
  const holder = 'unread' in s.serving ? null : s.serving.holder
  const process_ = holder === null ? null : holdingProcess(holder)
  return {
    serving:
      'unread' in s.serving
        ? { unread: s.serving.unread }
        : holder === null
          ? { holder: null }
          : { holder, ...(process_ ? { pid: process_.pid, host: process_.host } : {}) },
    answering: 'unread' in s.answering ? { unread: s.answering.unread } : { url: s.answering.url },
    supervisor:
      'unread' in s.supervisor
        ? { unread: s.supervisor.unread }
        : s.supervisor.kept
          ? { kept: true, platform: s.supervisor.platform, path: s.supervisor.path }
          : { kept: false },
    port: s.port,
    portSetIn: s.portSetIn,
  }
}

export const boardCommand = (command: BoardCommand, world: BoardWorld): Effect.Effect<number, unknown> =>
  Effect.gen(function* () {
    const { log } = world
    // The first line of a refusal carries the mark; the lines that explain it follow plainly.
    let refused = false
    const error = (line: string): void => {
      world.error(refused ? line : `${symbol.fail()} ${line}`)
      refused = true
    }
    const url = boardOrigin(world.reach, command.port)

    /** Where the port is set, said at every refusal the port causes. */
    const sayWhereThePortIsSet = (): void => error(`the port is ${world.whereThePortIsSet}`)

    /** Whoever holds the board lock, or null. Failures are the caller's: *unread* is not *nobody*. */
    const holder = (): Effect.Effect<string | null, unknown> => lift(() => world.locker.holder(boardLock(command.port)))

    const start = (): Effect.Effect<number, unknown> =>
      Effect.gen(function* () {
        const taken = yield* lift(() => world.locker.tryLock(boardLock(command.port), `board on ${command.port}`))
        if (!taken.ok) {
          // The sentence the ticket asked for, and the holder beside it: a second
          // board on this machine is the ordinary case, not a bare EADDRINUSE.
          error(`a board is already on ${command.port} — ${url}`)
          error(`  held by ${taken.holder ?? 'a holder that has not named itself'}`)
          sayWhereThePortIsSet()
          return 1
        }
        const lock = taken.lock
        held = lock
        // The lock says nothing about the port: something that is not a board of
        // this machine's can hold it, and Next would exit(1) on its own EADDRINUSE
        // long after `serveBoard` resolved.
        if (yield* world.bound(command.port)) {
          const answers_ = yield* orNull(world.answering(command.port))
          error(
            answers_ === null
              ? `${world.reach}:${command.port} is held by something that is not a Lingtai board — nothing was started`
              : `a board is already on ${command.port} — ${answers_}. It is not this machine's, since no lock names it`,
          )
          sayWhereThePortIsSet()
          yield* lift(() => lock.release())
          held = null
          return 1
        }
        const served = yield* attempt(
          world.serve({
            dir: command.dir,
            port: command.port,
            host: world.host,
            release: Effect.gen(function* () {
              yield* Effect.promise(() => held?.release() ?? Promise.resolve())
              held = null
            }),
          }),
        )
        if (!served.ok) {
          yield* lift(() => lock.release())
          held = null
          error((served.error as Error).message)
          return 1
        }
        log(`${symbol.pass()} board on ${url} · home ${world.home.shown}`)
        if (world.notSetUp()) {
          log(`nothing is set up in ${world.home.shown} — the board opens on setup; lingtai init sets it up`)
        }
        if (command.open && !(yield* world.open(url))) log(`no browser could be opened here — open ${url}`)
        log(BOARD_START_NOTE)
        return 0
      })

    /**
     * The supervisor's own stop or restart, when it keeps the board's job. One
     * call each, printed first — this file wraps no more of a service manager
     * than `service.ts` does.
     */
    const throughSupervisor = (
      kept: Extract<Keeper, { kept: true }>,
      what: 'stop' | 'restart',
    ): Effect.Effect<number, unknown> =>
      Effect.gen(function* () {
        const call =
          kept.platform === 'launchd'
            ? what === 'stop'
              ? ['launchctl', 'bootout', `gui/${kept.uid}/${BOARD_JOB.label}`]
              : ['launchctl', 'kickstart', '-k', `gui/${kept.uid}/${BOARD_JOB.label}`]
            : ['systemctl', '--user', what === 'stop' ? 'stop' : 'restart', BOARD_JOB.unit]
        log(`${kept.platform} keeps the board (${kept.path}), so this is its call and not a signal of ours —`)
        log(`$ ${call.join(' ')}`)
        const r = world.exec(call)
        if (r.status !== 0) {
          if (r.out.trim()) error(r.out.trim())
          error(supervisorRefusal(what))
          return 1
        }
        if (what === 'stop') {
          // The call returning is not the job being gone, and saying so would be
          // the one thing this verb is asked for.
          if (!(yield* gone())) return 1
          log(`${symbol.pass()} ${BOARD_STOPPED_NOTE}`)
          return 0
        }
        return (yield* answers()) ? 0 : 1
      })

    /**
     * Whether the supervisor has let the board's job go, **waited for rather than
     * read off the call's own exit**.
     *
     * `launchctl bootout` exits 0 once it has asked for the termination, while
     * the job is still running — `service.ts`'s `unloadJob` polls past exactly
     * that. Reported without the wait, `stop` said *stopped the board's job* over
     * a process that still held the port and the board lock: the next `board
     * status` called it `serving`, and the next `board start` was refused by the
     * lock the dying process had not dropped yet. (`systemctl --user stop`
     * blocks, so there the first ask is the answer and this costs one.)
     */
    const gone = (): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const until = world.now() + UNLOAD_WAIT_MS
        for (let i = 0; i < GONE_POLLS; i++) {
          if (i > 0 && world.now() >= until) break
          const kept = world.keeper(command.port)
          if ('unread' in kept) {
            error(
              `the supervisor was asked to stop the board's job, and whether it has could not be read — ${kept.unread}`,
            )
            return false
          }
          if (!kept.kept) return true
          yield* world.sleep(GONE_POLL_MS)
        }
        error(stillAnsweringNote(UNLOAD_WAIT_MS / 1000))
        return false
      })

    /** Whether a board answers again after a restart, waited for rather than assumed. */
    const answers = (): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const until = world.now() + ANSWER_WAIT_MS
        for (let i = 0; i < ANSWER_POLLS; i++) {
          // The clock beside the count: one ask can cost its own timeout, and a
          // wait that outlives the seconds it reports looks hung.
          if (i > 0 && world.now() >= until) break
          const at = yield* orNull(world.answering(command.port))
          if (at !== null) {
            log(`${symbol.pass()} the board answers on ${at}`)
            return true
          }
          yield* world.sleep(ANSWER_POLL_MS)
        }
        error(noAnswerNote(url, ANSWER_WAIT_MS / 1000))
        return false
      })

    const stop = (): Effect.Effect<number, unknown> =>
      Effect.gen(function* () {
        const kept = world.keeper(command.port)
        if ('unread' in kept) {
          error(
            `${kept.unread}. Nothing was signalled: a board the supervisor keeps comes back in thirty seconds, and a`,
          )
          error('signal sent without knowing that leaves two of them racing for the port')
          return 1
        }
        if (kept.kept) return yield* throughSupervisor(kept, 'stop')

        const read = yield* attempt(holder())
        if (!read.ok) {
          error(`the board lock could not be read — ${(read.error as Error).message}. Nothing was signalled`)
          return 1
        }
        const who = read.value
        if (who === null) {
          const at = yield* orNull(world.answering(command.port))
          log(
            at === null
              ? "no board of this machine's is running, and nothing answers on the port — there was nothing to stop"
              : `no board of this machine's is running, and something answers on ${at} — this signalled nothing, since no lock names it`,
          )
          return 0
        }
        const process_ = holdingProcess(who)
        if (process_ === null) {
          error(`the board lock is held by ${who}, which names no pid — this signalled nothing`)
          return 1
        }
        if (process_.host !== world.hostname) {
          error(
            `the board lock is held by ${who}, on another machine — a signal from here would reach a different process`,
          )
          return 1
        }
        if (!world.signal(process_.pid)) {
          error(`pid ${process_.pid} holds the board lock and is not there to signal — ${who}`)
          return 1
        }
        for (let i = 0; i < STOP_POLLS; i++) {
          const again = yield* attempt(holder())
          if (!again.ok) {
            error(
              `signalled pid ${process_.pid}, and the lock could not be read afterwards — ${(again.error as Error).message}`,
            )
            return 1
          }
          if (again.value === null) {
            log(`${symbol.pass()} stopped the board on ${command.port} — pid ${process_.pid}`)
            return 0
          }
          yield* world.sleep(STOP_POLL_MS)
        }
        error(
          `pid ${process_.pid} still holds the board lock ${(STOP_POLLS * STOP_POLL_MS) / 1000}s after SIGTERM — ` +
            `kill -9 ${process_.pid} is the blunt way, and it takes the server with it: the board serves in that process`,
        )
        return 1
      })

    const status = (): Effect.Effect<number> =>
      Effect.gen(function* () {
        for (const line of renderBoardStatus(yield* readBoardStatus(command, world))) log(line)
        return 0
      })

    switch (command.verb) {
      case 'start':
        return yield* start()
      case 'stop':
        return yield* stop()
      case 'status':
        return yield* status()
      case 'restart': {
        const kept = world.keeper(command.port)
        if ('unread' in kept) {
          error(`${kept.unread}. Nothing was stopped or started`)
          return 1
        }
        // One call, not stop-then-start: this terminal racing the supervisor's
        // respawn for the port is how a `board restart` ends with launchd
        // crash-looping a job behind a board that goes when the terminal closes.
        if (kept.kept) return yield* throughSupervisor(kept, 'restart')
        const stopped = yield* stop()
        if (stopped !== 0) return stopped
        return yield* start()
      }
    }
  })
