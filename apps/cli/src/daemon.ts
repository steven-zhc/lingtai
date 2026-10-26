/**
 * The daemon's side of the CLI: `start`, `service`, `restart` and the operator's
 * controls (#622). No side effects at import — `lingtai.ts` runs `main` when it is
 * loaded, and `cli.ts` must reach these without running a second one.
 */
import { existsSync } from 'node:fs'

import { currentRecipe, describeFilters, loadProjects, projectFilters } from '@lingtai/conductor'
import {
  clientsForProjects,
  createStatusTable,
  createWorkLoop,
  describeInFlight,
  inFlight,
  readCodeVersion,
  readControl,
  readStatus,
  recordStart,
  reconcile,
  requestShutdown,
  requestShutdownUnlessStanding,
  resumeConductor,
  withdrawShutdown,
  controlWatermark,
  startAfter,
  HEARTBEAT_MS,
  startBeacon,
  startDaemon,
  type CodeVersion,
  type ShutdownRequest,
} from '@lingtai/daemon'
import { BOARD_PORT } from '@lingtai/env'
import { paint } from '@lingtai/env/colour'
import { createFileLocker } from '@lingtai/env/lock'
import { parseDuration } from '@lingtai/recipe'
import type { Triage } from '@lingtai/recipe'

import { boardAt, boardEntry, boardLock, boardPortOrWhy, builtBoardDir } from './board.ts'
import { conductorPass } from './conduct.ts'
import { pausedSentence } from './day-ceiling.ts'
import { answerOutstanding, onDiscussionRequested } from './discuss.ts'
import { daemonLiveness } from './doctor.ts'
import { configPath } from './init.ts'
import { symbol } from './output.ts'
import { pauseCommand } from './pause.ts'
import { PROJECTIONS } from './projection.ts'
import type { RestartArgs } from './restart.ts'
import { openDaemon, prepareRestart, queueForTheLock, startRecorder, restartSupervised } from './restart.ts'
import { keeper, serviceCommand, type ServiceOptions } from './service.ts'
import type { Steps } from './steps.ts'
import { createSubjectResolver, createSubscriberSet } from './subscribers.ts'
import {
  catchUpChangedTriage,
  catchUpRegisteredTriage,
  daemonTriagePorts,
  memoDaemonStartedAt,
  onWaitStarted,
} from './triage.ts'
import { renderVerdict } from './verdict.ts'
import { WALL_LIMIT } from './wall-limit.ts'

/** What `lingtai service` reads off the log, shared with the restart that starts through it. */
export function serviceOptions(): ServiceOptions {
  return {
    // The board's job, beside the daemon's (#187). `answering` is the board's
    // own word for being up, which a job the supervisor has loaded is not.
    board: boardOptions(),
    // A read that throws, so a beacon that could not be read says so.
    // Doctor folds that into "no daemon has run", and here it would be the
    // one wrong answer this command exists to avoid. It is the only read:
    // a second one could fail where this succeeded.
    liveness: async () => (await daemonLiveness(() => readStatus())).detail,
    shutdown: async () => (await readControl()).shutdown,
    pause: async () => {
      const c = await readControl()
      return c.paused ? { by: c.by, reason: c.reason, until: c.until } : null
    },
    // `lingtai shutdown`'s own append and a wait on the lock (#174): the
    // supervisor is told only once this command holds the conductor lock.
    drain: {
      ask: (by, reason) => requestShutdownUnlessStanding(by, reason),
      // Not caught here: a read that failed is not "nothing is in flight", and
      // `service shutdown` says it could not be read.
      holding: async () => describeInFlight(await inFlight()),
      queue: () => queueForTheLock(),
      withdraw: (by, version, reason) => withdrawShutdown(by, version, reason),
    },
    // A supervisor's exit code says the job was asked for, not that a daemon
    // won the lock and took work — so a start is confirmed by the record the
    // daemon appends before its first pass (#167).
    started: {
      watermark: () => controlWatermark(),
      after: (version) => startAfter(version),
    },
  }
}

/**
 * The board's leg of `ServiceOptions` (#187), and **the port is read here
 * rather than left to be read by every field**.
 *
 * `boardPort()` throws on a `board.port` that is not a port number, and this
 * object is built for every `lingtai service` verb and for `lingtai restart`.
 * Read where the fields were written — `boardUrl()` in the literal — a typo in
 * a UI setting took the conductor down with it: `service shutdown "moving the
 * database"` threw before `serviceCommand` was entered, so nothing was drained
 * and nothing unloaded, and the only thing said was about the board's port. So
 * the failure becomes the board's own `missing`, which no verb refuses over,
 * and the drain runs.
 */
