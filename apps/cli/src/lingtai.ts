#!/usr/bin/env node
/**
 * `lingtai` — the entry point.
 *
 * Deliberately hand-rolled argument parsing. design.md §8 is a list of things
 * not being built until a specific failure demands them, and a dependency for
 * three subcommands is exactly the kind of thing it is warning about.
 *
 * Everything here loads `@lingtai/event-store`, which loads the environment from
 * the repository root — see `packages/event-store/src/env.ts`. Never read
 * `process.env` for a connection string directly.
 */
import { createProjectionRunner, projectionLag } from "@lingtai/projector";
import { describeFilters, loadProjects, projectFilters } from "@lingtai/conductor";
import { backlogProjection, taskViewProjection } from "@lingtai/projector";
import type { Tier } from "@lingtai/domain";
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
  requestRun,
  requestShutdown,
  requestShutdownUnlessStanding,
  resumeConductor,
  withdrawShutdown,
  HEARTBEAT_MS,
  startBeacon,
  startDaemon,
  type CodeVersion,
  type ShutdownRequest,
} from "@lingtai/daemon";
import { parseDuration } from "@lingtai/recipe";
import { paint } from "@lingtai/env/colour";
import { attach } from "./attach.ts";
import { conductorPass } from "./conduct.ts";
import { answerOutstanding, onDiscussionRequested } from "./discuss.ts";
import { add } from "@lingtai/conductor/onboard";
import { approveCommand } from "./approve.ts";
import { answerCommand, askCommand } from "./ask.ts";
import { closeCommand } from "./close.ts";
import { backlogCommand } from "./backlog.ts";
import { daemonLiveness, doctorReport, formatReport } from "./doctor.ts";
import { parseRestartArgs, prepareRestart, queueForTheLock, startRecorder, startSupervised } from "./restart.ts";
import { endReplay } from "./end.ts";
import { envCommand } from "./env.ts";
import { requeueCommand } from "./requeue.ts";
import { pauseCommand } from "./pause.ts";
import { run as runOnceCommand } from "./run.ts";
import { keeper, serviceCommand, type ServiceOptions } from "./service.ts";
import { status } from "./status.ts";
import { WALL_LIMIT } from "./wall-limit.ts";
import { createSubjectResolver, createSubscriberSet } from "./subscribers.ts";

/**
 * Every projection this system runs, named here in the open.
 *
 * A second one exists now (`finding_backlog`, `#137`), and the comment in
 * `projectionCommand` says where it has to be added: here, visibly, or it
 * does not exist.
 */
const PROJECTIONS = [taskViewProjection, backlogProjection] as const;

