/**
 * `lingtai restart [why]` — the drain, the wait, and the start, as one command.
 *
 * [0030](../../../doc/decisions/0030-shutting-down-safely.md) made stopping
 * safe: `lingtai shutdown` appends, returns, and the daemon finishes the pass in
 * flight before it exits. **Starting again was still something you typed from
 * memory, at a moment nothing told you had arrived** — and the start is where a
 * process's code identity is decided, for the whole of its life, with nothing
 * checking it ([0042](../../../doc/decisions/0042-the-restart-is-a-command.md)).
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
 *      up. Everything that can refuse runs while the old daemon still conducts.
 *   2. **the drain**, which is `lingtai shutdown`'s own append — not a second
 *      mechanism. The wait says what it is waiting for and Ctrl+C leaves the
 *      request standing.
 *   3. **the checks again**, on the commit and the worktree, because a drain can
 *      take an hour and those are what the start freezes. They must also still
 *      be what the first check read, because that is the code this process
 *      imported: a pull during the drain moves the disk and not the process. The
 *      daemon compares what it actually read against what was examined here, so
 *      the commit on `ConductorStarted` is one a refusal looked at and the one
 *      that is running.
 *   4. **the start**, which is `lingtai start` in this process — or, where
 *      `lingtai service` keeps the daemon, the supervisor's, handed the checked
 *      commit and this person's name on the drain itself (0042 §8). What makes
 *      it *never two* is the advisory lock (#93) and not any sequencing here: if
 *      anything got there first, this starts nothing and exits non-zero, since
 *      what won may leave no daemon (0042 §6).
 *
 * ## It is `shutdown` and then `start`, in what it appends
 *
 * A `ConductorShutdownRequested` and a `ConductorStarted`, and nothing between
 * them that another event has to undo
 * ([0045](../../../doc/decisions/0045-a-request-ends-at-the-next-start.md)).
 * There used to be a withdrawal of the request before the start, because a
 * request outlived its daemon and the new one would have read it and stopped.
 * A start ends a request now, so what is left of 0042's sequence is what was
 * never about control state: the checks, before and after the wait.
 *
 * **Under a supervisor the check after the wait is a comparison, not a
 * refusal.** launchd's `KeepAlive` and systemd's `Restart=always` start the next
 * daemon the moment the drained one exits, and nothing holds that start back —
 * holding it back is the latch `#159` removed. So the supervised restart waits
 * for a start to be recorded, and exits 0 only when it is this restart's, on the
 * commit that was checked; anything else it names, and exits non-zero.
 *
 * ## One flag per refusal
 *
 * A dirty worktree can be overridden with `--dirty`, and a failed doctor with
 * `--despite-doctor`. **Nothing overrides a commit that is not on the remote**,
 * or one that could not be checked: that is the defect this command exists to
 * close, and a single `--anyway` covering it and an unrelated doctor failure
 * together is how the flag that disables it becomes a habit.
 *
 * ## What it does not do
 *
 * It does not fetch, and it does not restart anything by itself. `origin/main`
 * means the ref as your last fetch left it — the rule `lingtai doctor` and the
 * currency check already keep — and a daemon noticing its own code has gone
 * stale is a decision 0042 deliberately leaves open.
 */
import {
  STALE_AFTER_MS,
  codeIdentity,
  conductorLockHolder,
  describeInFlight,
  identityRefusals,
  inFlight,
  readControl,
  readStatus,
  requestShutdownUnlessStanding,
  startAfter,
  type CodeVersion,
  type ControlState,
  type Identity,
  type RecordedStart,
  type ShutdownRequest,
  type StartDecision,
} from "@lingtai/daemon";
import { parseDuration } from "@lingtai/recipe";
import { paint } from "@lingtai/env/colour";
import { doctorReport } from "./doctor.ts";
import { WALL_LIMIT } from "./wall-limit.ts";

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

// ---------------------------------------------------------------- the line --

/** What the command line asked for, parsed against the flags this command has. */
export interface RestartArgs {
  reason: string;
  timeoutMs: number | null;
  /** Start from a worktree with uncommitted changes. Waives that and nothing else. */
  dirty: boolean;
  /** Start in spite of failed `lingtai doctor` checks. Waives that and nothing else. */
  despiteDoctor: boolean;
  noConduct: boolean;
  noMerge: boolean;
  /**
   * Stop without letting the pass in flight finish (`#159`).
   *
   * Safe is the default here as it is for `shutdown`: a restart that threw away
   * a run every time would be a command nobody reaches for while anything is
   * happening, which is exactly when a restart is wanted.
   */
  force: boolean;
}

