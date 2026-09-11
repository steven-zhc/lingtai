/**
 * `lingtai restart [why]` — the drain, the wait, and the start, as one command.
 *
 * [0030](../../../doc/decisions/0030-shutting-down-safely.md) made stopping
 * safe: `lingtai shutdown` appends, returns, and the daemon finishes the pass in
 * flight before it exits. **Starting again was still something you typed from
 * memory, at a moment nothing told you had arrived** — and the start is where a
 * process's code identity is decided, for the whole of its life, with nothing
 * checking it ([0038](../../../doc/decisions/0038-the-restart-is-a-command.md)).
 *
 * On 2026-09-09 a daemon was restarted at 23:06 from `582a0f8`, a commit that
 * had not been pushed. A `git pull --rebase` twenty minutes later rewrote it to
 * `2926f2d`, so `lingtai doctor` reported the running commit as *5 commit(s)
 * behind origin/main* while that commit was not reachable from `origin/main` at
 * all. Nobody can say who restarted it either, because stopping is an event and
 * starting was only a beacon.
 *
 * ## The order is the design
 *
 *   1. **the checks, before anything stops.** A refusal after the drain is a
 *      system that is down and a person reading about why it may not come back
 *      up. Everything that can refuse runs while the old daemon is still
 *      conducting.
 *   2. **the drain**, which is `lingtai shutdown`'s own append — not a second
 *      mechanism. The wait says what it is waiting for and Ctrl+C leaves the
 *      request standing.
 *   3. **the withdrawal.** The request stands in the stream for ever, so the
 *      daemon this is about to start would read it and stop again.
 *   4. **the start**, which is `lingtai daemon` in this process. What makes it
 *      *exactly one* is the advisory lock (#93) and not any sequencing here: if
 *      launchd's `KeepAlive` got there first, this says so and starts nothing.
 *
 * ## What it does not do
 *
 * It does not fetch, and it does not restart anything by itself. `origin/main`
 * means the ref as your last fetch left it — the rule `lingtai doctor` and the
 * currency check already keep — and a daemon noticing its own code has gone
 * stale is a decision 0038 deliberately leaves open.
 */
import {
  STALE_AFTER_MS,
  WALL_LIMIT,
  codeIdentity,
  conductorLockHolder,
  describeInFlight,
  identityRefusals,
  inFlight,
  readControl,
  readStatus,
  requestShutdown,
  withdrawShutdown,
  type Identity,
  type ShutdownRequest,
} from "@lingtai/daemon";
import { parseDuration } from "@lingtai/recipe";
import { paint } from "@lingtai/env/colour";
import { doctorReport } from "./doctor.ts";

/** How often the lock is asked about while a drain is in flight. */
const POLL_MS = 2_000;

/** How often the wait repeats itself, so that it never reads as hung. */
const SAY_EVERY_MS = 30_000;

/**
 * After a `--timeout` trips, how long the old process is given to let go.
 *
 * The timeout is the daemon's, not this command's: when it trips the daemon
 * stops taking work and exits, which releases the lock. This is only the margin
 * for that exit, so that a `--timeout` cannot turn into an unbounded wait on a
 * process that is ignoring it.
 */
const RELEASE_GRACE_MS = 30_000;

/** Everything the command had to go and find out before it could decide. */
export interface Before {
  /** The commit a daemon started here would freeze. */
  identity: Identity;
  /** How many `lingtai doctor` checks failed. A note is not a failure. */
  doctorFailed: number;
  /** Who is conducting, from `pg_locks`, or null when nobody is. */
  conducting: string | null;
  /** A beacon fresh enough to mean a daemon is up to receive a drain. */
  daemonUp: boolean;
  /** A drain somebody else already asked for, when one stands. */
  shutdown: ShutdownRequest | null;
}

/**
 * What to do about it.
 *
 * Pure, and separated from the doing for the reason `reduceControl` is: the
 * rules are the part worth asserting, and asserting them must not need a
 * daemon, a database or a drain.
 */
export type Plan =
  | {
      go: "refuse";
      because: string[];
      /** Whether `--anyway` would have got past this. A standing drain is not waivable. */
      waivable: boolean;
    }
  | {
      go: "drain" | "wait" | "start";
      /** Refusals `--anyway` waved through. Said anyway — that is the whole of the flag. */
      overridden: string[];
    };

export interface RestartFlags {
  /** Start in spite of a refusal about the code. Deliberate, never by accident. */
  anyway: boolean;
}

/**
 * The rules, in one function.
 *
 * `--anyway` covers what this command can only have an opinion about — the
 * commit, the worktree, the doctor. It deliberately does not cover a drain
 * somebody else asked for: that is another person's decision about this system,
 * and the command that lifts it is theirs to have meant. `lingtai resume`.
 */