const USAGE = `lingtai — event-sourced scheduler for autonomous code agents

  lingtai add <owner>/<repo>        onboard a repository the App is installed on
    --base <branch>             where to *read the recipe from*, not what the
                                base is — the recipe's own repo.base says that,
                                and a --base contradicting it is refused.
                                default: the repository's own default branch
  lingtai run <project>             take the queue, in the recipe's priority order
    --issue <n>                 one nominated issue instead of the queue
    --max <n>                   stop after n items (--max 2 is Phase 2's bar)
    --once                      the same as --max 1
    --no-merge                  stop after the gates and ask before merging

  the decisions — each the one the board's card takes, recorded the same way:
  lingtai approve <project> --issue <n>
                                merge what a held run produced, if its head has
                                not moved since the approval was asked for
    --note <text>               recorded with the approval, and required when
                                a gate still refuses the head: approving then
                                waives each refusing gate, with this as why
  lingtai requeue <project> --issue <n> --note <why>
                                end the wait with a new run instead: a blocked
                                item goes back to the queue — held for approval
                                or not — and the next pass cuts a fresh branch
                                from a base that has since moved. --note is
                                required — a person overruling a block is not
                                anonymous
  lingtai backlog [project]         the minor findings passing gates raised, open
    --all                       decided ones too, and what was decided
  lingtai backlog accept <project> <key> --kind <kind>
                                open one as an issue through the ticket store.
                                One key: there is no accept-all
    --unheld                    without agent:hold, so the next pass may take it
                                Without --kind, opens the issue of an entry
                                already accepted — safe to repeat, never a second
  lingtai backlog decline <project> <key> --reason <why>
                                recorded, so the next attempt does not ask again
  lingtai close <project> --issue <n> "<reason>"
                                a ticket nobody is going to do, ended: the queue
                                stops offering it because the log says it is
                                over. Nothing lifts a close — if the work is
                                wanted again, open a new ticket
  lingtai ask <project> --issue <n> "<question>"
                                hold a ticket on a decision before any run
                                claims it: nothing is spent, the queue passes
                                over it, and lingtai status prints the question
  lingtai answer <project> --issue <n> "<choice>"
                                answer it on the record: back in the queue, and
                                every attempt at the ticket is told the answer
                                — no editing the issue body
  lingtai attach <runId>            follow a run's log — what it is doing, as it
                                does it, from the beginning however late you
                                attach. Reads a file and asks nothing of the
                                daemon or the database, so it answers on a
                                stopped system and on a run that is long over.
                                A landed run has no log: 0034 keeps exactly the
                                ones still owed an explanation
  lingtai status [project]          what is runnable, and what is holding the rest
    --all                       include items that have left the queue
                                and why. Takes nothing and claims nothing.
  lingtai doctor                    check everything that can be checked
  lingtai env set <project> KEY=VALUE
                                write one value into ~/.lingtai/env/<project>.env
  lingtai env set <project> KEY     read the value from stdin, unechoed
  lingtai env list <project>        names and which layer answered — never values
  lingtai env unset <project> KEY   remove one
  lingtai end replay [project]      resolve the end point for items that landed
    --issue <n>                 without it, and deliver what it resolves to
  lingtai start                     hold the projections current and take work.
                                Reads no standing signal: a pause or a shutdown
                                aimed at an earlier daemon was not aimed at this
                                one, so nothing has to be lifted first. If
                                another daemon holds the lock this starts
                                nothing and says so. Unchecked — lingtai restart
                                is the checked start
    --no-conduct                projections only, take nothing
    --no-merge                  as for lingtai run
  lingtai service install|start|shutdown [why]|restart [why]|status|uninstall
                                keep lingtai daemon running: a LaunchAgent on
                                macOS, a systemd user unit on Linux. No service
                                manager? run lingtai daemon in the foreground.
                                shutdown drains through the log, waits for the
                                pass, then unloads; restart is that and start,
                                unchecked — lingtai restart is the checked one
  lingtai pause <why>               stop the running daemon taking new tickets; a
                                run in flight finishes. About the daemon that is
                                running, and gone when it is — but not for
                                lingtai run, which takes no ticket while a
                                pause stands, daemon or none: one already
                                working finishes the ticket in hand and takes
                                no other
  lingtai resume                    take tickets again
  lingtai shutdown [why]            stop the daemon, letting the ticket in flight
                                finish first — the pass, so the gates and the
                                merge lane run too. It does not outlive the
                                daemon it was sent to, so the next lingtai start
                                needs nothing lifted
    --force                     do not wait. The agent is left running and the
                                next conductor kills it and releases the claim
    --timeout <duration>        give up waiting after this and exit anyway,
                                leaving the agent running. Not with --force,
                                which does not wait at all
  lingtai restart [why]             drain, wait for the pass, and start one daemon
                                here — or through lingtai service, when a
                                supervisor keeps it. Refuses a commit that is not on the
                                tracking remote — a process holds its code for
                                hours, and a commit nobody pushed cannot be
                                reasoned about afterwards — a dirty worktree,
                                and what lingtai doctor failed on. Ctrl+C
                                during the wait leaves the drain standing, and
                                the next restart picks it up
    --dirty                     start from a dirty worktree, having read why not
    --despite-doctor            start in spite of failed doctor checks
    --force, --timeout          as for lingtai shutdown — they are that
                                shutdown's, and the start is unaffected
    --no-conduct, --no-merge    as for lingtai start; refused under a supervisor
  lingtai now <project> --issue <n> ask for one ahead of the queue
  lingtai projection lag            how far each projection is behind the log
  lingtai projection rebuild <name> drop the table, reset the checkpoint, replay
  lingtai help
  lingtai version

Projections: ${PROJECTIONS.map((p) => p.name).join(", ")}
`;

async function doctor(): Promise<number> {
  const report = await doctorReport();
  console.log(formatReport(report));
  // Non-zero on any failure. `lingtai restart` runs the same report (0042) but
  // does not refuse on the same number: a failure marked `restartAnswers` exits
  // this 1 and lets a restart through, since the restart is its remedy — see
  // `gatingFailures`. A deferred check is not a failure; a missing one would be.
  return report.failed === 0 ? 0 : 1;
}

/**
 * `--flag value` pairs plus positionals. Enough for three commands.
 *
 * A flag whose next token is another flag, or which ends the line, is a boolean
 * and consumes nothing. Without that rule `--no-merge --no-conduct` parsed as
 * `no-merge: "--no-conduct"` and swallowed the second flag whole, so the second
 * stayed on while the command line said to turn it off — a flag that reads as
 * ignored is the one kind that is worse than a flag that errors.
 */
function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[a.slice(2)] = "";
      } else {
        flags[a.slice(2)] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function addCommand(args: string[]): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const slug = positional[0];
  if (!slug) {
    console.error("lingtai add <owner>/<repo>");
    return 2;
  }
  // Tier, gates and the base are the recipe's, in the managed repository, which
  // is why this takes a slug and — at most — the branch to find the file on.
  // `named`, because a person typed it here: a recipe that contradicts `--base`
  // is refused rather than adopted (#75), which is a refusal only a typed flag
  // may earn.
  const base = flags["base"];
  return add({ slug, base: base === undefined ? undefined : { ref: base, named: true } });
}