const BOOLEAN_FLAGS = ["dirty", "despite-doctor", "no-conduct", "no-merge", "force"] as const;
const VALUE_FLAGS = ["timeout", "reason"] as const;

/**
 * The line, read against the flags this command actually has.
 *
 * Not the entry point's `parseFlags`, whose rule is that a flag followed by a
 * word takes the word as its value: `lingtai restart --dirty picking up #88`
 * would record `dirty: "picking"` and a reason of `up #88`, or with the word
 * alone no reason at all — and the reason is what `ConductorStarted` carries. A
 * boolean here never consumes anything, and a flag this command does not have
 * is refused rather than silently kept.
 */
export function parseRestartArgs(
  argv: readonly string[],
): { ok: true; args: RestartArgs } | { ok: false; message: string } {
  const words: string[] = [];
  const seen = new Set<string>();
  const values: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      words.push(a);
      continue;
    }
    const name = a.slice(2);
    if ((BOOLEAN_FLAGS as readonly string[]).includes(name)) {
      seen.add(name);
    } else if ((VALUE_FLAGS as readonly string[]).includes(name)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return { ok: false, message: `--${name} takes a value` };
      values[name] = next;
      i++;
    } else if (name === "anyway") {
      return {
        ok: false,
        message:
          "--anyway is gone: it waived everything at once. --dirty overrides a dirty worktree, " +
          "--despite-doctor a failed doctor, and nothing overrides a commit that is not on the remote",
      };
    } else {
      return { ok: false, message: `lingtai restart has no --${name}` };
    }
  }

  let timeoutMs: number | null = null;
  if (values["timeout"] !== undefined) {
    const text = values["timeout"];
    try {
      timeoutMs = parseDuration(text);
    } catch {
      return { ok: false, message: `--timeout takes a duration like 30m or 90s, not "${text}"` };
    }
    if (timeoutMs <= 0) return { ok: false, message: "--timeout takes a positive duration" };
  }

  return {
    ok: true,
    args: {
      reason: (values["reason"] ?? words.join(" ")).trim() || "no reason given",
      timeoutMs,
      dirty: seen.has("dirty"),
      despiteDoctor: seen.has("despite-doctor"),
      noConduct: seen.has("no-conduct"),
      noMerge: seen.has("no-merge"),
      force: seen.has("force"),
    },
  };
}

// --------------------------------------------------------------- the rules --

/** Everything the command had to go and find out before it could decide. */
export interface Before {
  /** Who is running this command — `human:$USER`, as `lingtai shutdown` records it. */
  by: string;
  /** The commit a daemon started here would freeze. */
  identity: Identity;
  /** How many `lingtai doctor` checks failed. A note is not a failure. */
  doctorFailed: number;
  /** Who is conducting, from `pg_locks`, or null when nobody is. */
  conducting: string | null;
  /** A beacon fresh enough to mean a daemon is up to receive a drain. */
  daemonUp: boolean;
  /** A drain that already stands, whoever asked for it. */
  shutdown: ShutdownRequest | null;
  /**
   * The commit and worktree this process imported its code from — the first
   * read, before anything else — or null when `identity` *is* that read.
   *
   * A process holds the code it imported, whatever the disk says later. After a
   * drain `identity` is the disk now, and a start that recorded it while
   * running `loaded` would name code that is not running.
   */
  loaded: Pick<CodeVersion, "sha" | "dirty"> | null;
}

/** One reason not to start, and the one flag that overrides it — or null, for none. */
export interface Refusal {
  line: string;
  waiver: "--dirty" | "--despite-doctor" | null;
}

/**
 * What to do about it.
 *
 * Pure, and separated from the doing for the reason `reduceControl` is: the
 * rules are the part worth asserting, and asserting them must not need a
 * daemon, a database or a drain.
 */
export type Plan =
  | { go: "refuse"; because: Refusal[] }
  | {
      go: "drain" | "wait" | "start";
      /** Refusals a flag waved through. Said anyway — that is the whole of the flag. */
      overridden: string[];
      /**
       * A drain this same person already asked for, taken over rather than asked
       * for twice. What makes the recovery the interrupt message prints true:
       * Ctrl+C leaves the request standing, and the next `lingtai restart` by
       * the same hand waits on it and starts.
       */
      adopted: ShutdownRequest | null;
    };

export interface Waivers {
  dirty: boolean;
  despiteDoctor: boolean;
}

/**
 * The rules, in one function.
 *
 * Each refusal names the one flag that overrides it, and three have none: a
 * commit that is not on the remote, a commit that could not be checked, and a
 * drain **somebody else** asked for — that is another person's decision about
 * this system, and the command that lifts it is theirs to have meant.
 */