export function boardOptions(): ServiceOptions['board'] {
  const asked = boardPortOrWhy()
  if ('why' in asked) {
    const why = asked.why
    return {
      // No port was read, so there is no address of this machine's. The
      // default's is where a board would answer once the file reads, and
      // `missing` says in the same breath that nothing is on it.
      url: `http://127.0.0.1:${BOARD_PORT}`,
      answering: async () => null,
      missing: () => ({
        why,
        remedy: [`the board's port is set in ${configPath(process.env)}, and nothing else here reads it`],
      }),
      // Never reached: every verb asks `missing` first and starts no board.
      heldBy: async () => {
        throw new Error(why)
      },
    }
  }
  const { port } = asked
  return {
    url: `http://127.0.0.1:${port}`,
    answering: () => boardAt(port),
    missing: boardMissing,
    // The key `lingtai board start` takes, read without taking it — so a board
    // in a terminal is not a job the supervisor respawns every thirty seconds.
    heldBy: () => createFileLocker().holder(boardLock(port)),
  }
}

/**
 * Why `lingtai board start` would serve nothing here, or null.
 *
 * The same question `board start` itself asks, asked before a job is written
 * to run it (#187): the supervisor's job runs this file from the source, and
 * from the source the board is whatever `pnpm build` left in `dist/`. Where
 * there is none, `lingtai service` writes no board job rather than one launchd
 * respawns every thirty seconds.
 */
export function boardMissing(): { why: string; remedy: readonly string[] } | null {
  const entry = boardEntry(builtBoardDir())
  return existsSync(entry)
    ? null
    : {
        why: `no built board at ${entry}`,
        remedy: [
          'pnpm build writes the board, and pnpm lingtai service install then adds the job',
          'from a checkout, pnpm --filter @lingtai/board dev serves the same port in a terminal',
        ],
      }
}

/**
 * `lingtai daemon` — the process that holds the long-lived work.
 *
 * The follower used to live in this file, which meant nothing held it unless
 * somebody kept a terminal open. It is in `@lingtai/daemon` now, behind one
 * lock, so this is the command and not the mechanism.
 *
 * Losing the lock exits 0. Running this while the service's copy is up is a
 * reasonable thing to do, and answering it with an error would teach people to
 * ignore errors. `lingtai restart` is the one caller that wanted a daemon and
 * is entitled to be told it did not get one — it passes `restart`, and losing
 * the lock exits **non-zero**, because it is not known to be a success: the
 * holder may be a `lingtai run` that exits when its one pass ends, or a launchd
 * copy that read the drain before it was withdrawn and is draining back out.
 * Either leaves no daemon, so the line says what is known and where to look.
 *
 * **The one place a daemon is started**, and that is deliberate: the beacon, the
 * reconcile, the `ConductorStarted` append and the drain handlers are one
 * sequence, and a second way in would be a second place for them to drift apart.
 */