async function projectionCommand(args: string[]): Promise<number> {
  const [sub, name] = args;

  if (sub === "lag") {
    const lags = await projectionLag();
    if (lags.length === 0) {
      console.log("no projection has a checkpoint yet");
      return 0;
    }
    for (const l of lags) {
      console.log(`${l.name}\t${l.lastSeq}/${l.headSeq}\t${l.lag} behind\t${l.updatedAt?.toISOString() ?? "never"}`);
    }
    return 0;
  }

  if (sub === "rebuild") {
    if (!name) {
      console.error("lingtai projection rebuild <name>");
      return 2;
    }
    // Named, not discovered. A list whose only job was to let a projection be
    // written and silently left out of it — no table, no checkpoint, no failing
    // check — is what 0022 refused; `PROJECTIONS` is written out above, and a
    // projection missing from it is missing from `--help` too.
    const projection = PROJECTIONS.find((p) => p.name === name);
    if (!projection) {
      console.error(`unknown projection "${name}" — known: ${PROJECTIONS.map((p) => p.name).join(", ")}`);
      return 2;
    }
    const runner = createProjectionRunner({ projection });
    try {
      // Drop the table, reset the checkpoint, replay. This is what makes a
      // projection's shape free to change: a rebuild, not a migration.
      await runner.rebuild();
      const lag = await runner.lag();
      console.log(`${name} rebuilt — at ${lag.lastSeq}/${lag.headSeq}, ${lag.lag} behind`);
      return lag.lag === 0n ? 0 : 1;
    } finally {
      await runner.close();
    }
  }

  // Gone, and answered by name rather than by falling through to the usage.
  //
  // It was an alias for `lingtai daemon`, and that is exactly what made it
  // confusing: it read as a second way to follow the log, when it was only the
  // same one wearing another name. Two names for one process is how "why is
  // the board stale" gets a different answer depending on which name you
  // happened to learn. Since 0022 there is one behaviour everywhere — every
  // process that appends holds a projector while it runs.
  if (sub === "run") {
    console.error("lingtai projection run is gone — it was another name for lingtai daemon, which is the process that follows the projections. Use that.");
    return 2;
  }

  console.error(USAGE);
  return 2;
}

/** What `lingtai service` reads off the log, shared with the restart that starts through it. */
function serviceOptions(): ServiceOptions {
  return {
    // A read that throws, so a beacon that could not be read says so.
    // Doctor folds that into "no daemon has run", and here it would be the
    // one wrong answer this command exists to avoid. It is the only read:
    // a second one could fail where this succeeded.
    liveness: async () => (await daemonLiveness(() => readStatus())).detail,
    shutdown: async () => (await readControl()).shutdown,
    pause: async () => {
      const c = await readControl();
      return c.paused ? { by: c.by, reason: c.reason, until: c.until } : null;
    },
    // `lingtai shutdown`'s own append and a wait on the lock (#174): the
    // supervisor is told only once this command holds the conductor lock.
    drain: {
      ask: (by, reason) => requestShutdownUnlessStanding(by, reason),
      holding: async () => describeInFlight(await inFlight().catch(() => [])),
      queue: () => queueForTheLock(),
      withdraw: (by, version, reason) => withdrawShutdown(by, version, reason),
    },
  };
}