export function planRestart(before: Before, waivers: Waivers): Plan {
  const refusals: Refusal[] = identityRefusals(before.identity).map((r) => ({
    line: r.line,
    waiver: r.what === "dirty" ? "--dirty" : null,
  }));

  // No flag: `--dirty` waiving this would put a commit on `ConductorStarted`
  // that the process is not running, which is the defect and not a risk of it.
  const loaded = before.loaded;
  if (loaded !== null && (loaded.sha !== before.identity.sha || loaded.dirty !== before.identity.dirty)) {
    refusals.unshift({
      line:
        `the checkout moved while this waited — this process loaded ${describeIdentity(loaded)} and the disk is now ` +
        `${describeIdentity(before.identity)}. Node holds the code it imported, so a daemon started here would run ` +
        `the first and record the second. Run lingtai restart again, which loads what is there now`,
      waiver: null,
    });
  }

  if (before.doctorFailed > 0) {
    refusals.push({
      line:
        `lingtai doctor reports ${before.doctorFailed} failed check(s) — a restart onto a system that ` +
        `cannot pass its own checks is how a stopped daemon becomes a stopped system`,
      waiver: "--despite-doctor",
    });
  }

  const standing = before.shutdown;
  const adopted = standing !== null && standing.by === before.by ? standing : null;
  if (standing !== null && adopted === null) {
    refusals.unshift({
      line:
        `a shutdown asked by ${standing.by} — ${standing.reason} — is already standing. ` +
        `Somebody asked this system to stop, and restarting over that would be this command ` +
        `deciding for them. lingtai resume lifts it, and then this will start`,
      waiver: null,
    });
  }

  const waived = (r: Refusal): boolean =>
    (r.waiver === "--dirty" && waivers.dirty) || (r.waiver === "--despite-doctor" && waivers.despiteDoctor);

  const blocking = refusals.filter((r) => !waived(r));
  if (blocking.length > 0) return { go: "refuse", because: blocking };
  const overridden = refusals.filter(waived).map((r) => `${r.waiver}: ${r.line}`);

  // A fresh beacon says a daemon is up to receive a drain. The lock held with
  // no fresh beacon is a `lingtai run` in a terminal — or a daemon whose beacon
  // writes have been failing while it keeps its lock — and the two cannot be
  // told apart from here, so `wait` asks the drain too (`prepareRestart`): a
  // daemon reads it, and a `lingtai run` finishes its one pass regardless.
  if (before.daemonUp) return { go: "drain", overridden, adopted };
  if (before.conducting !== null) return { go: "wait", overridden, adopted };
  return { go: "start", overridden, adopted };
}

// --------------------------------------------------------------- the doing --

/** What the entry point needs to start a daemon, which is where a daemon is started. */
export type Prepared =
  | ({
      ok: true;
      by: string;
      reason: string;
      /**
       * The commit and worktree the checks examined. A daemon started here
       * compares what it actually reads against this and starts nothing on a
       * difference; a supervised restart compares the start that was recorded.
       */
      examined: CodeVersion;
    } & (
      | {
          supervised: false;
          /** This restart's drain, which its start ends — or null, when nothing was asked. */
          request: number | null;
        }
      | {
          /** The start is launchd's or systemd's (0042 §8), and ends this request. */
          supervised: true;
          request: number;
        }
    ))
  | { ok: false; code: number };

/**
 * Everything up to the start. The start itself is `lingtai start`, unchanged.
 *
 * Split there rather than calling the daemon from here because there must be
 * exactly one piece of code that starts a daemon: a second one would be a second
 * place for the beacon, the reconcile and the `ConductorStarted` append to drift
 * apart from.
 */
