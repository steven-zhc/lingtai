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
import {
  databaseUrl,
  directDatabaseUrl,
} from "@lingtai/event-store";
import { describeFilters, loadProjects, projectFilters } from "@lingtai/conductor";
import { taskViewProjection } from "@lingtai/projector";
import type { Tier } from "@lingtai/domain";
import {
  HEARTBEAT_MS,
  beat,
  clientsForProjects,
  createStatusTable,
  createNotifier,
  createWorkLoop,
  describeInFlight,
  inFlight,
  macNotifier,
  pauseConductor,
  readCodeVersion,
  readControl,
  reconcile,
  requestRun,
  requestShutdown,
  resumeConductor,
  startDaemon,
  type ShutdownRequest,
} from "@lingtai/daemon";
import { parseDuration } from "@lingtai/recipe";
import { paint } from "@lingtai/env/colour";
import { attach } from "./attach.ts";
import { conductorPass } from "./conduct.ts";
import { answerOutstanding, onDiscussionRequested } from "./discuss.ts";
import { add } from "./add.ts";
import { approveCommand } from "./approve.ts";
import { formatReport, runDoctor } from "./doctor.ts";
import { endReplay } from "./end.ts";
import { envCommand } from "./env.ts";
import { requeueCommand } from "./requeue.ts";
import { run as runOnceCommand } from "./run.ts";
import { status } from "./status.ts";

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
    lingtai approve <project> --issue <n>
                                merge what a held run produced, if its head has
                                not moved since the approval was asked for
    --note <text>               recorded with the approval
    --reject <why>              withdraw instead: back to the gate, not merged
  lingtai requeue <project> --issue <n> --note <why>
                                the move that is left when there is no diff to
                                approve: a blocked item goes back to the queue
                                and the next pass cuts a fresh branch from a
                                base that has since moved. --note is required —
                                a person overruling a block is not anonymous
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
  lingtai daemon                    hold the projections current and take work
    --no-conduct                projections only, take nothing
    --no-merge                  as for lingtai run
  lingtai pause <why>               stop taking new work; a run in flight finishes
  lingtai resume                    take work again, and lift a shutdown nobody
                                acted on
  lingtai shutdown [why]            finish the pass in flight, then stop
    --timeout <duration>        give up waiting after this and exit anyway,
                                leaving the agent running. No default: a drain
                                that gives up is the orphan this prevents
  lingtai now <project> --issue <n> ask for one ahead of the queue
  lingtai projection lag            how far each projection is behind the log
  lingtai projection rebuild <name> drop the table, reset the checkpoint, replay
  lingtai help
  lingtai version