/**
 * `lingtai daemon` — the process that holds the long-lived work.
 *
 * The follower used to live in this file, which meant nothing held it unless
 * somebody kept a terminal open. It is in `@lingtai/daemon` now, behind one
 * advisory lock, so this is the command and not the mechanism.
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
async function daemonCommand(
  flags: Record<string, string> = {},
  /** Who asked for this start, why, and the code their checks examined — when it is a restart. */
  restart: { by: string; reason: string; examined: CodeVersion } | null = null,
): Promise<number> {
  const started = await startDaemon({
    projections: PROJECTIONS,
    log: (line) => console.log(line),
  });

  if (!started.ok) {
    const holder = started.holder ? ` (${started.holder})` : "";
    if (restart) {
      // The drain finished and something else won the race for the lock. This
      // cannot say what that something is going to do: a `lingtai run` in a
      // terminal takes the same lock and exits when its one pass ends, and a
      // launchd copy spawned before the withdrawal reads the request still
      // standing and drains straight back out. Saying "it is running" would be
      // a guess that tells the operator to do nothing — so it says only what is
      // known, and where the answer is.
      console.log(
        paint.held(
          `the lock was taken first${holder}, and this started nothing. Whether a daemon is conducting ` +
            `afterwards is not something this process can know — a lingtai run exits when its pass ends, and a ` +
            `daemon that read the drain before it was withdrawn exits too. lingtai doctor says whether one is up; ` +
            `if none is, lingtai restart again waits for the lock and starts one.`,
        ),
      );
      return 1;
    }
    // A refusal, and deliberately the quietest line the daemon has. Nothing is
    // wrong — red here would be the error that teaches people to ignore errors
    // — and nothing happened, so dim is the honest weight for it.
    console.log(paint.muted(`another daemon holds the lock${holder} — nothing to do`));
    return 0;
  }

  // The beacon. One timer in the whole system, and it decides nothing — it
  // says "still here", which is the difference between a board that is behind
  // and a board that is broken. Two work items merged for real while their
  // cards sat still and nothing reported it; this is what makes that a glance.
  await createStatusTable();

  // Read once, here, and carried on every beat afterwards. Node caches a module
  // at import, so this process runs whatever `HEAD` pointed at now for as long
  // as it lives — a merge into `main` reaches the CLI, the gates and the board
  // and does not reach this. #88 landed thirty-nine minutes after a daemon
  // started and never executed once; nothing in the beacon could have said so.
  const code = await readCodeVersion();

  // What is on disk now is what `lingtai restart` examined, or nothing starts.
  // And what it examined is the commit this process *loaded*: its first read,
  // taken before the doctor and the drain, and required again after the wait
  // (`planRestart`'s `loaded`). Node imported the conductor, the gates and this
  // daemon when the command was typed, so a `git pull` during an hour's drain
  // changes the disk and not the process — and a `ConductorStarted` naming the
  // disk would be #98 again, with a record saying the opposite.
  if (restart && (code.sha !== restart.examined.sha || code.dirty !== restart.examined.dirty)) {
    const said = (v: CodeVersion) => `${v.sha ? v.sha.slice(0, 7) : "an unrecorded commit"}${v.dirty ? " (worktree dirty)" : ""}`;
    console.log(
      paint.fail(
        `the checkout moved between the checks and the start — ${said(restart.examined)} was checked and ` +
          `${said(code)} is what this would run. Nothing started, and no daemon is running: lingtai restart checks again.`,
      ),
    );
    started.daemon.stop();
    await started.daemon.stopped;
    return 1;
  }

  // **Beating from here**, and not from after the reconcile below — which is
  // what `#144` was. The two lines that follow this one read a recipe per
  // project over the network, and the reconcile after them writes GitHub
  // labels; a startup with two divergences to fix crossed fifteen seconds, and
  // for the second half of it `lingtai doctor` said `not running` about a
  // daemon whose lock it printed on the next line. `startBeacon` keeps one
  // timer for the whole life of the process, so there is no stretch of it
  // during which nothing says "still here".
  const beacon = startBeacon("starting", { code });
  console.log(
    `running ${code.sha ? code.sha.slice(0, 7) : "an unrecorded commit"}` +
      `${code.dirty ? " (worktree dirty)" : ""} — lingtai doctor says how far behind that is`,
  );

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
  // `attributeStart`'s to decide: `lingtai restart` here, a restart that handed
  // its start to launchd or systemd (0042 §8), a terminal, or nobody's.
  //
  // **Not decided here.** A read taken now and a shutdown noticed after the
  // reconcile are two reads, and a restart's withdrawal can land between them —
  // a start that saw the drain, recorded nothing, and then took work. So this
  // is handed the one read that decides whether work is taken: the loop's
  // shutdown check, or the `--no-conduct` listener's (`startRecorder`).
  const noteStart = startRecorder({
    restart,
    code,
    tty: Boolean(process.stdin.isTTY),
    user: process.env["USER"] ?? "operator",
    record: (a) => recordStart(a.by, a.reason, code, undefined, a.handoff),
    log: (line) => console.log(line),
  });

  // Before anything is taken. A worktree left by a killed daemon is holding a
  // branch checked out, which stops git updating that ref on the next attempt —
  // so the tidy-up has to happen before the next attempt, not after it fails.
  // All four checks, GitHub included (`#69`). The clients are built here and
  // injected rather than reached for inside `reconcile`, so a reconcile in a
  // test — or on a machine with no App — still does the other three.
  const registered = await loadProjects().catch(() => []);

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
  if (registered.length === 0) console.log("no project registered — run lingtai add <owner>/<repo>");
  const filters = await projectFilters(registered);
  for (const line of describeFilters(filters)) console.log(line);

  const found = await reconcile({
    log: (line) => console.log(line),
    // Told what world it is repairing: which projections should be current,
    // which projects' claims are ours, and how to reach GitHub. Each check
    // no-ops without its own input rather than guessing at a global scan.
    projections: PROJECTIONS.map((p) => p.name),
    projects: registered,
    github: { projects: registered, clients: await clientsForProjects(registered) },
  }).catch((err: unknown) => {
    // Reported, never fatal. Refusing to start because a directory could not be
    // removed would turn a mess into an outage.
    console.error(`reconcile failed: ${(err as Error).message}`);
    return [];
  });
  if (found.length > 0) console.log(paint.pass(`reconciled ${found.length} divergence(s)`));
  // The slow half is done. The timer has been running throughout it; this is
  // the word changing, not the beating starting.
  void beacon.say("up");

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
  let listening: ReturnType<typeof setInterval> | undefined;

  // Taking work is the default now that there is a way to stop it (#45).
  // `--no-conduct` is for a daemon you want keeping the board current while
  // you work on something else.
  let loop: ReturnType<typeof createWorkLoop> | null = null;

  // ------------------------------------------------------------ stopping ----
  //
  // Two ways in and one behaviour, from
  // [0030](../../../doc/decisions/0030-shutting-down-safely.md): `lingtai
  // shutdown` reaches the loop through the log, a signal reaches this handler,
  // and both drain. **Draining is waiting for the pass**, which spans the
  // agent, the gates, the merge lane and the `end` point — not for the agent's
  // exit, which is only the first of those.

  /** The request the loop read, when the log is what began this. */
  let asked: ShutdownRequest | null = null;
  let draining = false;
  let stopping = false;

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
    if (stopping) return;
    stopping = true;
    console.log(paint.held(why));
    void (async () => {
      // The last word, and the timer off with it — `stop` does both, in that
      // order, so nothing lands after it.
      await beacon.stop("stopping");
      started.daemon.stop();
      // The projections are stopped and the lock is released by this; what it
      // does not do, and must not, is wait for the pass.
      await started.daemon.stopped;
      process.exit(0);
    })();
  };

  /**
   * Finish the pass in flight, then stop — and say so before waiting.
   *
   * The first Ctrl+C prints what is draining and what a second one costs. Both
   * sentences are honest only because the agent is in its own process group
   * (§3): before that, the signal that began the shutdown killed the agent in
   * the same instant, and there was nothing left to finish.
   */
  const drain = async (why: string, timeoutMs: number | null): Promise<void> => {
    if (draining) return;
    draining = true;

    const held = await inFlight().catch(() => []);
    // The held colour, which is the board's own answer for this exact fact:
    // `draining.tsx` wears `chip held` with the comment "Held rather than
    // warned: nothing is broken, and a red chip would send…". A shutdown is a
    // person's word, and a person's word is never the green one nor the red.
    console.log(paint.held(`draining — ${describeInFlight(held)}, then stopping (${why}).`));
    console.log(paint.muted("press ctrl-c again to stop now, leaving its agent orphaned."));
    console.log(
      paint.muted(
        timeoutMs === null
          // **A pass is no longer one agent**, and this sentence has now been
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
          ? `a pass is the agents, the gates and the merge lane. What one may spend is ${WALL_LIMIT}. It is waiting, not hung.`
          : `giving up after ${Math.round(timeoutMs / 1000)}s if it has not finished, which leaves the agent running.`,
      ),
    );
    await beacon.say("draining");

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== null) {
      timer = setTimeout(
        () =>
          stopNow(
            `--timeout reached — leaving the agent running. The next conductor kills it and releases the claim (lingtai doctor names it).`,
          ),
        timeoutMs,
      );
      timer.unref?.();
    }

    clearInterval(listening);
    // The drain itself. No timeout around this one on purpose (§6).
    await loop?.stop();
    clearTimeout(timer);
    if (stopping) return;
    stopping = true;
    await beacon.stop("stopping");
    started.daemon.stop();
  };

  // **Where the control stream was when this daemon started** (`#159`). Every
  // signal it obeys is read from here, so a pause or a shutdown appended before
  // it began belongs to the daemon before it and not to this one. That is what
  // makes `lingtai start` need nothing lifted first: there is no such thing as
  // a signal standing over a process that did not exist when it was sent.
  //
  // **Read by `startDaemon`, before the lock** (#174). It used to be read here,
  // after the lock and the projections, and a `service shutdown` appended in
  // that gap was below the watermark of the only daemon holding the lock — so
  // nothing ever obeyed it, and the command waiting for the lock waited for ever.
  const since = started.since;

  if (!("no-conduct" in flags)) {
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
      reread: (projects) => projectFilters(registered.filter((p) => projects.includes(p.project ?? "(unnamed)"))),
      subject: createSubjectResolver(),
      // The daemon's own directory. There is no worktree for an event — it is
      // not about a diff — and a subscriber that wants one has to make it.
      cwd: process.cwd(),
      log: (line) => console.log(line),
    });
    for (const line of declared.describe()) console.log(line);

    loop = createWorkLoop({
      log: (line) => console.log(line),
      subscribers: () => declared.subscribers(),
      // The third kind of agent, hosted here because the daemon is where money
      // is spent (0033 §3). Off the pass path: a question must not queue behind
      // a run, and it takes no claim and provisions nothing that would need to.
      discuss: (event) => onDiscussionRequested(event, (line) => console.log(line)),
      // Asked from the log every pass. A pause issued while a run is in flight
      // has to land at the next opportunity without anybody restarting this.
      paused: async () => (await readControl(undefined, since)).paused,
      // And a shutdown in the same breath, from the same fold (0030 §2). The
      // command appends and returns; this is where it lands.
      shutdown: async () => {
        const control = await readControl(undefined, since);
        asked = control.shutdown;
        // The start is recorded off this read and no other, before the first
        // pass it permits — see `startRecorder`.
        await noteStart(control);
        // The remedy in the sentence, because this is also what a daemon
        // started *after* an unwithdrawn request prints on its way straight
        // back out — and at that point it is the only thing worth knowing.
        // No remedy in the sentence any more. It used to say "lingtai resume
        // lifts it", because this was also what a daemon started *after* an
        // unwithdrawn request printed on its way straight back out. That start
        // cannot happen now: `since` makes an older request invisible, so
        // reaching here means somebody asked *this* daemon to stop, and they
        // know they did.
        return asked ? `asked by ${asked.by} — ${asked.reason}` : null;
      },
      // The loop has stopped taking work. What it cannot do is exit the
      // process, so the host does — after the drain `stop()` performs.
      // `--force` takes the other exit. `stopNow` is not new: it is where
      // `--timeout` already went when it tripped, so forcing asks for a state
      // the system already knows how to be in rather than inventing one.
      onShutdown: (why) =>
        asked?.force === true
          ? stopNow(`${why} — forced, so the pass is not finished. The agent is left running for the next conductor to kill.`)
          : void drain(why, asked?.timeoutMs ?? null),

      pass: async (reason) => {
        await declared.retry();
        const outcome = await conductorPass({
          merge: !("no-merge" in flags),
          // The commit read at startup, so a refusal on the log says which
          // process refused (#148).
          codeSha: code.sha,
          log: (line) => console.log(line),
        });
        // The run told GitHub as it went (0022), so there is nothing left
        // here to send and nothing to report about sending it.
        // A routine pass, in the accent — structure, not a verdict. What the
        // pass *decided* is coloured line by line above this; this one only
        // says the loop went round.
        console.log(
          paint.accent(
            `pass (${reason}): ${outcome.projects} project(s), ${outcome.ran} run(s)` +
              (outcome.refused.length > 0 ? `, ${outcome.refused.length} refused` : ""),
          ),
        );
      },
    });
    // **Scoped, like the loop's** (`#159`). It used to fold the whole stream,
    // so a daemon that had just started announced a pause from before it
    // existed and then took work anyway — the report and the loop disagreeing
    // about the same question, which is worse than either answer.
    //
    // A pause this daemon *will* obey is one somebody made after it started,
    // and that is the only one worth printing here. `lingtai status` keeps the
    // unscoped read, because it answers *what is standing* rather than *what
    // will this process do*.
    const control = await readControl(undefined, since);
    // Held, for the same reason `paused.tsx` wears `chip held`: nothing is
    // broken and a person stopped it.
    if (control.paused) console.log(paint.held(`paused by ${control.by} — ${control.reason}`));
    await loop.start();
    // A question asked while nothing was listening is waiting in the stream,
    // exactly as a pause is (0013). After `start`, so the subscription is
    // already up and a question that arrives during this one is not missed.
    const waiting = await answerOutstanding((line) => console.log(line)).catch((err: unknown) => {
      console.error(`discussions: ${(err as Error).message}`);
      return 0;
    });
    if (waiting > 0) console.log(`answered ${waiting} discussion(s) that were waiting`);
  } else {
    // Discussions go with the conductor, and that is what this flag says: they
    // spend money and 0033 §3 puts everything that spends money in the process
    // that takes work. A daemon told to take none answers none either.
    console.log(paint.muted("projections only — no work will be taken and no question answered"));

    // It still stops when it is told to. Nothing is in flight here — there is
    // no pass to finish — so this drain is over as soon as it begins, which is
    // the honest shape of "finish what you are holding" for a daemon holding
    // nothing.
    const hearShutdown = async (): Promise<void> => {
      const control = await readControl().catch(() => null);
      if (control) await noteStart(control);
      const standing = control?.shutdown ?? null;
      if (standing) await drain(`asked by ${standing.by} — ${standing.reason}`, standing.timeoutMs);
    };
    listening = setInterval(() => void hearShutdown(), HEARTBEAT_MS);
    // Asked once before waiting for the timer, so a daemon started after an
    // unwithdrawn request goes straight back out — as a conducting one does.
    await hearShutdown();
  }

  // The first signal drains and says so; the second stops now. `kill <pid>` is
  // the same two presses, because it used to be the worse of the two: it
  // reached the daemon alone, orphaned the agent, and took with it the code
  // that would have appended the outcome (#87).
  let signals = 0;
  const stop = (signal: string) => {
    signals += 1;
    if (signals === 1) {
      void drain(signal === "SIGINT" ? "ctrl-c" : signal, null);
      return;
    }
    stopNow("stopping now — its agent is left running, and the next conductor kills it.");
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  const reason = await started.daemon.stopped;
  if (reason === "projection-failed") {
    const failed = started.daemon.failure;
    console.error(`stopped: ${failed?.projection} failed — ${String(failed?.error)}`);
    return 1;
  }
  console.log("stopped");
  return 0;
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
 * ([0030](../../../doc/decisions/0030-shutting-down-safely.md)). Ctrl+C goes to
 * the whole foreground group, so before §3 detached the agent, the signal that
 * began the shutdown killed the run it claimed to be waiting for.
 *
 * **The one place that does not hold a projector**, and deliberately: a
 * projector catches up to the head before it returns, so a pause issued against
 * a daemon that has been down would replay the backlog before pausing anything.
 * See `withProjector` for the rule and for this exception.
 */
async function controlCommand(
  verb: "pause" | "resume" | "shutdown" | "now",
  args: string[],
): Promise<number> {
  // **`--help` is a question, never an instruction.** `lingtai shutdown --help`
  // took `--help` as the reason and stopped the daemon — asking what a command
  // does by doing it, on the one command whose cost is a running system. Caught
  // by typing it.
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }

  const { positional, flags } = parseFlags(args);
  const by = `human:${process.env["USER"] ?? "operator"}`;

  if (verb === "pause") {
    const reason = flags["reason"] ?? positional.join(" ");
    if (!reason.trim()) {
      // A pause with no reason is one nobody can undo confidently, because
      // nobody can tell whether the thing it was waiting for has happened.
      console.error("lingtai pause <why>  — a pause needs a reason");
      return 2;
    }
    await pauseCommand(by, reason);
    return 0;
  }

  if (verb === "resume") {
    await resumeConductor(by);
    console.log(paint.pass(`resumed by ${by}`));
    return 0;
  }

  if (verb === "shutdown") {
    // A reason is welcome and not required, unlike a pause's: a pause has to be
    // lifted by somebody who can tell whether the thing it was waiting for has
    // happened, and a shutdown is over when the process is.
    const reason = (flags["reason"] ?? positional.join(" ")).trim() || "no reason given";

    let timeoutMs: number | null = null;
    if ("timeout" in flags) {
      const text = flags["timeout"] ?? "";
      try {
        timeoutMs = parseDuration(text);
      } catch {
        console.error(`--timeout takes a duration like 30m or 90s, not "${text}"`);
        return 2;
      }
      if (timeoutMs <= 0) {
        console.error("--timeout takes a positive duration");
        return 2;
      }
    }

    // Safe is the default and `--force` is the loud one (`#159`). A command
    // whose ordinary form throws away a pass in flight is one people learn to
    // fear; this way the dangerous thing has to be asked for by name.
    const force = "force" in flags;
    if (force && "timeout" in flags) {
      console.error("--timeout is about waiting for the pass, and --force does not wait. Use one.");
      return 2;
    }

    await requestShutdown(by, reason, timeoutMs, undefined, force);
    console.log(paint.held(`shutdown asked by ${by} — ${reason}`));

    if (force) {
      // What `--timeout` has always done when it tripped, and what a second
      // Ctrl+C does. The orphan is the point, and it already has an owner.
      console.log("--force: it stops without finishing the pass. The agent is left running, and the next conductor kills it and releases the claim.");
      return 0;
    }

    // Said up front, because the alternative is a command that has returned
    // and a daemon that looks hung (0030 §6). What is being waited for is the
    // *pass* — the agent, then the gates, then the merge lane.
    const held = await inFlight().catch(() => []);
    console.log(
      timeoutMs === null
        // No "lingtai resume lifts it" any more (`#159`). It was true when the
        // request outlived the daemon it was aimed at; the next `lingtai start`
        // now needs nothing lifted, so saying otherwise would send a person to
        // a command that has nothing to do.
        ? `the daemon finishes the pass in flight first — ${describeInFlight(held)} — which can take as long as ${WALL_LIMIT}.`
        : `the daemon finishes the pass in flight — ${describeInFlight(held)} — or gives up after ${Math.round(timeoutMs / 1000)}s and exits with the agent still running, for the next conductor to kill.`,
    );
    return 0;
  }

  const project = positional[0];
  const issue = flags["issue"] ?? positional[1];
  if (!project || !issue) {
    console.error("lingtai now <project> --issue <n>");
    return 2;
  }
  await requestRun(project, issue, by);
  console.log(`requested ${project} #${issue}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "add":
      return addCommand(rest);
    case "run": {
      const { flags } = parseFlags(rest);
      const positional = rest.filter(
        (a) => !a.startsWith("--") && a !== flags["issue"] && a !== flags["max"],
      );
      const project = positional.find((p) => p !== "--once") ?? flags["project"];
      if (!project) {
        console.error("lingtai run <project> [--issue <n>] [--max <n>] [--no-merge]");
        return 2;
      }

      // `--once` with no `--issue` used to be the only mode. It now means the
      // same as `--max 1`: take the queue, but stop after one.
      const issue = "issue" in flags ? Number(flags["issue"]) : undefined;
      if (issue !== undefined && !Number.isInteger(issue)) {
        console.error("--issue takes a number");
        return 2;
      }
      const max =
        "max" in flags ? Number(flags["max"]) : "once" in flags && issue === undefined ? 1 : undefined;
      if (max !== undefined && (!Number.isInteger(max) || max < 1)) {
        console.error("--max takes a positive number");
        return 2;
      }

      return runOnceCommand({
        project,
        ...(issue === undefined ? {} : { issue }),
        ...(max === undefined ? {} : { max }),
        // `--no-merge` is absence of merging, so the flag's presence is the
              merge: !("no-merge" in flags),
      });
    }
    case "approve": {
      const { positional, flags } = parseFlags(rest);
      const issue = Number(flags["issue"]);
      if (!positional[0] || !Number.isInteger(issue)) {
        console.error("lingtai approve <project> --issue <n> [--note <text>]");
        return 2;
      }
      if ("reject" in flags) {
        // Gone (#150): it appended `ApprovalRevoked` and put the run straight
        // back into `awaiting-approval`, so the wait it seemed to end went on.
        console.error("--reject is gone: it asked the same question again and ended nothing.");
        console.error(`lingtai requeue ${positional[0]} --issue ${issue} --note <why> ends the wait with a new run`);
        return 2;
      }
      return approveCommand({ project: positional[0], issue, note: flags["note"] });
    }
    case "backlog":
      return backlogCommand(rest);
    case "requeue": {
      const { positional, flags } = parseFlags(rest);
      const issue = Number(flags["issue"]);
      if (!positional[0] || !Number.isInteger(issue)) {
        console.error("lingtai requeue <project> --issue <n> --note <why>");
        return 2;
      }
      // `--note` with nothing after it parses as the empty string, which is the
      // same silence as leaving the flag off — so both arrive as "" and the
      // command refuses them identically. Not defaulted here or there.
      return requeueCommand({ project: positional[0], issue, note: flags["note"] ?? "" });
    }
    case "ask":
    case "answer": {
      const { positional, flags } = parseFlags(rest);
      const issue = Number(flags["issue"]);
      const usage =
        command === "ask"
          ? `lingtai ask <project> --issue <n> "<question>"`
          : `lingtai answer <project> --issue <n> "<choice>"`;
      if (!positional[0] || !Number.isInteger(issue)) {
        console.error(usage);
        return 2;
      }
      // Everything after the project is the sentence, so an unquoted one still
      // arrives whole. Blank is refused by the command, not defaulted here.
      const text = positional.slice(1).join(" ");
      const options = { project: positional[0], issue, text };
      return command === "ask" ? askCommand(options) : answerCommand(options);
    }
    case "close": {
      const { positional, flags } = parseFlags(rest);
      const issue = Number(flags["issue"]);
      if (!positional[0] || !Number.isInteger(issue)) {
        console.error(`lingtai close <project> --issue <n> "<reason>"`);
        return 2;
      }
      // Everything after the project is the reason, as `ask` takes its question:
      // an unquoted sentence still arrives whole, and blank is refused by the
      // command rather than defaulted here.
      return closeCommand({ project: positional[0], issue, reason: positional.slice(1).join(" ") });
    }
    case "attach": {
      const runId = parseFlags(rest).positional[0];
      if (!runId) {
        console.error("lingtai attach <runId>");
        return 2;
      }
      // Ctrl-C detaches rather than killing the process, so the command gets to
      // say that the run is still going and where its log is. Nothing is being
      // stopped: this is a reader, and 0034's file does not know it has one.
      const detach = new AbortController();
      process.on("SIGINT", () => detach.abort());
      return attach({ runId, signal: detach.signal });
    }
    case "status": {
      const { positional, flags } = parseFlags(rest);
      return status({ project: positional[0], all: "all" in flags });
    }
    case "doctor":
      return doctor();
    // Positional throughout, and not through `parseFlags`: a value is an
    // argument here, and `KEY=--anything` is a legitimate one.
    case "env":
      return envCommand(rest);
    case "end": {
      const { positional, flags } = parseFlags(rest);
      // One subcommand, spelled out. `lingtai end` on its own would read like
      // an instruction to end something.
      if (positional[0] !== "replay") {
        console.error("lingtai end replay [<project>] [--issue <n>]");
        return 2;
      }
      const issue = "issue" in flags ? Number(flags["issue"]) : undefined;
      if (issue !== undefined && !Number.isInteger(issue)) {
        console.error("--issue takes a number");
        return 2;
      }
      return endReplay({
        ...(positional[1] === undefined ? {} : { project: positional[1] }),
        ...(issue === undefined ? {} : { issue }),
      });
    }
    case "start":
    // **`daemon` still answers, and that is not indecision** (`#159`). An
    // installed LaunchAgent or systemd unit has `lingtai daemon` written into
    // its plist, and renaming a command must not stop a supervisor that is
    // already on disk. `start` is the name; this is the one it used to have.
    case "daemon":
      return daemonCommand(parseFlags(rest).flags);
    case "service":
      return serviceCommand(rest, serviceOptions());
    case "restart": {
      const parsed = parseRestartArgs(rest);
      if (!parsed.ok) {
        console.error(parsed.message);
        return 2;
      }
      // Asked before anything stops, like every other refusal. Under launchd or
      // systemd the start is the supervisor's: a daemon started here would be a
      // conductor in a terminal beside the one it keeps (0042 §8).
      const kept = keeper();
      if ("unread" in kept) {
        console.log(paint.fail(`not restarting: ${kept.unread}. Nothing was asked to stop and nothing was stopped.`));
        return 1;
      }
      if (kept.kept && (parsed.args.noConduct || parsed.args.noMerge)) {
        console.error(
          `${kept.path} decides how the supervisor starts the daemon, so --no-conduct and --no-merge cannot reach it — ` +
            "pnpm lingtai service shutdown, then lingtai restart with them, runs one in this terminal instead",
        );
        return 2;
      }
      // Two halves of one command, and the seam is the only place a daemon is
      // started. `prepareRestart` refuses, drains and waits; everything after
      // this line is `lingtai daemon`, or the supervisor starting it.
      const prepared = await prepareRestart(parsed.args, console.log, kept.kept);
      if (!prepared.ok) return prepared.code;
      if (prepared.handedOff !== null) {
        return startSupervised(
          { by: prepared.by, handedOff: prepared.handedOff, examined: prepared.examined },
          { start: () => serviceCommand(["start"], serviceOptions()) },
        );
      }
      const flags: Record<string, string> = {
        ...(parsed.args.noConduct ? { "no-conduct": "" } : {}),
        ...(parsed.args.noMerge ? { "no-merge": "" } : {}),
      };
      return daemonCommand(flags, prepared);
    }
    case "pause":
      return controlCommand("pause", rest);
    case "resume":
      return controlCommand("resume", rest);
    case "shutdown":
      return controlCommand("shutdown", rest);
    case "now":
      return controlCommand("now", rest);
    case "projection":
      return projectionCommand(rest);
    case "version":
      console.log("lingtai 0.0.0");
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return command === undefined ? 2 : 0;
    default:
      console.error(`unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

/**
 * Every ending is a sentence, not a stack trace.
 *
 * The commands report their own refusals and return an exit code, but anything
 * that *throws* went straight to Node — which printed a stack, a file path and
 * a version banner over the one line that mattered. `lingtai add` against a
 * repository whose default branch has no recipe did exactly that, and the
 * README's claim that "every refusal names itself" was false for it.
 *
 * The stack is still there for the errors that are bugs rather than refusals;
 * it just has to be asked for.
 */
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  const error = err as Error;
  console.error(error.message || String(err));
  if (process.env["LINGTAI_DEBUG"]) console.error(error.stack);
  else console.error("\n(LINGTAI_DEBUG=1 for the stack)");
  process.exitCode = 1;
}