export async function prepareRestart(
  args: RestartArgs,
  log: (line: string) => void = console.log,
  /**
   * A supervisor keeps the daemon, so the start is its to make (0042 §8). The
   * drain is asked even when nothing is conducting — the request is what
   * carries the handoff, and what the supervisor's start is recognised by.
   */
  supervised = false,
): Promise<Prepared> {
  const by = `human:${process.env["USER"] ?? "operator"}`;
  const waivers: Waivers = { dirty: args.dirty, despiteDoctor: args.despiteDoctor };

  // Asked before anything is stopped. Every one of these can refuse, and a
  // refusal that arrives after the drain is a system somebody has to bring back
  // up by hand — which is the failure this command exists to remove.
  const identity = await codeIdentity();
  log(paint.muted(`this would start ${describeIdentity(identity)}, checked against ${identity.base}`));

  // The gate the exit code at `doctor`'s call site was written for and never
  // had a caller. The same report the command prints, from the same function,
  // so the two cannot disagree about whether this system is well.
  const report = await doctorReport();
  // Not `report.failed`. A failure whose own remedy is *restart the daemon* —
  // a pass refused by code older than this checkout (#148) — is the reason for
  // this command, and gating on it would make `--despite-doctor` the ordinary
  // way to take a fix: the habit that then hides a failure that is real.
  const gating = gatingFailures(report.results);
  log(formatFailures(report.results, gating));

  // A failed query is not an empty lock. Read as "nobody is conducting" it would
  // plan a start beside a daemon that is up, so it refuses — nothing has been
  // stopped yet, which is what makes refusing here free.
  let conducting: string | null;
  try {
    conducting = await conductorLockHolder();
  } catch (err) {
    sayRefusal("not restarting:", [
      {
        line:
          `who is conducting could not be asked — ${(err as Error).message}. Nothing was asked to stop ` +
          `and nothing was stopped. lingtai restart asks again`,
        waiver: null,
      },
    ], log);
    return { ok: false, code: 1 };
  }

  // The same rule for the beacon. Read as "no daemon" it would plan a wait with
  // nothing asked to stop, on a process that never exits by itself.
  let daemonUp: boolean;
  try {
    daemonUp = await daemonIsUp();
  } catch (err) {
    sayRefusal("not restarting:", [
      {
        line:
          `whether a daemon is up could not be read — ${(err as Error).message}. Nothing was asked to stop ` +
          `and nothing was stopped. lingtai restart asks again`,
        waiver: null,
      },
    ], log);
    return { ok: false, code: 1 };
  }

  const before: Before = {
    by,
    identity,
    doctorFailed: gating,
    conducting,
    daemonUp,
    shutdown: (await readControl().catch(() => null))?.shutdown ?? null,
    // `identity` is the first thing this command read, so it is the loaded code.
    loaded: null,
  };

  const plan = planRestart(before, waivers);
  if (plan.go === "refuse") {
    sayRefusal("not restarting:", plan.because, log);
    return { ok: false, code: 1 };
  }
  for (const line of plan.overridden) log(paint.signal(line));

  /** The version of the request this command is waiting on, when there is one. */
  let request: number | null = plan.adopted?.version ?? null;
  /**
   * The timeout the daemon acts on, which is the standing request's — never this
   * invocation's flag when the request was not made by this invocation.
   */
  let drainTimeoutMs: number | null = plan.adopted ? plan.adopted.timeoutMs : args.timeoutMs;

  if (plan.adopted) {
    log(
      paint.held(
        plan.go === "start"
          ? `a shutdown you asked for is still standing (${plan.adopted.reason}) and nothing is conducting — the start ends it.`
          : `a shutdown you asked for is already standing (${plan.adopted.reason}) — waiting on that one rather than asking twice.`,
      ),
    );
    // The handoff rides on the request, and this one was asked before these
    // checks — by a `lingtai shutdown`, or a restart that checked other code.
    // The supervisor's start is recorded off that request, so say now what the
    // comparison at the end will say, rather than only failing there.
    const handoff = plan.adopted.handoff;
    if (supervised && (handoff === null || handoff.sha !== identity.sha || handoff.dirty !== identity.dirty)) {
      log(
        paint.signal(
          handoff === null
            ? "that request carries no restart's commit, so the supervisor's start will be recorded as daemon and not as this restart."
            : `that request's restart checked ${describeIdentity(handoff)}, not ${describeIdentity(identity)}, so the start will not be recorded as this restart.`,
        ),
      );
    }
  }

  if (plan.go === "drain" || plan.go === "wait" || (supervised && request === null)) {
    if (plan.go === "wait") {
      // Not "is not a daemon": a stale beacon cannot say that. A daemon whose
      // beacon has stopped landing still holds its lock and never exits on its
      // own, so waiting on it without asking would be a wait with no end.
      log(
        paint.held(
          `${before.conducting} is conducting and no daemon's beacon is fresh — a lingtai run, or a daemon whose ` +
            `beacon is not landing. A drain is asked either way: a daemon reads it, and a lingtai run finishes its pass regardless.`,
        ),
      );
    }
    if (request === null) {
      // The decision and the append are one write: the plan read no standing
      // request, but one may have landed since, and the fold keeps only the
      // newest — so appending over it would hide somebody else's drain behind
      // this restart's, and the start would then end both without anybody
      // having read theirs.
      const asked = await requestShutdownUnlessStanding(
        by,
        `restarting: ${args.reason}`,
        args.timeoutMs,
        undefined,
        args.force,
        supervised ? { sha: identity.sha, dirty: identity.dirty } : null,
      );
      if (!asked.asked && asked.standing.by !== by) {
        sayRefusal("not restarting:", [
          {
            line:
              `a shutdown asked by ${asked.standing.by} — ${asked.standing.reason} — landed while this was checking. ` +
              `Nothing was asked to stop by this command and nothing was stopped. lingtai resume lifts it, and then this will start`,
            waiver: null,
          },
        ], log);
        return { ok: false, code: 1 };
      }
      if (asked.asked) {
        request = asked.version;
      } else {
        request = asked.standing.version;
        drainTimeoutMs = asked.standing.timeoutMs;
        log(paint.held(`a shutdown you asked for is already standing (${asked.standing.reason}) — waiting on that one rather than asking twice.`));
      }
    }
    if (args.timeoutMs !== null && drainTimeoutMs !== args.timeoutMs) {
      log(
        paint.signal(
          `--timeout is not applied: the standing request is the one the daemon acts on, and it asks for ` +
            `${drainTimeoutMs === null ? "no timeout" : `${Math.round(drainTimeoutMs / 1000)}s`}. ` +
            `lingtai resume lifts it, and a restart after that asks with yours.`,
        ),
      );
    }
    const held = await inFlight().catch(() => []);
    log(paint.held(`draining ${before.conducting ?? "the daemon"} — ${describeInFlight(held)}.`));
    log(
      paint.muted(
        drainTimeoutMs === null
          ? `a pass is the agents, the gates and the merge lane. What one may spend is ${WALL_LIMIT}. It is waiting, not hung.`
          : `the daemon gives up after ${Math.round(drainTimeoutMs / 1000)}s and exits with its agent still running, which the next conductor kills.`,
      ),
    );
  }

  if (plan.go !== "start" || request !== null) {
    // A drain gives up when the daemon does, which is on the request's own
    // timeout. A `lingtai run` reads no request, and a request this command did
    // not make has the timeout it was asked with — so that one, either way.
    const giveUpMs = drainTimeoutMs;
    const mine = request;
    const waited = await waitForTheLock(
      plan.go === "drain" ? "draining" : "waiting",
      giveUpMs === null ? null : giveUpMs + RELEASE_GRACE_MS,
      log,
      // Under a supervisor the lock may never be seen free: the respawn can take
      // it between two polls. A start recorded after this request is the end of
      // the wait as surely as a free lock is.
      supervised && mine !== null ? { started: async () => (await startAfter(mine).catch(() => null)) !== null } : {},
    );

    if (waited !== "free" && waited !== "started") {
      const stopped = waited === "interrupted" ? "stopped waiting" : "the lock is still held after the timeout";
      log(
        request === null
          ? paint.held(`${stopped}. Nothing was asked to stop and nothing was started.`)
          : supervised
            ? paint.held(
                `${stopped}. The shutdown asked by ${by} is still standing — the daemon finishes its pass and exits, and ` +
                  `the supervisor starts the next one by itself. lingtai doctor says whether one is up.`,
              )
            : paint.held(
                `${stopped}. The shutdown asked by ${by} is still standing — the daemon finishes its pass and exits, ` +
                  `and nothing was started. lingtai restart picks that request up again and starts.`,
              ),
      );
      return { ok: false, code: waited === "interrupted" ? 130 : 1 };
    }
  }

  if (supervised) {
    // No second check to refuse on: the supervisor's start does not wait for
    // this command, and reads the disk for itself. What the check became is the
    // comparison `startSupervised` makes against what the start recorded.
    if (request === null) throw new Error("a supervised restart always asks a drain before it waits");
    return { ok: true, by, reason: args.reason, supervised: true, request, examined: { sha: identity.sha, dirty: identity.dirty } };
  }

  // Again, now. A drain can take an hour, and the commit and the worktree are
  // what the start is about to freeze — the ones examined before the drain are
  // not the ones a daemon reads if somebody committed, pulled or edited in the
  // meantime. The doctor is not asked twice: it was about the system, which a
  // drain does not change, and a daemon being down is not a failure it has.
  //
  // The standing request is asked again too. This restart's own is fine — the
  // start ends it — and anybody else's that landed during the wait refuses, as
  // it would have before the drain.
  const now = await codeIdentity();
  const after = planRestart(
    {
      ...before,
      identity: now,
      doctorFailed: 0,
      conducting: null,
      daemonUp: false,
      shutdown: (await readControl().catch(() => null))?.shutdown ?? null,
      loaded: { sha: identity.sha, dirty: identity.dirty },
    },
    waivers,
  );
  if (after.go === "refuse") {
    sayRefusal(`the wait is over and something that passed before it no longer does — not starting ${describeIdentity(now)}:`, after.because, log);
    if (request !== null) {
      log(paint.muted("your shutdown request is still standing, and the next start ends it. lingtai restart picks it up again."));
    }
    return { ok: false, code: 1 };
  }

  return { ok: true, by, reason: args.reason, supervised: false, request, examined: { sha: now.sha, dirty: now.dirty } };
}