export function planRestart(before: Before, flags: RestartFlags): Plan {
  const waivable = identityRefusals(before.identity);
  if (before.doctorFailed > 0) {
    waivable.push(
      `lingtai doctor reports ${before.doctorFailed} failed check(s) — a restart onto a system that ` +
        `cannot pass its own checks is how a stopped daemon becomes a stopped system`,
    );
  }

  if (before.shutdown) {
    return {
      go: "refuse",
      waivable: false,
      because: [
        `a shutdown asked by ${before.shutdown.by} — ${before.shutdown.reason} — is already standing. ` +
          `Somebody asked this system to stop, and restarting over that would be this command ` +
          `deciding for them. lingtai resume lifts it, and then this will start`,
        ...waivable,
      ],
    };
  }

  if (waivable.length > 0 && !flags.anyway) return { go: "refuse", because: waivable, waivable: true };

  // A beacon is what makes a drain meaningful: `ConductorShutdownRequested` is
  // read by a daemon and by nothing else. Something else holding the lock — a
  // `lingtai run` in a terminal — is waited out rather than asked, because
  // asking it would append a request nothing would ever read.
  if (before.daemonUp) return { go: "drain", overridden: waivable };
  if (before.conducting !== null) return { go: "wait", overridden: waivable };
  return { go: "start", overridden: waivable };
}

/** What the command hands back to the entry point, which is where a daemon is started. */
export type Prepared =
  | { ok: true; by: string; reason: string }
  | { ok: false; code: number };

export interface RestartArgs {
  positional: string[];
  flags: Record<string, string>;
}

/**
 * Everything up to the start. The start itself is `lingtai daemon`, unchanged.
 *
 * Split there rather than calling the daemon from here because there must be
 * exactly one piece of code that starts a daemon: a second one would be a second
 * place for the beacon, the reconcile and the `ConductorStarted` append to drift
 * apart from.
 */
export async function prepareRestart(
  args: RestartArgs,
  log: (line: string) => void = console.log,
): Promise<Prepared> {
  const by = `human:${process.env["USER"] ?? "operator"}`;
  const reason = (args.flags["reason"] ?? args.positional.join(" ")).trim() || "no reason given";

  let timeoutMs: number | null = null;
  if ("timeout" in args.flags) {
    const text = args.flags["timeout"] ?? "";
    try {
      timeoutMs = parseDuration(text);
    } catch {
      log(`--timeout takes a duration like 30m or 90s, not "${text}"`);
      return { ok: false, code: 2 };
    }
    if (timeoutMs <= 0) {
      log("--timeout takes a positive duration");
      return { ok: false, code: 2 };
    }
  }

  // Asked before anything is stopped. Every one of these can refuse, and a
  // refusal that arrives after the drain is a system somebody has to bring back
  // up by hand — which is the failure this command exists to remove.
  const identity = await codeIdentity();
  log(
    paint.muted(
      `this would start ${identity.sha ? identity.sha.slice(0, 7) : "an unrecorded commit"}` +
        `${identity.dirty ? " (worktree dirty)" : ""}, checked against ${identity.base}`,
    ),
  );

  // The gate the exit code at `doctor`'s call site was written for and never
  // had a caller. The same report the command prints, from the same function,
  // so the two cannot disagree about whether this system is well.
  const report = await doctorReport();
  log(formatFailures(report.results, report.failed));

  const before: Before = {
    identity,
    doctorFailed: report.failed,
    conducting: await conductorLockHolder().catch(() => null),
    daemonUp: await daemonIsUp(),
    shutdown: (await readControl().catch(() => null))?.shutdown ?? null,
  };

  const plan = planRestart(before, { anyway: "anyway" in args.flags });

  if (plan.go === "refuse") {
    log(paint.fail("not restarting:"));
    for (const line of plan.because) log(paint.fail(`  · ${line}`));
    log(
      plan.waivable
        ? paint.muted("--anyway starts in spite of these, when you have read them and mean it.")
        : paint.muted("lingtai resume lifts the request, and then this will start."),
    );
    return { ok: false, code: 1 };
  }

  for (const line of plan.overridden) log(paint.signal(`--anyway: ${line}`));

  if (plan.go === "drain") {
    await requestShutdown(by, `restarting: ${reason}`, timeoutMs);
    const held = await inFlight().catch(() => []);
    log(paint.held(`draining ${before.conducting ?? "the daemon"} — ${describeInFlight(held)}.`));
    log(
      paint.muted(
        timeoutMs === null
          ? `a pass is the agent, the gates and the merge lane, so this can take as long as ${WALL_LIMIT} — it is waiting, not hung.`
          : `the daemon gives up after ${Math.round(timeoutMs / 1000)}s and exits with its agent still running, which the next conductor kills.`,
      ),
    );
  } else if (plan.go === "wait") {
    // Not a daemon, so nothing reads a drain request. A `lingtai run` in a
    // terminal is a conductor (#93) and finishes on its own.
    log(paint.held(`${before.conducting} is conducting and is not a daemon — waiting for it to finish.`));
    log(paint.muted("nothing was asked to stop: a shutdown request is read by a daemon and by nothing else."));
  }

  if (plan.go !== "start") {
    const waited = await waitForTheLock(
      plan.go === "drain" ? "draining" : "waiting",
      timeoutMs === null ? null : timeoutMs + RELEASE_GRACE_MS,
      log,
    );

    if (waited === "interrupted") {
      log(
        plan.go === "drain"
          ? paint.held(
              `stopped waiting. The shutdown asked by ${by} is still standing — the daemon will finish its pass and exit. ` +
                `lingtai resume lifts it; lingtai restart starts again.`,
            )
          : paint.held("stopped waiting. Nothing was asked to stop and nothing was started."),
      );
      return { ok: false, code: 130 };
    }

    if (waited === "gave-up") {
      log(
        paint.fail(
          `the lock is still held after the timeout — nothing was started. ` +
            `The request is still standing; lingtai resume lifts it.`,
        ),
      );
      return { ok: false, code: 1 };
    }
  }

  // Before the start and after the drain, in that order: a daemon started while
  // the request stands reads it and stops again, which is the behaviour the loop
  // is meant to have and exactly the wrong one here.
  const lifted = await withdrawShutdown(by);
  if (lifted.withdrew) log(paint.muted(`withdrew the drain — ${lifted.withdrew.by}: ${lifted.withdrew.reason}`));
  if (lifted.restored) {
    // Said, not silent. `ConductorResumed` is the only withdrawal and it lifts a
    // pause too, so the pause is put back — and the new daemon will start
    // holding it, which is a thing to be told rather than to discover.
    log(
      paint.held(
        `the pause by ${lifted.restored.by} — ${lifted.restored.reason} — was restored: ` +
          `the daemon starting now takes no work until it is resumed.`,
      ),
    );
  }

  return { ok: true, by, reason };
}