export async function daemonCommand(
  flags: Record<string, string> = {},
  /** Who asked for this start, why, and the code their checks examined — when it is a restart. */
  restart: { by: string; reason: string; examined: CodeVersion } | null = null,
  /** Said once the lock is won and the checks passed, before the daemon's own lines (#622). */
  announce: (() => void) | null = null,
): Promise<number> {
  // The lock, the status table, the code this process loaded, and — for a
  // restart — the refusals only a started daemon can be asked. One function for
  // all of it, so the terminal restart's side of `RESTART_GUARDS` is the code
  // `integration/restart.test.ts` runs and not a copy of it (#167).
  const opened = await openDaemon(restart, {
    start: () => startDaemon({ projections: PROJECTIONS, log: (line) => console.log(line) }),
    code: async () => {
      // The beacon. One timer in the whole system, and it decides nothing — it
      // says "still here", which is the difference between a board that is behind
      // and a board that is broken. Two work items merged for real while their
      // cards sat still and nothing reported it; this is what makes that a glance.
      await createStatusTable()
      // Read once, here, and carried on every beat afterwards. Node caches a module
      // at import, so this process runs whatever `HEAD` pointed at now for as long
      // as it lives — a merge into `main` reaches the CLI, the gates and the board
      // and does not reach this. #88 landed thirty-nine minutes after a daemon
      // started and never executed once; nothing in the beacon could have said so.
      return readCodeVersion()
    },
    control: () => readControl(),
    log: (line) => console.log(line),
  })
  if (!opened.ok) return opened.code
  announce?.()
  const { started, code } = opened
  // **Beating from here**, and not from after the reconcile below — which is
  // what `#144` was. The two lines that follow this one read a recipe per
  // project over the network, and the reconcile after them writes GitHub
  // labels; a startup with two divergences to fix crossed fifteen seconds, and
  // for the second half of it `lingtai doctor` said `not running` about a
  // daemon whose lock it printed on the next line. `startBeacon` keeps one
  // timer for the whole life of the process, so there is no stretch of it
  // during which nothing says "still here".
  const beacon = startBeacon('starting', { code })
  // This process's own start, dated by the store's clock and not this host's:
  // `TriageStarted` is dated by the store, and a database ahead of this host
  // would read an attempt a previous conductor cut off as `Running` (#576). The
  // row's first beat is `fresh` and the lock is held, so the row it leaves is
  // this process's; where it cannot be read, or is another pid's because the
  // beat failed, triage asks again rather than use this host's clock (#583).
  await beacon.say('starting')
  const daemonStartedAt = memoDaemonStartedAt(readStatus)
  console.log(
    `running ${code.sha ? code.sha.slice(0, 7) : 'an unrecorded commit'}` +
      `${code.dirty ? ' (worktree dirty)' : ''} — lingtai doctor says how far behind that is`,
  )

  // And in the log, where the beacon cannot help: a beacon is one mutable row
  // that the next start overwrites, so it says a daemon is up and never said
  // that one *started*, from what code, or at whose hand. A restart at 23:06 on
  // 2026-09-09 is unattributable for exactly that reason (0042).
  //
  // Reported and not fatal. Refusing to conduct because a control append lost a
  // version race would be a daemon that will not run for want of a record of
  // itself — but a start nobody can trace is the defect this closes, so it is
  // said in the accent that means *look at this*.
  //
  // **A person only where a person's hand is on it**, and whose hand is
  // `attributeStart`'s to decide: `lingtai restart` here, a terminal, or
  // nobody's — launchd's and systemd's starts included (0048).
  //
  // **Not decided here.** A read taken now and a shutdown noticed after the
  // reconcile are two reads, and a restart's withdrawal can land between them —
  // a start that saw the drain, recorded nothing, and then took work. So this
  // is handed the one read that decides whether work is taken: the loop's
  // shutdown check, or the `--no-conduct` listener's (`startRecorder`).
  const noteStart = startRecorder({
    restart,
    tty: Boolean(process.stdin.isTTY),
    user: process.env['USER'] ?? 'operator',
    record: (a) => recordStart(a.by, a.reason, code),
    log: (line) => console.log(line),
  })

  // Before anything is taken. A worktree left by a killed daemon is holding a
  // branch checked out, which stops git updating that ref on the next attempt —
  // so the tidy-up has to happen before the next attempt, not after it fails.
  // All four checks, GitHub included (`#69`). The clients are built here and
  // injected rather than reached for inside `reconcile`, so a reconcile in a
  // test — or on a machine with no App — still does the other three.
  const registered = await loadProjects().catch(() => [])

  // What this daemon will and will not take, per project, **before it takes
  // anything**. The same lines `lingtai status` prints, from the same function,
  // so the two cannot disagree about whether a queue is empty or unreadable.
  //
  // #76 is why this is at startup rather than only in a pass. A recipe on
  // `main` naming a label the core did not know stopped parsing, every issue in
  // the project left the queue, and the only place that said so was a `lingtai
  // status` nobody ran — `conduct.ts` put it in `outcome.refused` and the loop
  // logged one `pass failed:` line, but only once a pass had run, and one line
  // into scrollback. A daemon that cannot read a recipe now says so in the
  // block you are already reading while it starts.
  if (registered.length === 0) console.log('no project registered — run lingtai add <owner>/<repo>')
  const filters = await projectFilters(registered)
  for (const line of describeFilters(filters)) console.log(line)

  const { clients, unresolved } = await clientsForProjects(registered)
  // **Report, don't repair** (#389). A project whose client will not build —
  // a recipe that will not resolve, or (`#355`) a no-owner project's own
  // `ownerlessRefusal`, whose recipe resolves fine — is dropped from
  // `clients` rather than falling back to the raw client — see
  // `clientsForProjects`' own doc comment — and the consequence is said here,
  // once per project per daemon start, because `reconcile(` has one caller
  // and nothing on the work loop reaches this line again until the next
  // start. `doctor` reads the same filter live, which is the per-sweep half
  // of this report. `u.problem` already names the specific cause, so the
  // line around it says only that reconcile is skipped — never "its recipe
  // will not resolve", which is false for the ownerless case.
  for (const u of unresolved) {
    console.log(
      paint.fail(
        `reconcile skipped ${u.project}: ${u.problem}. ` +
          'Labels, closes and leftover arms are not converged while this stands.',
      ),
    )
  }
  const found = await reconcile({
    log: (line) => console.log(line),
    // Told what world it is repairing: which projections should be current,
    // which projects' claims are ours, and how to reach GitHub. Each check
    // no-ops without its own input rather than guessing at a global scan.
    projections: PROJECTIONS.map((p) => p.name),
    projects: registered,
    github: { projects: registered, clients },
  }).catch((err: unknown) => {
    // Reported, never fatal. Refusing to start because a directory could not be
    // removed would turn a mess into an outage.
    console.error(`reconcile failed: ${(err as Error).message}`)
    return []
  })
  if (found.length > 0) console.log(paint.pass(`reconciled ${found.length} divergence(s)`))
  // The slow half is done. The timer has been running throughout it; this is
  // the word changing, not the beating starting.
  void beacon.say('up')

  /**
   * How a daemon that takes no work hears a shutdown. Unset while it takes work,
   * because then the loop reads the control stream itself.
   *
   * The loop is what reads the control stream, so a `--no-conduct` daemon was
   * deaf to `lingtai shutdown` entirely — the request landed, nothing read it,
   * and the process stayed up. That was invisible while stopping was the whole
   * of the command; `lingtai restart` waits for the drain it asked for, and a
   * drain nothing will ever perform is a wait that never ends (0042).
   *
   * On the beacon's period, and deciding nothing about work — only when to stop.
   */
  let listening: ReturnType<typeof setInterval> | undefined

  // Taking work is the default now that there is a way to stop it (#45).
  // `--no-conduct` is for a daemon you want keeping the board current while
  // you work on something else.
  let loop: ReturnType<typeof createWorkLoop> | null = null

  // ------------------------------------------------------------ stopping ----
  //
  // Two ways in and one behaviour, from
  // [0030](../../../doc/decisions-archive/0030-shutting-down-safely.md): `lingtai
  // shutdown` reaches the loop through the log, a signal reaches this handler,
  // and both drain. **Draining is waiting for the pass**, which spans the
  // agent, the gates, the merge lane and the `end` point — not for the agent's
  // exit, which is only the first of those.

  /** The request the loop read, when the log is what began this. */
  let asked: ShutdownRequest | null = null
  let draining = false
  let stopping = false

  /**
   * Stop now, without waiting.
   *
   * The second Ctrl+C and the `--timeout` that trips both come here, and both
   * knowingly leave the agent running: it is detached, so it survives this
   * process, and the next conductor's reconcile kills it before releasing its
   * claim (0030 §5). Ending with `process.exit` because the pass in flight is
   * holding the event loop open — returning would be a daemon that says it has
   * stopped and has not.
   */
  const stopNow = (why: string): void => {
    if (stopping) return
    stopping = true
    console.log(paint.held(why))
    void (async () => {
      // The last word, and the timer off with it — `stop` does both, in that
      // order, so nothing lands after it.
      await beacon.stop('stopping')
      started.daemon.stop()
      // The projections are stopped and the lock is released by this; what it
      // does not do, and must not, is wait for the pass.
      await started.daemon.stopped
      process.exit(0)
    })()
  }

  /**
   * Finish the pass in flight, then stop — and say so before waiting.
   *
   * The first Ctrl+C prints what is draining and what a second one costs. Both
   * sentences are honest only because the agent is in its own process group
   * (§3): before that, the signal that began the shutdown killed the agent in
   * the same instant, and there was nothing left to finish.
   */
  const drain = async (why: string, timeoutMs: number | null): Promise<void> => {
    if (draining) return
    draining = true

    const held = await inFlight().catch(() => [])
    // The held colour, which is the board's own answer for this exact fact:
    // `draining.tsx` wears `chip held` with the comment "Held rather than
    // warned: nothing is broken, and a red chip would send…". A shutdown is a
    // person's word, and a person's word is never the green one nor the red.
    console.log(paint.held(`draining — ${describeInFlight(held)}, then stopping (${why}).`))
    console.log(paint.muted('press ctrl-c again to stop now, leaving its agent orphaned.'))
    console.log(
      paint.muted(
        timeoutMs === null
          ? // **A pass is no longer one agent**, and this sentence has now been
            // wrong twice for the same reason. It first said one
            // `runtime.limits.wall`, which the fix loop made an understatement.
            // It was then rewritten as *each with its own <wall>, so several
            // times that* — a multiple, to avoid naming a number this line cannot
            // know. `#141` then made `WALL_LIMIT` a whole sentence rather than a
            // phrase, and the two collided into "each with its own the recipe's
            // runtime.limits — by default, up to 3 agent runs".
            //
            // It says the product now, because `passCeiling` computes one and
            // there is no longer anything to approximate: the multiple *is* the
            // number, and asking the reader to multiply was only ever the cost of
            // not having it.
            `a pass is the agents, the steps and the merge lane. What one may spend is ${WALL_LIMIT}. It is waiting, not hung.`
          : `giving up after ${Math.round(timeoutMs / 1000)}s if it has not finished, which leaves the agent running.`,
      ),
    )
    await beacon.say('draining')

    let timer: ReturnType<typeof setTimeout> | undefined
    if (timeoutMs !== null) {
      timer = setTimeout(
        () =>
          stopNow(
            `--timeout reached — leaving the agent running. The next conductor kills it and releases the claim (lingtai doctor names it).`,
          ),
        timeoutMs,
      )
      timer.unref?.()
    }

    clearInterval(listening)
    // The drain itself. No timeout around this one on purpose (§6).
    await loop?.stop()
    clearTimeout(timer)
    if (stopping) return
    stopping = true
    await beacon.stop('stopping')
    started.daemon.stop()
  }

  // **Where the control stream was when this daemon started** (`#159`). Every
  // signal it obeys is read from here, so a pause or a shutdown appended before
  // it began belongs to the daemon before it and not to this one — which is
  // what makes `lingtai start` need nothing lifted first, for every signal but
  // one. **One pause outlives this watermark** (`#405`): a `ConductorPaused`
  // the conductor itself appends over a tier the setup cannot provide carries
  // `holdsAcrossStarts`, and `readControl` (`packages/daemon/src/control.ts`)
  // obeys it whatever `since` says, because a restart loads the same setup
  // that could not provide the tier. `lingtai resume` is what lifts that one.
  //
  // **Read by `startDaemon`, before the lock** (#174). It used to be read here,
  // after the lock and the projections, and a `service shutdown` appended in
  // that gap was below the watermark of the only daemon holding the lock — so
  // nothing ever obeyed it, and the command waiting for the lock waited for ever.
  const since = started.since
  const triageHashes = new Map<string, string>()
  const scanTriage = async (project: string, triage: Triage | null): Promise<void> => {
    try {
      await catchUpChangedTriage(
        project,
        triage,
        triageHashes,
        daemonTriagePorts(daemonStartedAt, (line) => console.log(line)),
      )
    } catch (err) {
      console.error(`triage catch-up ${project}: ${(err as Error).message}`)
    }
  }

  if (!('no-conduct' in flags)) {
    // Who is told what happened, straight off the recipes and named nowhere
    // here (`#123`). This block used to construct `macNotifier()` by name,
    // which is what 0037 §3 exists to remove: Lingtai's own desktop
    // notification is now a `run:` line in a `subscribers:` block, started by
    // exactly the code that will start somebody else's.
    //
    // Fire and forget, as it always was: a notification retried later, about a
    // decision already made, trains you to ignore the next one.
    //
    // A project whose recipe could not be read here is said to be unread, not
    // quiet, and asked again before each pass until it is.
    const declared = await createSubscriberSet({
      filters,
      reread: (projects) => projectFilters(registered.filter((p) => projects.includes(p.project ?? '(unnamed)'))),
      subject: createSubjectResolver(),
      // The daemon's own directory. There is no worktree for an event — it is
      // not about a diff — and a subscriber that wants one has to make it.
      cwd: process.cwd(),
      log: (line) => console.log(line),
    })
    for (const line of declared.describe()) console.log(line)

    loop = createWorkLoop({
      log: (line) => console.log(line),
      subscribers: () => declared.subscribers(),
      // The third kind of agent, hosted here because the daemon is where money
      // is spent (0033 §3). Off the pass path: a question must not queue behind
      // a run, and it takes no claim and provisions nothing that would need to.
      discuss: (event) => onDiscussionRequested(event, (line) => console.log(line)),
      triage: (event) =>
        onWaitStarted(
          event,
          daemonTriagePorts(daemonStartedAt, (line) => console.log(line)),
        ),
      // Asked from the log every pass. A pause issued while a run is in flight
      // has to land at the next opportunity without anybody restarting this.
      paused: () => pausedSentence({ control: () => readControl(undefined, since) }),
      // And a shutdown in the same breath, from the same fold (0030 §2). The
      // command appends and returns; this is where it lands.
      shutdown: async () => {
        const control = await readControl(undefined, since)
        asked = control.shutdown
        // The start is recorded off this read and no other, before the first
        // pass it permits — see `startRecorder`.
        await noteStart(control)
        // The remedy in the sentence, because this is also what a daemon
        // started *after* an unwithdrawn request prints on its way straight
        // back out — and at that point it is the only thing worth knowing.
        // No remedy in the sentence any more. It used to say "lingtai resume
        // lifts it", because this was also what a daemon started *after* an
        // unwithdrawn request printed on its way straight back out. That start
        // cannot happen now: `since` makes an older request invisible, so
        // reaching here means somebody asked *this* daemon to stop, and they
        // know they did.
        return asked ? `asked by ${asked.by} — ${asked.reason}` : null
      },
      // The loop has stopped taking work. What it cannot do is exit the
      // process, so the host does — after the drain `stop()` performs.
      // `--force` takes the other exit. `stopNow` is not new: it is where
      // `--timeout` already went when it tripped, so forcing asks for a state
      // the system already knows how to be in rather than inventing one.
      onShutdown: (why) =>
        asked?.force === true
          ? stopNow(
              `${why} — forced, so the pass is not finished. The agent is left running for the next conductor to kill.`,
            )
          : void drain(why, asked?.timeoutMs ?? null),

      pass: async (reason) => {
        await declared.retry()
        const recipes = new Map<string, Triage | null>()
        const outcome = await conductorPass({
          merge: !('no-merge' in flags),
          // The commit read at startup, so a refusal on the log says which
          // process refused (#148).
          codeSha: code.sha,
          // Asked again inside the pass, before each project and ticket, with
          // the same scope as the loop's own (#159): a run that stands the
          // conductor down must stop the next claim in this pass, not the next
          // pass (#210).
          paused: () => pausedSentence({ control: () => readControl(undefined, since) }),
          log: (line) => console.log(line),
          onRecipe: (project, recipe) => recipes.set(project, recipe.triage ?? null),
        })
        for (const [project, triage] of recipes) await scanTriage(project, triage)
        // The run told GitHub as it went (0022), so there is nothing left
        // here to send and nothing to report about sending it.
        // A routine pass, in the accent — structure, not a verdict. What the
        // pass *decided* is coloured line by line above this; this one only
        // says the loop went round.
        console.log(
          paint.accent(
            `pass (${reason}): ${outcome.projects} project(s), ${outcome.ran} run(s)` +
              (outcome.refused.length > 0 ? `, ${outcome.refused.length} refused` : ''),
          ),
        )
      },
    })
    // **Scoped, like the loop's** (`#159`). It used to fold the whole stream,
    // so a daemon that had just started announced a pause from before it
    // existed and then took work anyway — the report and the loop disagreeing
    // about the same question, which is worse than either answer.
    //
    // A pause this daemon *will* obey is one somebody made after it started —
    // or, since `#405`, one the conductor marked `holdsAcrossStarts` before it
    // started, because `readControl` merges that one in whatever `since` says
    // — and that is the whole of what is worth printing here. `lingtai status`
    // keeps the unscoped read, because it answers *what is standing* rather
    // than *what will this process do*.
    const control = await readControl(undefined, since)
    // Held, for the same reason `paused.tsx` wears `chip held`: nothing is
    // broken and a person stopped it.
    if (control.paused) console.log(paint.held(`paused by ${control.by} — ${control.reason}`))
    await loop.start()
    // The subscription is live; a wait made during this scan is delivered by its live handler.
    await catchUpRegisteredTriage(
      await loadProjects(),
      async (state) => (await currentRecipe(state)).recipe.triage ?? null,
      scanTriage,
      (line) => console.error(line),
    )
    // A question asked while nothing was listening is waiting in the stream,
    // exactly as a pause is (0013). After `start`, so the subscription is
    // already up and a question that arrives during this one is not missed.
    const waiting = await answerOutstanding((line) => console.log(line)).catch((err: unknown) => {
      console.error(`discussions: ${(err as Error).message}`)
      return 0
    })
    if (waiting > 0) console.log(`answered ${waiting} discussion(s) that were waiting`)
  } else {
    // Discussions go with the conductor, and that is what this flag says: they
    // spend money and 0033 §3 puts everything that spends money in the process
    // that takes work. A daemon told to take none answers none either.
    console.log(paint.muted('projections only — no work will be taken and no question answered'))

    // It still stops when it is told to. Nothing is in flight here — there is
    // no pass to finish — so this drain is over as soon as it begins, which is
    // the honest shape of "finish what you are holding" for a daemon holding
    // nothing.
    const hearShutdown = async (): Promise<void> => {
      const control = await readControl().catch(() => null)
      if (control) await noteStart(control)
      const standing = control?.shutdown ?? null
      if (standing) await drain(`asked by ${standing.by} — ${standing.reason}`, standing.timeoutMs)
    }
    listening = setInterval(() => void hearShutdown(), HEARTBEAT_MS)
    // Asked once before waiting for the timer, so a daemon started after an
    // unwithdrawn request goes straight back out — as a conducting one does.
    await hearShutdown()
  }

  // The first signal drains and says so; the second stops now. `kill <pid>` is
  // the same two presses, because it used to be the worse of the two: it
  // reached the daemon alone, orphaned the agent, and took with it the code
  // that would have appended the outcome (#87).
  let signals = 0
  const stop = (signal: string) => {
    signals += 1
    if (signals === 1) {
      void drain(signal === 'SIGINT' ? 'ctrl-c' : signal, null)
      return
    }
    stopNow('stopping now — its agent is left running, and the next conductor kills it.')
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  const reason = await started.daemon.stopped
  if (reason === 'projection-failed') {
    const failed = started.daemon.failure
    console.error(`stopped: ${failed?.projection} failed — ${String(failed?.error)}`)
    return 1
  }
  console.log('stopped')
  return 0
}

/**
 * `lingtai pause` / `lingtai resume` / `lingtai shutdown` / `lingtai now` — the
 * operator's controls.
 *
 * They append and return. The daemon is listening, so a pause takes effect at
 * its next opportunity; if it is down, the command is waiting when it comes
 * back rather than being a race somebody has to handle.
 *
 * `shutdown` is the same shape for the same reasons, and for one more that is
 * not an implementation detail: a signal cannot carry it
 * ([0030](../../../doc/decisions-archive/0030-shutting-down-safely.md)). Ctrl+C goes to
 * the whole foreground group, so before §3 detached the agent, the signal that
 * began the shutdown killed the run it claimed to be waiting for.
 *
 * **The one place that does not hold a projector**, and deliberately: a
 * projector catches up to the head before it returns, so a pause issued against
 * a daemon that has been down would replay the backlog before pausing anything.
 * See `withProjector` for the rule and for this exception.
 */
export async function controlCommand(
  verb: 'pause' | 'resume' | 'shutdown',
  input: { reason?: string; timeout?: string; force?: boolean },
): Promise<number> {
  const by = `human:${process.env['USER'] ?? 'operator'}`

  if (verb === 'pause') {
    const reason = input.reason ?? ''
    if (!reason.trim()) {
      // A pause with no reason is one nobody can undo confidently, because
      // nobody can tell whether the thing it was waiting for has happened.
      console.error('lingtai pause <why>  — a pause needs a reason')
      return 2
    }
    await pauseCommand(by, reason)
    return 0
  }

  if (verb === 'resume') {
    await resumeConductor(by)
    for (const line of renderVerdict('resumed', { outcome: 'accepted', detail: `resumed by ${by}` })) console.log(line)
    return 0
  }

  if (verb === 'shutdown') {
    // A reason is welcome and not required, unlike a pause's: a pause has to be
    // lifted by somebody who can tell whether the thing it was waiting for has
    // happened, and a shutdown is over when the process is.
    const reason = (input.reason ?? '').trim() || 'no reason given'

    let timeoutMs: number | null = null
    if (input.timeout !== undefined) {
      const text = input.timeout
      try {
        timeoutMs = parseDuration(text)
      } catch {
        console.error(`--timeout takes a duration like 30m or 90s, not "${text}"`)
        return 2
      }
      if (timeoutMs <= 0) {
        console.error('--timeout takes a positive duration')
        return 2
      }
    }

    // Safe is the default and `--force` is the loud one (`#159`). A command
    // whose ordinary form throws away a pass in flight is one people learn to
    // fear; this way the dangerous thing has to be asked for by name.
    const force = input.force === true
    if (force && input.timeout !== undefined) {
      console.error('--timeout is about waiting for the pass, and --force does not wait. Use one.')
      return 2
    }

    await requestShutdown(by, reason, timeoutMs, undefined, force)
    const asked = paint.held(`shutdown asked by ${by} — ${reason}`)

    // The verdict is only that the request was appended: the daemon finishes the
    // pass on its own (0030), so nothing here says it stopped.
    let detail: string
    if (force) {
      // What `--timeout` has always done when it tripped, and what a second
      // Ctrl+C does. The orphan is the point, and it already has an owner.
      detail = `${asked}\n--force: it stops without finishing the pass. The agent is left running, and the next conductor kills it and releases the claim.`
    } else {
      // Said up front, because the alternative is a command that has returned
      // and a daemon that looks hung (0030 §6). What is being waited for is the
      // *pass* — the agent, then the gates, then the merge lane.
      const held = await inFlight().catch(() => [])
      detail = `${asked}\n${
        timeoutMs === null
          ? // No "lingtai resume lifts it" any more (`#159`). It was true when the
            // request outlived the daemon it was aimed at; the next `lingtai start`
            // now needs nothing lifted, so saying otherwise would send a person to
            // a command that has nothing to do.
            `the daemon finishes the pass in flight first — ${describeInFlight(held)} — which can take as long as ${WALL_LIMIT}.`
          : `the daemon finishes the pass in flight — ${describeInFlight(held)} — or gives up after ${Math.round(timeoutMs / 1000)}s and exits with the agent still running, for the next conductor to kill.`
      }`
    }
    for (const line of renderVerdict('shutdown asked', { outcome: 'accepted', detail })) console.log(line)
    return 0
  }

  // `controlCommand` has no other verb: `now` is `@effect/cli`'s since #621.
  return verb satisfies never
}

/**
 * `lingtai restart`, after the line is parsed and the flags are known to be valid
 * (#622). The decisions are the ones `main` made before: a supervisor that could
 * not be read refuses, one that keeps the daemon takes the drain and the start,
 * and otherwise `prepareRestart` refuses, drains and waits and the start is
 * `lingtai start`'s own.
 */
export async function restartCommand(args: RestartArgs, steps: Steps): Promise<number> {
  let started = false
  let code: number
  try {
    code = await restartSteps(args, steps, (sha) => {
      started = true
      steps.end()
      console.log(`${symbol.pass()} restarted${sha === null ? '' : ` ${paint.muted(sha)}`}`)
    })
  } finally {
    // A refusal or drain returns with a spinner still live, and a throw must not leave it animating.
    if (!started) steps.end()
  }
  // One closing line either way. After the start there is no second verdict: the daemon's own
  // lines follow, and a failure of the running daemon is not a restart that did not happen.
  if (!started && code !== 0) console.log(`${symbol.fail()} not restarted`)
  return code
}

async function restartSteps(args: RestartArgs, steps: Steps, restarted: (sha: string | null) => void): Promise<number> {
  // Asked before anything stops, like every other refusal. Under launchd or
  // systemd the start is the supervisor's: a daemon started here would be a
  // conductor in a terminal beside the one it keeps (0042 §8).
  const kept = keeper()
  if ('unread' in kept) {
    console.log(paint.fail(`not restarting: ${kept.unread}. Nothing was asked to stop and nothing was stopped.`))
    return 1
  }
  if (kept.kept && (args.noConduct || args.noMerge)) {
    console.error(
      `${kept.path} decides how the supervisor starts the daemon, so --no-conduct and --no-merge cannot reach it — ` +
        'pnpm lingtai service shutdown, then lingtai restart with them, runs one in this terminal instead',
    )
    return 2
  }
  // Where a supervisor keeps the daemon, the drain and the start are
  // `lingtai service`'s and every refusal is still the restart's — the same
  // functions as below, and `RESTART_GUARDS` is the table of both (#167).
  if (kept.kept) {
    const options = serviceOptions()
    const code = await restartSupervised(args, {
      steps,
      service: (argv, asked) =>
        serviceCommand(argv, {
          ...options,
          // The phases are `restartSupervised`'s own labels; the wait inside the drain still
          // reaches the spinner through `progress`, and `end` clears it.
          steps: { begin() {}, progress: (line) => steps.progress(line), end: () => steps.end() },
          drain: {
            ...options.drain,
            ask: (by: string, reason: string) =>
              requestShutdownUnlessStanding(by, reason, asked.timeoutMs, undefined, asked.force),
          },
        }),
    })
    if (code === 0) restarted(null)
    return code
  }
  // Two halves of one command, and the seam is the only place a daemon is
  // started. `prepareRestart` refuses, drains and waits; everything after
  // this line is `lingtai start`.
  const prepared = await prepareRestart(args, console.log, undefined, steps)
  if (!prepared.ok) return prepared.code
  const flags: Record<string, string> = {
    ...(args.noConduct ? { 'no-conduct': '' } : {}),
    ...(args.noMerge ? { 'no-merge': '' } : {}),
  }
  steps.begin('starting')
  return daemonCommand(flags, prepared, () => restarted(prepared.examined.sha?.slice(0, 7) ?? null))
}