function describeIdentity(id: Pick<Identity, "sha" | "dirty">): string {
  return `${id.sha ? id.sha.slice(0, 7) : "an unrecorded commit"}${id.dirty ? " (worktree dirty)" : ""}`;
}

function sayRefusal(heading: string, because: readonly Refusal[], log: (line: string) => void): void {
  log(paint.fail(heading));
  for (const r of because) {
    log(paint.fail(`  · ${r.line}`));
    // The flag beside the one thing it overrides, so reading it is reading what
    // it costs. A refusal with no flag says so by having none.
    if (r.waiver) log(paint.muted(`    ${r.waiver} starts in spite of this one, when you have read it and mean it.`));
  }
}

/** Whether the beacon was written to within three beats. Stale is not proof that no daemon holds the lock. */
async function daemonIsUp(): Promise<boolean> {
  // Not caught: a beacon that could not be read is not a daemon that is down.
  const status = await readStatus();
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
export async function waitForTheLock(
  /** What to call it in the repeated line: a drain was asked for, or it was not. */
  doing: "draining" | "waiting",
  giveUpAfterMs: number | null,
  log: (line: string) => void,
  /**
   * How the lock is asked about, and how often. Replaceable so a test need not
   * own a database. `started` ends the wait too, when a start it was waiting
   * for has been recorded — which under a supervisor can happen with the lock
   * never once seen free.
   */
  how: { ask?: () => Promise<string | null>; pollMs?: number; started?: () => Promise<boolean> } = {},
): Promise<"free" | "started" | "interrupted" | "gave-up"> {
  const ask = how.ask ?? (() => conductorLockHolder());
  const pollMs = how.pollMs ?? POLL_MS;
  const began = Date.now();
  let said = began;
  let interrupted = false;
  /** Whether the last ask failed, so a run of failures is said once and not every poll. */
  let failing = false;

  // Left standing on purpose. The request is in the log, so the drain it asked
  // for carries on without this process — what Ctrl+C ends is the waiting.
  const onSignal = (): void => {
    interrupted = true;
  };
  process.on("SIGINT", onSignal);

  try {
    for (;;) {
      // Only an answer of "nobody" is free. A query that failed — a network
      // blip, a pooler restart — says nothing about the lock, and reading it as
      // empty would go on to the start while the old daemon is still in its
      // pass: the start here would lose the lock to it, and exit saying so.
      const answer = await ask().then(
        (holder) => ({ ok: true as const, holder }),
        (err: unknown) => ({ ok: false as const, message: (err as Error).message }),
      );
      if (answer.ok) {
        failing = false;
        if (answer.holder === null) return "free";
        if (how.started && (await how.started())) return "started";
      } else if (!failing) {
        failing = true;
        log(paint.signal(`could not ask who holds the lock — ${answer.message}. Still ${doing}; it is asked again.`));
      }
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

      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (interrupted) return "interrupted";
    }
  } finally {
    process.off("SIGINT", onSignal);
  }
}

/** How many doctor failures refuse a restart: every one but those a restart is the remedy for. */
export function gatingFailures(results: readonly { status: string; restartAnswers?: boolean }[]): number {
  return results.filter((r) => r.status === "fail" && !r.restartAnswers).length;
}

/**
 * What failed, and nothing else.
 *
 * `formatReport` prints every check, which is right for `lingtai doctor` and
 * wrong in the middle of a restart: thirty green lines between the command and
 * the drain is how the two red ones get scrolled past.
 */
export function formatFailures(
  results: readonly { name: string; status: string; detail: string; restartAnswers?: boolean }[],
  failed: number,
): string {
  // Said, and not counted: this restart is what they ask for.
  const answered = results
    .filter((r) => r.status === "fail" && r.restartAnswers)
    .map((r) => paint.held(`  · ${r.name} — a restart is its remedy, so it does not refuse this one: ${r.detail}`));
  if (failed === 0) {
    return [paint.pass(answered.length === 0 ? "doctor: nothing failed" : "doctor: nothing failed that this restart does not answer"), ...answered].join("\n");
  }
  return [
    paint.fail(`doctor: ${failed} check(s) FAILED`),
    ...results
      .filter((r) => r.status === "fail" && !r.restartAnswers)
      .map((r) => paint.fail(`  · ${r.name}: ${r.detail}`)),
    ...answered,
  ].join("\n");
}

// ------------------------------------------------------ the supervised start --

/**
 * Who a start is recorded as, from what the daemon can know about itself.
 *
 * Pure, for the reason `planRestart` is. The daemon reads its commit once, and
 * `recordStart` hands this the fold of the stream its start is about to land
 * on — so `control.shutdown` is the request this start ends, if one stands:
 *
 * - `lingtai restart` in this process knows who ran it. **It records nothing
 *   over a drain somebody asked for after its checks** — the one moment the
 *   check after the wait cannot see, between reading the stream and winning the
 *   lock. Its own request is fine: the start ends it — and so is one the same
 *   person asked for, which `planRestart` adopts rather than refuses.
 * - **a supervisor's start answers a restart's handoff** (0042 §8), which rides
 *   on the request it ends, and takes its `by` and `reason` only when it is
 *   running the commit that restart examined. On a different commit it is
 *   recorded as `daemon`, says why, and still names the request, so the restart
 *   that is waiting on it can say so.
 * - a start typed at a terminal is the typist's, whatever stands — it is not the
 *   supervisor's start, and must not be recorded as the restart's.
 * - otherwise `daemon`, since stdin that is not a terminal is launchd, systemd,
 *   a script or `nohup`, and none of those is a person's hand.
 *
 * **Only the restart in this process ever declines.** There used to be a start
 * that was not recorded — one into a standing drain, which read it and exited,
 * every thirty seconds under a supervisor. A start reads nothing said before it
 * now, so it has nothing to exit on.
 */
export function attributeStart(input: {
  restart: { by: string; reason: string; request: number | null } | null;
  control: Pick<ControlState, "shutdown">;
  code: Pick<CodeVersion, "sha" | "dirty">;
  tty: boolean;
  user: string;
}): StartDecision {
  const { restart, control, code, tty } = input;
  const standing = control.shutdown;

  if (restart) {
    // The same person's is adopted, as `planRestart` adopts it: the check after
    // the wait would have taken it over, and a restart run again would too, so
    // declining over it leaves the system down for nothing.
    if (standing !== null && standing.version !== restart.request && standing.by !== restart.by) {
      return {
        record: false,
        why:
          `a shutdown asked by ${standing.by} — ${standing.reason} — landed after this restart's checks, so nothing ` +
          `started. lingtai restart refuses over it until lingtai resume lifts it; lingtai start starts over it`,
      };
    }
    return { record: true, by: restart.by, reason: restart.reason, handoff: null, note: null };
  }

  const person = `human:${input.user}`;
  const handoff = standing?.handoff ? { ...standing.handoff, by: standing.by, reason: standing.reason, version: standing.version } : null;
  if (handoff === null) return { record: true, by: tty ? person : "daemon", reason: null, handoff: null, note: null };
  if (tty) {
    return {
      record: true,
      by: person,
      reason: null,
      handoff: null,
      note: `a restart by ${handoff.by} was waiting for the supervisor to start a daemon — this one was typed, and is recorded as ${person}`,
    };
  }
  if (handoff.sha === code.sha && handoff.dirty === code.dirty) {
    return { record: true, by: handoff.by, reason: handoff.reason, handoff: handoff.version, note: null };
  }
  const why =
    `a restart by ${handoff.by} checked ${describeIdentity(handoff)} and handed the start to the supervisor, ` +
    `and this is running ${describeIdentity(code)}`;
  return { record: true, by: "daemon", reason: why, handoff: handoff.version, note: why };
}

/** How long a restart waits for the supervisor's start: past two of its thirty-second throttles. */
const HANDOFF_WAIT_MS = 90_000;

/**
 * Whether the daemon a start recorded got past its startup and is beating.
 *
 * The record lands before the beacon and the reconcile (`0045` §2), so a start
 * being recorded says nothing about whether that process lived to conduct. The
 * beacon says `up` once the reconcile is over, and names the pid; a daemon that
 * died on the way never says it, and the supervisor's next copy records a start
 * of its own.
 */
async function startIsUp(start: RecordedStart): Promise<boolean> {
  const status = await readStatus();
  if (!status) return false;
  const pid = Number(start.worker.slice(start.worker.lastIndexOf(":") + 1));
  return (
    status.pid === pid &&
    (status.state === "up" || status.state === "draining") &&
    Date.now() - status.lastSeenAt.getTime() <= STALE_AFTER_MS
  );
}

/**
 * Wait for the supervisor's start to be recorded, asking for one if none has,
 * and for the daemon that recorded it to come up.
 *
 * The record and not the beacon: a beacon says a daemon is beating, and not
 * which start put it there or from what commit — which is the whole of what
 * the restart has to report. Exits 0 only for a start that answered this
 * restart's request, as this person, on the commit that was checked.
 *
 * **And the beacon as well, before the verdict.** The record comes before the
 * reconcile, so the first start recorded may be a respawn that dies in it — and
 * the one `KeepAlive` brings back thirty seconds later finds no request and is
 * `daemon`'s. So the verdict waits for the recorded start's own pid to say `up`,
 * then reads the records again: a later start means the one it saw is gone,
 * and the later one is what is judged.
 *
 * `service start` is asked only when nothing has been recorded yet. The
 * respawn usually gets there first, and then asking is a no-op at best; when it
 * has not — a unit waiting out `RestartSec`, a job launchd is throttling — it is
 * what makes the start now rather than in thirty seconds.
 */
export async function startSupervised(
  prepared: { by: string; request: number; examined: Pick<CodeVersion, "sha" | "dirty"> },
  how: {
    start: () => Promise<number>;
    recorded?: (after: number) => Promise<RecordedStart | null>;
    /** Whether the daemon a start recorded is up past its startup. Replaceable so a test need not own a database. */
    up?: (start: RecordedStart) => Promise<boolean>;
    waitMs?: number;
    pollMs?: number;
    log?: (line: string) => void;
  },
): Promise<number> {
  const log = how.log ?? console.log;
  const recorded = how.recorded ?? ((after: number) => startAfter(after));
  const up = how.up ?? startIsUp;
  const waitMs = how.waitMs ?? HANDOFF_WAIT_MS;
  const pollMs = how.pollMs ?? POLL_MS;

  let start = await recorded(prepared.request).catch(() => null);
  if (start === null) {
    const code = await how.start();
    if (code !== 0) {
      log(
        paint.fail(
          "the supervisor refused the start, above. Nothing holds its next start back — lingtai service status says " +
            "whether it made one, and lingtai doctor whether a daemon is up.",
        ),
      );
      return 1;
    }
  }
  log(paint.held(`waiting for the supervisor's daemon to record its start and come up — up to ${waitMs / 1000}s. It is waiting, not hung.`));

  const began = Date.now();
  let interrupted = false;
  const onSignal = (): void => {
    interrupted = true;
  };
  process.on("SIGINT", onSignal);
  let settled: RecordedStart;
  try {
    for (;;) {
      if (start !== null && (await up(start).catch(() => false))) {
        // Up — and still the latest start? One recorded since means this one
        // is gone and that one holds the lock, so that one is judged instead.
        const again = await recorded(prepared.request).catch(() => null);
        if (again !== null && again.worker === start.worker && again.at.getTime() === start.at.getTime()) {
          settled = again;
          break;
        }
        start = again;
        continue;
      }
      if (interrupted) {
        log(paint.held("stopped waiting. The start was asked of the supervisor — lingtai doctor says whether a daemon is up."));
        return 130;
      }
      if (Date.now() - began > waitMs) {
        log(
          paint.held(
            start === null
              ? `no start was recorded in ${waitMs / 1000}s — lingtai service status says what the supervisor did, ` +
                  "and lingtai doctor whether a daemon is up."
              : `${start.by} recorded a start as ${start.worker}, and it was not up in ${waitMs / 1000}s — it may have ` +
                  "died starting. lingtai service status says what the supervisor did, and lingtai doctor whether a daemon is up.",
          ),
        );
        return 1;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      start = (await recorded(prepared.request).catch(() => null)) ?? start;
    }
  } finally {
    process.off("SIGINT", onSignal);
  }

  const mine = settled.handoff === prepared.request && settled.by === prepared.by;
  const same = settled.sha === prepared.examined.sha && settled.dirty === prepared.examined.dirty;
  if (mine && same) {
    log(paint.pass(`started ${describeIdentity(settled)} as ${settled.worker}, recorded as ${settled.by}'s restart`));
    return 0;
  }
  log(
    paint.fail(
      `a daemon started, and not as this restart: ${settled.by} started ${describeIdentity(settled)} as ` +
        `${settled.worker}${settled.reason ? ` — ${settled.reason}` : ""}. It is running; lingtai doctor says what it is.`,
    ),
  );
  return 1;
}