/** A beacon nobody has written to for three beats is not a daemon to ask anything of. */
async function daemonIsUp(): Promise<boolean> {
  const status = await readStatus().catch(() => null);
  if (!status) return false;
  return Date.now() - status.lastSeenAt.getTime() <= STALE_AFTER_MS;
}

/**
 * Wait for whoever is conducting to let go, saying what is being waited for.
 *
 * The lock and not the beacon, for the reason #93 put `lingtai run` behind the
 * same lock: the question is *is anything conducting*, and a beacon only answers
 * it for one of the two kinds of conductor. It is also the thing the start has
 * to win, so waiting on anything else would be waiting on a proxy.
 */
async function waitForTheLock(
  /** What to call it in the repeated line: a drain was asked for, or it was not. */
  doing: "draining" | "waiting",
  giveUpAfterMs: number | null,
  log: (line: string) => void,
): Promise<"free" | "interrupted" | "gave-up"> {
  const began = Date.now();
  let said = began;
  let interrupted = false;

  // Left standing on purpose. The request is in the log, so the drain it asked
  // for carries on without this process — what Ctrl+C ends is the waiting.
  const onSignal = (): void => {
    interrupted = true;
  };
  process.on("SIGINT", onSignal);

  try {
    for (;;) {
      const holder = await conductorLockHolder().catch(() => null);
      if (holder === null) return "free";
      if (interrupted) return "interrupted";
      if (giveUpAfterMs !== null && Date.now() - began > giveUpAfterMs) return "gave-up";

      if (Date.now() - said >= SAY_EVERY_MS) {
        said = Date.now();
        const held = await inFlight().catch(() => []);
        log(
          paint.muted(
            `still ${doing} after ${Math.round((Date.now() - began) / 1000)}s — ${describeInFlight(held)}. ` +
              `ctrl-c stops waiting and leaves whatever was asked for standing.`,
          ),
        );
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (interrupted) return "interrupted";
    }
  } finally {
    process.off("SIGINT", onSignal);
  }
}

/**
 * What failed, and nothing else.
 *
 * `formatReport` prints every check, which is right for `lingtai doctor` and
 * wrong in the middle of a restart: thirty green lines between the command and
 * the drain is how the two red ones get scrolled past.
 */
function formatFailures(
  results: readonly { name: string; status: string; detail: string }[],
  failed: number,
): string {
  if (failed === 0) return paint.pass("doctor: nothing failed");
  return [
    paint.fail(`doctor: ${failed} check(s) FAILED`),
    ...results
      .filter((r) => r.status === "fail")
      .map((r) => paint.fail(`  · ${r.name}: ${r.detail}`)),
  ].join("\n");
}