Projections: ${taskViewProjection.name}
`;

/**
 * What a drain may cost, said before the waiting starts.
 *
 * Not read from a recipe: the drain belongs to the installation and the limit
 * belongs to whichever project happens to be running — so this names where the
 * number lives and the schema's default, rather than a number that would be
 * wrong for every project but one. `2h` is that default; this repository's own
 * recipe says `1h`.
 */
const WALL_LIMIT = "the recipe's runtime.limits.wall (2h by default)";

async function doctor(): Promise<number> {
  // Touching the loaders here rather than reading process.env keeps the one rule
  // about environment loading true even in the command that inspects it.
  const env = { ...process.env };
  try {
    env["DATABASE_URL"] = databaseUrl();
  } catch {
    delete env["DATABASE_URL"];
  }
  try {
    env["DIRECT_DATABASE_URL"] = directDatabaseUrl();
  } catch {
    delete env["DIRECT_DATABASE_URL"];
  }

  const report = await runDoctor(env);
  console.log(formatReport(report));
  // Non-zero on any failure, so this can gate a restart. A deferred check is not
  // a failure; a missing one would be.
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
  return add({ slug, base: flags["base"] });
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
    // Named, not looked up in a registry. There is one projection, and a list
    // of one was a list whose only job was to let a projection be written and
    // silently left out of it — no table, no checkpoint, no failing check
    // ([0022](../../../doc/decisions/0022-the-seams.md)). A second one is added
    // here, in the open, or it does not exist.
    if (name !== taskViewProjection.name) {
      console.error(`unknown projection "${name}" — known: ${taskViewProjection.name}`);
      return 2;
    }
    const projection = taskViewProjection;
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

/**
 * `lingtai daemon` — the process that holds the long-lived work.
 *
 * The follower used to live in this file, which meant nothing held it unless
 * somebody kept a terminal open. It is in `@lingtai/daemon` now, behind one
 * advisory lock, so this is the command and not the mechanism.
 *
 * Losing the lock exits 0. Running this while launchd's copy is up is a
 * reasonable thing to do, and answering it with an error would teach people to
 * ignore errors.
 */
async function daemonCommand(flags: Record<string, string> = {}): Promise<number> {
  const started = await startDaemon({
    projections: [taskViewProjection],
    log: (line) => console.log(line),
  });

  if (!started.ok) {
    // A refusal, and deliberately the quietest line the daemon has. Nothing is
    // wrong — red here would be the error that teaches people to ignore errors
    // — and nothing happened, so dim is the honest weight for it.
    console.log(
      paint.muted(`another daemon holds the lock${started.holder ? ` (${started.holder})` : ""} — nothing to do`),
    );
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
  await beat("starting", { code });
  console.log(
    `running ${code.sha ? code.sha.slice(0, 7) : "an unrecorded commit"}` +
      `${code.dirty ? " (worktree dirty)" : ""} — lingtai doctor says how far behind that is`,
  );

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
  for (const line of describeFilters(await projectFilters(registered))) console.log(line);

  const found = await reconcile({
    log: (line) => console.log(line),
    // Told what world it is repairing: which projections should be current,
    // which projects' claims are ours, and how to reach GitHub. Each check
    // no-ops without its own input rather than guessing at a global scan.
    projections: [taskViewProjection.name],
    projects: registered,
    github: { projects: registered, clients: await clientsForProjects(registered) },
  }).catch((err: unknown) => {
    // Reported, never fatal. Refusing to start because a directory could not be
    // removed would turn a mess into an outage.
    console.error(`reconcile failed: ${(err as Error).message}`);
    return [];
  });
  if (found.length > 0) console.log(paint.pass(`reconciled ${found.length} divergence(s)`));
  const heartbeat = setInterval(() => {
    void beat("up", { code }).catch(() => {});
  }, HEARTBEAT_MS);

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
    clearInterval(heartbeat);
    void (async () => {
      await beat("stopping", { code }).catch(() => {});
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
          ? `a pass is the agent, the gates and the merge lane, so this can take as long as ${WALL_LIMIT} — it is waiting, not hung.`
          : `giving up after ${Math.round(timeoutMs / 1000)}s if it has not finished, which leaves the agent running.`,
      ),
    );
    await beat("draining", { code }).catch(() => {});

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

    // The drain itself. No timeout around this one on purpose (§6).
    await loop?.stop();
    clearTimeout(timer);
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    await beat("stopping", { code }).catch(() => {});
    started.daemon.stop();
  };

  if (!("no-conduct" in flags)) {
    // Tell the operator when the operator is the bottleneck. Fire and forget:
    // a notification retried later, about a decision already made, trains you
    // to ignore the next one.
    const channel = await macNotifier();
    const notifier = createNotifier({ channel, log: (line) => console.log(line) });
    console.log(
      `notifications via ${channel.name}` +
        (channel.clickable ? "" : " — install terminal-notifier to make them clickable"),
    );

    loop = createWorkLoop({
      log: (line) => console.log(line),
      notify: (event) => notifier.consider(event),
      // The third kind of agent, hosted here because the daemon is where money
      // is spent (0033 §3). Off the pass path: a question must not queue behind
      // a run, and it takes no claim and provisions nothing that would need to.
      discuss: (event) => onDiscussionRequested(event, (line) => console.log(line)),
      // Asked from the log every pass. A pause issued while a run is in flight
      // has to land at the next opportunity without anybody restarting this.
      paused: async () => (await readControl()).paused,
      // And a shutdown in the same breath, from the same fold (0030 §2). The
      // command appends and returns; this is where it lands.
      shutdown: async () => {
        asked = (await readControl()).shutdown;
        // The remedy in the sentence, because this is also what a daemon
        // started *after* an unwithdrawn request prints on its way straight
        // back out — and at that point it is the only thing worth knowing.
        return asked ? `asked by ${asked.by} — ${asked.reason} (lingtai resume lifts it)` : null;
      },
      // The loop has stopped taking work. What it cannot do is exit the
      // process, so the host does — after the drain `stop()` performs.
      onShutdown: (why) => void drain(why, asked?.timeoutMs ?? null),

      pass: async (reason) => {
        const outcome = await conductorPass({
          merge: !("no-merge" in flags),
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
    const control = await readControl();
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
    await pauseConductor(by, reason);
    console.log(paint.held(`paused by ${by} — ${reason}`));
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

    await requestShutdown(by, reason, timeoutMs);
    console.log(paint.held(`shutdown asked by ${by} — ${reason}`));

    // Said up front, because the alternative is a command that has returned
    // and a daemon that looks hung (0030 §6). What is being waited for is the
    // *pass* — the agent, then the gates, then the merge lane.
    const held = await inFlight().catch(() => []);
    console.log(
      timeoutMs === null
        ? `the daemon finishes the pass in flight first — ${describeInFlight(held)} — which can take as long as ${WALL_LIMIT}. lingtai resume lifts it.`
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
      return approveCommand({
        project: positional[0],
        issue,
        note: flags["note"],
        ...("reject" in flags ? { reject: flags["reject"] ?? "no reason given" } : {}),
      });
    }
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
    case "daemon":
      return daemonCommand(parseFlags(rest).flags);
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
