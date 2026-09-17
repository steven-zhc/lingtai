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
 *   4. **the withdrawal** of this command's own request, by its version, and of
 *      nothing else — not a pause, not a drain somebody else asked for.
 *   5. **the start**, which is `lingtai daemon` in this process — or, where
 *      `lingtai service` keeps the daemon, `service start`, confirmed by the
 *      `ConductorStarted` it records and compared with the commit that was
 *      checked (0048). What makes it *never two* is the advisory lock (#93)
 *      and not any sequencing here: if anything got there first, this starts
 *      nothing and exits non-zero, since what won may leave no daemon (0042 §6).
 *
 * ## Two paths, one table
 *
 * Where a supervisor keeps the daemon the drain and the start are `lingtai
 * service`'s, and everything that refuses is still this file's — the same
 * functions, called from both. `RESTART_GUARDS` lists every refusal with the
 * place each path makes it, and a test fails on a row with one side (#167).
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
  controlWatermark,
  describeInFlight,
  identityRefusals,
  inFlight,
  queueForDaemonLock,
  readControl,
  readStatus,
  requestShutdownUnlessStanding,
  startAfter,
  withdrawShutdown,
  type Asking,
  type CodeVersion,
  type ControlState,
  type Identity,
  type LockPlace,
  type RecordedStart,
  type ShutdownRequest,
  type Withdrawal,
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
  /**
   * A `ConductorStarted` recorded since the drain was asked, or null — and
   * always null before the drain, when there is no since to ask about.
   *
   * After the wait this is a daemon somebody else started while the lock was
   * free, and a start here would be a second one. It also changes what a drain
   * somebody else asked for means: it may be aimed at that daemon, and `lingtai
   * resume` would cancel it (#167).
   */
  startedSince: RecordedStart | null;
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
       * A drain this same person already asked for, taken over rather than
       * refused. What makes the recovery the interrupt message prints true:
       * Ctrl+C leaves the request standing, and the next `lingtai restart` by
       * the same hand takes it over.
       */
      adopted: ShutdownRequest | null;
    };

export interface Waivers {
  dirty: boolean;
  despiteDoctor: boolean;
}

/**
 * The rules, in one function — and one function for **both** paths (#167).
 *
 * Each refusal names the one flag that overrides it, and most have none: a
 * commit that is not on the remote, a commit that could not be checked, a drain
 * **somebody else** asked for — that is another person's decision about this
 * system, and the command that lifts it is theirs to have meant — and a daemon
 * somebody else started while this waited.
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

  const started = before.startedSince;
  if (started !== null) {
    refusals.unshift({
      line:
        `a daemon started while this waited — ${started.by} started ${describeIdentity(started)} as ${started.worker}. ` +
        `A start here would be a second conductor after the one that holds the lock; lingtai doctor says what is up`,
      waiver: null,
    });
  }

  const standing = before.shutdown;
  const adopted = standing !== null && standing.by === before.by ? standing : null;
  if (standing !== null && adopted === null) {
    refusals.unshift({
      line:
        `a shutdown asked by ${standing.by} — ${standing.reason} — is already standing. ` +
        `Somebody asked this system to stop, and restarting over that would be this command deciding for them. ` +
        // The one piece of advice that must not be given when a daemon started
        // since: that request may be aimed at it, and `resume` would cancel a
        // drain of the daemon that is running (#167).
        (started === null
          ? `lingtai resume lifts it, and then this will start`
          : `It may be aimed at the daemon that started since, so lifting it is theirs to decide, not this command's`),
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

/**
 * Why the daemon that has just started is not the start the checks examined.
 * Empty is a go.
 *
 * The last two refusals, and the only two that can only be asked once a process
 * exists: what it is running, and whether a drain landed between the checks and
 * the moment it read where the control stream was — which it will never read,
 * since a daemon obeys nothing appended before it started (#159). The terminal
 * path asks them in the daemon before it takes anything, and starts nothing on
 * a refusal. The supervised path can only ask them of the daemon's record, once
 * the supervisor has started it, so there they are said and exit non-zero with
 * the daemon running (`RESTART_GUARDS`).
 */
export function startRefusals(input: {
  examined: Pick<CodeVersion, "sha" | "dirty">;
  running: Pick<CodeVersion, "sha" | "dirty">;
  /** The shutdown standing now, off the whole stream. */
  standing: ShutdownRequest | null;
  /**
   * The newest version the daemon may never read: its watermark where that is
   * known, and its `ConductorStarted`'s own version where it is not.
   */
  unreadThrough: number;
}): Refusal[] {
  const out: Refusal[] = [];
  const { examined, running, standing } = input;
  if (examined.sha !== running.sha || examined.dirty !== running.dirty) {
    out.push({
      line:
        `the checkout moved between the checks and the start — ${describeIdentity(examined)} was checked and ` +
        `${describeIdentity(running)} is what the daemon runs`,
      waiver: null,
    });
  }
  if (standing !== null && standing.version <= input.unreadThrough) {
    out.push({
      line:
        `a shutdown asked by ${standing.by} — ${standing.reason} — landed between the checks and the start, and a ` +
        `daemon reads nothing appended before it started (#159), so this one would take work over that stop`,
      waiver: null,
    });
  }
  return out;
}

/**
 * The terminal restart's start, when the lock was taken first: exit 1.
 *
 * The drain finished and something else won the race for the lock. This cannot
 * say what that something is going to do: a `lingtai run` in a terminal takes
 * the same lock and exits when its one pass ends, and a daemon that read the
 * drain before it was withdrawn drains straight back out. Saying "it is
 * running" would be a guess that tells the operator to do nothing — so it says
 * only what is known, and where the answer is. The supervised path's
 * counterpart is `service start` finding no `ConductorStarted` (0048).
 */
export function lostTheLock(holder: string | null, log: (line: string) => void): number {
  log(
    paint.held(
      `the lock was taken first${holder ? ` (${holder})` : ""}, and this started nothing. Whether a daemon is conducting ` +
        `afterwards is not something this process can know — a lingtai run exits when its pass ends, and a ` +
        `daemon that read the drain before it was withdrawn exits too. lingtai doctor says whether one is up; ` +
        `if none is, lingtai restart again waits for the lock and starts one.`,
    ),
  );
  return 1;
}

// ------------------------------------------------------------ the table ----

/**
 * One refusal, and what each path does about it.
 *
 * `terminal` is `lingtai restart` where nothing supervises the daemon — the
 * path a person can run and watch refuse. `supervised` is the same command
 * where launchd or systemd keeps it — the path that runs only when a supervisor
 * starts a process, which is not while anybody is watching, and where every one
 * of the six findings against two attempts at #159 lived.
 */
export interface Guard {
  id: string;
  refusal: string;
  /** Where the refusal is made on each path. Never empty: a row with one side is the defect. */
  terminal: string;
  supervised: string;
}

/**
 * **Every refusal the terminal path makes, the supervised path makes too** (#167).
 *
 * The invariant, as a table, because twice it was kept as an intention and
 * twice a reviewer found the supervised column empty. `pure/restart.test.ts`
 * holds one scenario per row per side, runs both, and fails on a row whose
 * either side is missing — so a refusal added to one path and not the other is
 * a failing test and not a finding.
 */
export const RESTART_GUARDS: readonly Guard[] = [
  {
    id: "unpushed",
    refusal: "HEAD is not reachable from the tracking remote (0042 §3) — no flag",
    terminal: "planRestart, before anything stops",
    supervised: "planRestart, before anything stops — the same call",
  },
  {
    id: "unestablished",
    refusal: "HEAD could not be checked against the remote — no flag",
    terminal: "planRestart, before anything stops",
    supervised: "planRestart, before anything stops — the same call",
  },
  {
    id: "dirty",
    refusal: "the worktree is dirty (0042 §3) — --dirty",
    terminal: "planRestart, before anything stops",
    supervised: "planRestart, before anything stops — the same call",
  },
  {
    id: "doctor",
    refusal: "lingtai doctor failed (0042 §4) — --despite-doctor",
    terminal: "planRestart, before anything stops",
    supervised: "planRestart, before anything stops — the same call",
  },
  {
    id: "lock-unread",
    refusal: "who holds the conductor lock could not be asked (0042 §6)",
    terminal: "checkBeforeTheDrain, before anything stops",
    supervised: "checkBeforeTheDrain, before anything stops — the same call",
  },
  {
    id: "beacon-unread",
    refusal: "whether a daemon is up could not be read (0042 §6)",
    terminal: "checkBeforeTheDrain, before anything stops",
    supervised: "checkBeforeTheDrain, before anything stops — the same call",
  },
  {
    id: "foreign-drain",
    refusal: "a shutdown somebody else asked for is standing (0042 §7) — no flag",
    terminal: "planRestart, before anything stops",
    supervised: "planRestart, before anything stops — the same call",
  },
  {
    id: "drain-landed",
    refusal: "a shutdown somebody else asked for landed while this was checking",
    terminal: "prepareRestart's ask: requestShutdownUnlessStanding found it, nothing is stopped",
    supervised: "service shutdown's drain: requestShutdownUnlessStanding found it, nothing is stopped",
  },
  {
    id: "after-unpushed",
    refusal: "after the wait, HEAD is no longer on the remote — a force-push during the drain",
    terminal: "checkAfterTheWait → planRestart, before the start",
    supervised: "checkAfterTheWait → planRestart, before service start — the same call",
  },
  {
    id: "after-dirty",
    refusal: "after the wait, the worktree has become dirty",
    terminal: "checkAfterTheWait → planRestart, before the start",
    supervised: "checkAfterTheWait → planRestart, before service start — the same call",
  },
  {
    id: "moved",
    refusal: "after the wait, the disk is not the commit this process loaded",
    terminal: "checkAfterTheWait → planRestart, before the start",
    supervised: "checkAfterTheWait → planRestart, before service start — the same call",
  },
  {
    id: "after-foreign-drain",
    refusal: "after the wait, a shutdown somebody else asked for is standing — and no resume advice when a daemon started since",
    terminal: "checkAfterTheWait → planRestart, before the start",
    supervised: "checkAfterTheWait → planRestart, before service start — the same call",
  },
  {
    id: "started-since",
    refusal: "after the wait, a daemon somebody else started has recorded its start",
    terminal: "checkAfterTheWait → planRestart, before the start",
    supervised: "checkAfterTheWait → planRestart, before service start — the same call",
  },
  {
    id: "code-at-start",
    refusal: "the daemon that started is not running the commit that was checked",
    terminal: "startRefusals in the daemon, which starts nothing on it",
    supervised: "startRefusals on the daemon's ConductorStarted, said with exit 1 — the process is the supervisor's",
  },
  {
    id: "drain-at-start",
    refusal: "a shutdown somebody else asked for landed between the checks and the daemon's watermark",
    terminal: "startRefusals in the daemon, which starts nothing on it",
    supervised: "service start refuses while it stands, and startRefusals on the record says one that landed during the start",
  },
  {
    id: "nothing-started",
    refusal: "the start took no work — the lock was taken first, or the daemon recorded nothing",
    terminal: "lostTheLock: startDaemon lost the lock, and the restart exits 1 and says so",
    supervised: "service start waits for ConductorStarted and exits 1 when none is recorded",
  },
];

/**
 * Refusals only the supervised path makes, and why the terminal one has no row
 * for them: each is about the supervisor, which the terminal path does not have.
 */
export const SUPERVISED_ONLY: readonly { refusal: string; why: string }[] = [
  { refusal: "the supervisor could not be asked whether it keeps the daemon", why: "keeper(): the terminal path has no supervisor to ask" },
  { refusal: "the unit runs a different checkout", why: "keeper(): a terminal daemon runs this process's checkout by construction" },
  { refusal: "--no-conduct and --no-merge", why: "the unit decides how the supervisor starts the daemon" },
];

// --------------------------------------------------------------- the doing --

/** What `prepareRestart` and `restartSupervised` read, and the drain they ask. Replaceable, so a test needs no database. */
export interface RestartFacts {
  identity: () => Promise<Identity>;
  doctor: () => Promise<{ results: readonly { name: string; status: string; detail: string; restartAnswers?: boolean }[] }>;
  /** `conductorLockHolder`. Throws when the lock could not be asked about. */
  holder: () => Promise<string | null>;
  /** Whether a beacon is fresh. Throws when it could not be read. */
  daemonUp: () => Promise<boolean>;
  /** The whole control stream, folded. */
  control: () => Promise<Pick<ControlState, "shutdown">>;
  inFlight: () => Promise<string[]>;
  ask: (by: string, reason: string, timeoutMs: number | null, force: boolean) => Promise<Asking>;
  withdraw: (by: string, version: number, reason: string) => Promise<Withdrawal>;
  /** `controlWatermark`: where `ctl-conductor` is now. */
  watermark: () => Promise<number>;
  /** `startAfter`. */
  startAfter: (version: number) => Promise<RecordedStart | null>;
  /** How often the lock is asked about while waiting. */
  pollMs?: number;
}

export function liveFacts(): RestartFacts {
  return {
    identity: () => codeIdentity(),
    doctor: () => doctorReport(),
    holder: () => conductorLockHolder(),
    daemonUp: daemonIsUp,
    control: () => readControl(),
    inFlight: () => inFlight(),
    ask: (by, reason, timeoutMs, force) => requestShutdownUnlessStanding(by, reason, timeoutMs, undefined, force),
    withdraw: (by, version, reason) => withdrawShutdown(by, version, reason),
    watermark: () => controlWatermark(),
    startAfter: (version) => startAfter(version),
  };
}

/** What the entry point needs to start a daemon, which is where a daemon is started. */
export type Prepared =
  | {
      ok: true;
      by: string;
      reason: string;
      /**
       * The commit and worktree the last check examined. The daemon compares
       * what it actually reads against this and starts nothing on a difference.
       */
      examined: CodeVersion;
    }
  | { ok: false; code: number };

type Checked =
  | { ok: false; code: number }
  | { ok: true; before: Before; plan: Extract<Plan, { go: "drain" | "wait" | "start" }>; identity: Identity };

/**
 * Everything that can refuse before anything stops — for both paths.
 *
 * A refusal that arrives after the drain is a system somebody has to bring back
 * up by hand, which is the failure this command exists to remove.
 */
async function checkBeforeTheDrain(args: RestartArgs, by: string, facts: RestartFacts, log: (line: string) => void): Promise<Checked> {
  const identity = await facts.identity();
  log(paint.muted(`this would start ${describeIdentity(identity)}, checked against ${identity.base}`));

  // The gate the exit code at `doctor`'s call site was written for and never
  // had a caller. The same report the command prints, from the same function,
  // so the two cannot disagree about whether this system is well.
  const report = await facts.doctor();
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
    conducting = await facts.holder();
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
  let up: boolean;
  try {
    up = await facts.daemonUp();
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
    daemonUp: up,
    shutdown: (await facts.control().catch(() => null))?.shutdown ?? null,
    // `identity` is the first thing this command read, so it is the loaded code.
    loaded: null,
    startedSince: null,
  };

  const plan = planRestart(before, { dirty: args.dirty, despiteDoctor: args.despiteDoctor });
  if (plan.go === "refuse") {
    sayRefusal("not restarting:", plan.because, log);
    return { ok: false, code: 1 };
  }
  for (const line of plan.overridden) log(paint.signal(line));
  return { ok: true, before, plan, identity };
}

/**
 * The same checks again, after the wait — for both paths.
 *
 * A drain can take an hour, and the commit and the worktree are what the start
 * is about to freeze. The doctor is not asked twice: it was about the system,
 * which a drain does not change, and a daemon being down is not a failure it has.
 */
async function checkAfterTheWait(
  checked: Extract<Checked, { ok: true }>,
  args: RestartArgs,
  /** Where the stream was before the drain was asked, so a start since then is somebody else's. */
  mark: number,
  facts: RestartFacts,
): Promise<{ plan: Plan; now: Identity }> {
  const now = await facts.identity();
  const plan = planRestart(
    {
      ...checked.before,
      identity: now,
      doctorFailed: 0,
      conducting: null,
      daemonUp: false,
      shutdown: (await facts.control().catch(() => null))?.shutdown ?? null,
      loaded: { sha: checked.identity.sha, dirty: checked.identity.dirty },
      startedSince: await facts.startAfter(mark).catch(() => null),
    },
    { dirty: args.dirty, despiteDoctor: args.despiteDoctor },
  );
  return { plan, now };
}

/**
 * Take over a drain this person already asked for: withdraw it, so that the
 * drain asked next is newer than whatever holds the lock.
 *
 * Not waited on as it stands. Since #159 a daemon reads nothing appended before
 * it started, so a request older than the daemon now holding the lock is one
 * it will never obey — and a restart waiting on it waits for ever. False, with
 * the refusal said, when what stands by now is somebody else's.
 */
async function liftAdopted(by: string, adopted: ShutdownRequest, facts: RestartFacts, log: (line: string) => void): Promise<boolean> {
  const lifted = await facts.withdraw(by, adopted.version, "restarting: taken over by a new restart, which asks its own");
  if (!lifted.withdrew && lifted.standing !== null) {
    sayRefusal("not restarting:", [
      {
        line:
          `a shutdown asked by ${lifted.standing.by} — ${lifted.standing.reason} — landed while this was checking. ` +
          `Nothing was asked to stop by this command and nothing was stopped. lingtai resume lifts it, and then this will start`,
        waiver: null,
      },
    ], log);
    return false;
  }
  return true;
}

/**
 * `lingtai restart` where nothing supervises the daemon: everything up to the
 * start. The start itself is `lingtai daemon`, unchanged.
 *
 * Split there rather than calling the daemon from here because there must be
 * exactly one piece of code that starts a daemon: a second one would be a second
 * place for the beacon, the reconcile and the `ConductorStarted` append to drift
 * apart from.
 */
export async function prepareRestart(
  args: RestartArgs,
  log: (line: string) => void = console.log,
  facts: RestartFacts = liveFacts(),
): Promise<Prepared> {
  const by = `human:${process.env["USER"] ?? "operator"}`;
  const checked = await checkBeforeTheDrain(args, by, facts, log);
  if (!checked.ok) return checked;
  const { before, plan } = checked;

  /** The version of the request this command is waiting on, when there is one. */
  let request: number | null = null;
  /**
   * The timeout the daemon acts on, which is the standing request's — never this
   * invocation's flag when the request was not made by this invocation.
   */
  let drainTimeoutMs: number | null = plan.adopted ? plan.adopted.timeoutMs : args.timeoutMs;
  const force = plan.adopted ? plan.adopted.force : args.force;

  if (plan.adopted) {
    log(
      paint.held(
        plan.go === "start"
          ? `a shutdown you asked for is still standing (${plan.adopted.reason}) and nothing is conducting — it is withdrawn before the start.`
          : `a shutdown you asked for is already standing (${plan.adopted.reason}) — taken over, and asked again so the daemon holding the lock reads it.`,
      ),
    );
    if (plan.go === "start") request = plan.adopted.version;
    else if (!(await liftAdopted(by, plan.adopted, facts, log))) return { ok: false, code: 1 };
  }

  // Before the drain is asked, so the drain's own request is not "since".
  const mark = await facts.watermark().catch(() => null);
  if (mark === null) {
    sayRefusal("not restarting:", [
      { line: "where the control stream is could not be read, so a start during the wait could not be told from this one. Nothing was stopped", waiver: null },
    ], log);
    return { ok: false, code: 1 };
  }

  if (plan.go === "drain" || plan.go === "wait") {
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
    // The decision and the append are one write: the plan read no standing
    // request, but one may have landed since, and the fold keeps only the
    // newest — so appending over it would make this restart's later
    // withdrawal lift somebody else's drain with no event withdrawing it.
    const asked = await facts.ask(by, `restarting: ${args.reason}`, drainTimeoutMs, force);
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
    if (args.timeoutMs !== null && drainTimeoutMs !== args.timeoutMs) {
      log(
        paint.signal(
          `--timeout is not applied: the standing request is the one the daemon acts on, and it asks for ` +
            `${drainTimeoutMs === null ? "no timeout" : `${Math.round(drainTimeoutMs / 1000)}s`}. ` +
            `lingtai resume lifts it, and a restart after that asks with yours.`,
        ),
      );
    }
    const held = await facts.inFlight().catch(() => []);
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
    const waited = await waitForTheLock(
      plan.go === "drain" ? "draining" : "waiting",
      giveUpMs === null ? null : giveUpMs + RELEASE_GRACE_MS,
      log,
      { ask: facts.holder, ...(facts.pollMs === undefined ? {} : { pollMs: facts.pollMs }) },
    );

    if (waited !== "free") {
      const stopped = waited === "interrupted" ? "stopped waiting" : "the lock is still held after the timeout";
      log(
        request !== null
          ? paint.held(
              `${stopped}. The shutdown asked by ${by} is still standing — the daemon finishes its pass and exits, ` +
                `and nothing was started. lingtai restart picks that request up again and starts; lingtai resume lifts it.`,
            )
          : paint.held(`${stopped}. Nothing was asked to stop and nothing was started.`),
      );
      return { ok: false, code: waited === "interrupted" ? 130 : 1 };
    }
  }

  // Again, now — the same function the supervised path calls.
  const { plan: after, now } = await checkAfterTheWait(checked, args, mark, facts);
  if (after.go === "refuse") {
    sayRefusal(`the wait is over and something that passed before it no longer does — not starting ${describeIdentity(now)}:`, after.because, log);
    if (request !== null) {
      log(paint.muted("your shutdown request is still standing, and nothing was started here. lingtai restart picks it up again."));
    }
    return { ok: false, code: 1 };
  }

  // Before the start and after the drain, in that order. One append, naming the
  // request by its version — never a resume, which would lift a pause, and never
  // a withdrawal of whatever happens to be standing, which could be somebody
  // else's. Not so the daemon started next can take work: since #159 it never
  // reads this request. So the board and `lingtai status` stop saying a
  // shutdown stands about a stop that is over (0048).
  if (request !== null) {
    const lifted = await facts.withdraw(by, request, `restarted: ${args.reason}`);
    if (!lifted.withdrew && lifted.standing !== null) {
      sayRefusal("not starting:", [
        {
          line:
            `while this was waiting, ${lifted.standing.by} asked for a shutdown — ${lifted.standing.reason}. ` +
            `It is left standing. lingtai resume lifts it, and then lingtai restart will start`,
          waiver: null,
        },
      ], log);
      return { ok: false, code: 1 };
    }
    if (lifted.withdrew) log(paint.muted(`withdrew the drain — ${lifted.request.reason}`));
  }

  return { ok: true, by, reason: args.reason, examined: { sha: now.sha, dirty: now.dirty } };
}

/**
 * `lingtai restart` where launchd or systemd keeps the daemon (0042 §8, as
 * 0048 amends it): the same checks, `lingtai service shutdown`'s drain, the
 * same checks again, and `lingtai service start`.
 *
 * **There is no handoff.** 0042 §8 carried the checked commit and this person's
 * name to the supervisor's daemon in the withdrawal, for it to claim — and
 * since #159 that daemon folds nothing appended before it started, so it never
 * read one. Two attempts to keep that machinery produced the same five
 * asymmetries with the terminal path (#167). What replaces it is nothing new:
 *
 * - **the drain is `service shutdown`'s** (#174), which holds the conductor
 *   lock through the unload, so the copy KeepAlive starts when the drained
 *   daemon exits takes no work on code nobody checked;
 * - **the checks after the wait are `checkAfterTheWait`**, the terminal path's
 *   own function, run with nothing supervised running;
 * - **the start is `service start`**, which waits for a `ConductorStarted` and
 *   exits non-zero without one; and the record it waited for is compared with
 *   the commit the checks examined, by `startRefusals`, the terminal daemon's
 *   own function.
 *
 * `RESTART_GUARDS` is the table of what each path refuses, and where.
 */
export async function restartSupervised(
  args: RestartArgs,
  how: {
    /** `lingtai service <argv>`, with the drain asked as this restart asks it — `--timeout` and `--force` included. */
    service: (argv: string[]) => Promise<number>;
    facts?: RestartFacts;
    log?: (line: string) => void;
  },
): Promise<number> {
  const log = how.log ?? console.log;
  const facts = how.facts ?? liveFacts();
  const by = `human:${process.env["USER"] ?? "operator"}`;
  const checked = await checkBeforeTheDrain(args, by, facts, log);
  if (!checked.ok) return checked.code;

  // `service shutdown` never adopts a standing request, anybody's, so a drain
  // this person asked for is taken over here — the terminal path's `liftAdopted`,
  // and then the drain it asks is newer than whatever holds the lock.
  if (checked.plan.adopted) {
    log(paint.held(`a shutdown you asked for is already standing (${checked.plan.adopted.reason}) — taken over, and asked again by the drain below.`));
    if (!(await liftAdopted(by, checked.plan.adopted, facts, log))) return 1;
  }

  const mark = await facts.watermark().catch(() => null);
  if (mark === null) {
    sayRefusal("not restarting:", [
      { line: "where the control stream is could not be read, so a start during the wait could not be told from this one. Nothing was stopped", waiver: null },
    ], log);
    return 1;
  }

  log(paint.held("the supervisor keeps the daemon, so the drain is lingtai service shutdown's and the start is its start."));
  const drained = await how.service(["shutdown", `restarting: ${args.reason}`]);
  if (drained !== 0) {
    log(paint.held("nothing was started: the drain above did not finish. lingtai service status says what the supervisor has."));
    return drained;
  }

  const { plan: after, now } = await checkAfterTheWait(checked, args, mark, facts);
  if (after.go === "refuse") {
    sayRefusal(`the wait is over and something that passed before it no longer does — not starting ${describeIdentity(now)}:`, after.because, log);
    log(
      paint.muted(
        "the drain above unloaded the service, and nothing supervised is running. Once this is answered, lingtai restart " +
          "checks again — with the service unloaded it starts one in this terminal — and pnpm lingtai service start brings the supervised one back.",
      ),
    );
    return 1;
  }

  const startMark = await facts.watermark().catch(() => null);
  const started = await how.service(["start"]);
  if (started !== 0) return started;

  // `service start` has seen a start recorded; this is which one, and whether it
  // is the one the checks examined.
  const record = startMark === null ? null : await facts.startAfter(startMark).catch(() => null);
  if (record === null) {
    log(paint.fail("the start could not be read back, so whether it runs the commit that was checked is not known. lingtai doctor says what is running."));
    return 1;
  }
  const refused = startRefusals({
    examined: { sha: now.sha, dirty: now.dirty },
    running: record,
    standing: (await facts.control().catch(() => null))?.shutdown ?? null,
    unreadThrough: record.version,
  });
  if (refused.length > 0) {
    sayRefusal(`a daemon started, and it is not the start that was checked — ${record.by} started ${describeIdentity(record)} as ${record.worker}:`, refused, log);
    log(paint.muted("it is the supervisor's and it is running. pnpm lingtai service shutdown drains it; lingtai restart then checks again."));
    return 1;
  }
  log(paint.pass(`restarted ${describeIdentity(record)} as ${record.worker} — the commit that was checked`));
  return 0;
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
  /** How the lock is asked about, and how often. Replaceable so a test need not own a database. */
  how: {
    ask?: () => Promise<string | null>;
    pollMs?: number;
    sayEveryMs?: number;
    /** What Ctrl+C does, in the repeated line — the caller's to say, since it is the caller that acts on it. */
    ctrlC?: string;
  } = {},
): Promise<"free" | "interrupted" | "gave-up"> {
  const ask = how.ask ?? (() => conductorLockHolder());
  const pollMs = how.pollMs ?? POLL_MS;
  const sayEveryMs = how.sayEveryMs ?? SAY_EVERY_MS;
  const ctrlC = how.ctrlC ?? "ctrl-c stops waiting and leaves whatever was asked for standing.";
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
      // empty would withdraw the drain while the old daemon is still in its
      // pass: it would read no request when the pass ends and carry on from the
      // stale commit, and the start here would lose the lock to it.
      const answer = await ask().then(
        (holder) => ({ ok: true as const, holder }),
        (err: unknown) => ({ ok: false as const, message: (err as Error).message }),
      );
      if (answer.ok) {
        failing = false;
        if (answer.holder === null) return "free";
      } else if (!failing) {
        failing = true;
        log(paint.signal(`could not ask who holds the lock — ${answer.message}. Still ${doing}; it is asked again.`));
      }
      if (interrupted) return "interrupted";
      if (giveUpAfterMs !== null && Date.now() - began > giveUpAfterMs) return "gave-up";

      if (Date.now() - said >= sayEveryMs) {
        said = Date.now();
        const held = await inFlight().catch(() => []);
        log(
          paint.muted(
            `still ${doing} after ${Math.round((Date.now() - began) / 1000)}s — ${describeInFlight(held)}. ` +
              ctrlC,
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

/**
 * Wait to *hold* the lock, not for it to be free — `lingtai service shutdown`'s
 * wait (#174).
 *
 * Free is not enough under a supervisor: the moment the drained daemon lets go,
 * KeepAlive has started a copy, and that copy reads no request older than
 * itself (#159). So the place in Postgres's queue is taken first, and the wait
 * is over when it has become the lock — which a copy then cannot take.
 *
 * Nobody holding the lock while this place is not yet granted is the instant
 * Postgres takes to hand it on, and is still waiting. A place whose connection
 * failed is taken again rather than waited on for ever — granted or not, since
 * Postgres releases an advisory lock with the session that held it, so a lost
 * connection is checked before a grant is believed, and a grant is confirmed
 * on its own connection.
 */
export async function queueForTheLock(
  how: { place?: () => Promise<LockPlace>; holder?: () => Promise<string | null>; pollMs?: number; sayEveryMs?: number } = {},
): Promise<{
  wait: (log: (line: string) => void, retaken?: () => Promise<void>) => Promise<"held" | "interrupted" | "gave-up">;
  holds: () => Promise<boolean>;
  leave: () => Promise<void>;
}> {
  const take = how.place ?? (() => queueForDaemonLock({ name: "lingtai-service-shutdown" }));
  const holder = how.holder ?? (() => conductorLockHolder());
  let place = await take();
  const holds = async (): Promise<boolean> => place.lost() === null && place.held() && (await place.confirm());
  return {
    wait: async (log, retaken) => {
      const waited = await waitForTheLock("draining", null, log, {
        ask: async () => {
          if (await holds()) return null;
          const lost = place.lost() ?? (place.held() ? new Error("the lock is no longer held on its connection") : null);
          if (lost !== null) {
            await place.leave();
            place = await take();
            // Whoever took the lock in the gap may be a copy started after the
            // request, which never reads it — so the caller asks again, after
            // the new place, where whatever holds the lock does read it.
            const again = await (retaken ?? (async () => {}))().then(
              () => "",
              (err: unknown) => `, and asking for the drain again failed — ${(err as Error).message}`,
            );
            throw new Error(`the place in the queue for the lock was lost (${lost.message}) and was taken again${again}`);
          }
          return (await holder()) ?? "nobody, while the lock is handed to this command";
        },
        ctrlC: "ctrl-c stops waiting, withdraws this command's request, and tells the supervisor nothing — a daemon that already read it still exits after its pass, and the supervisor then starts one that takes work.",
        ...(how.pollMs === undefined ? {} : { pollMs: how.pollMs }),
        ...(how.sayEveryMs === undefined ? {} : { sayEveryMs: how.sayEveryMs }),
      });
      return waited === "free" ? "held" : waited;
    },
    holds,
    leave: () => place.leave(),
  };
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

// ------------------------------------------------------------ whose start --

/** Whose start a daemon's `ConductorStarted` records, or that it records none. */
export type Attribution =
  | { record: false; why: string }
  | { record: true; by: string; reason: string | null };

/**
 * Who a start is recorded as, from what the daemon can know about itself.
 *
 * Pure, for the reason `planRestart` is. The daemon reads its commit once, and
 * hands this the control read it acts on (`startRecorder`), and this decides:
 *
 * - **a start into a standing drain is not recorded.** It reads the request and
 *   exits without taking anything.
 * - `lingtai restart` in this process knows who ran it.
 * - otherwise a start typed at a terminal is the typist's, and anything else is
 *   `daemon`, since stdin that is not a terminal is launchd, systemd, a script
 *   or `nohup`, and none of those is a person's hand.
 *
 * **A supervisor's start is `daemon`, including the one a supervised `lingtai
 * restart` asked for.** 0042 §8 gave that start the restart's name through a
 * handoff on the withdrawal, and since #159 the daemon never read it (0048).
 * The restart names itself instead, on its own drain and withdrawal, and says
 * which start answered it.
 */
export function attributeStart(input: {
  restart: { by: string; reason: string } | null;
  control: Pick<ControlState, "shutdown"> | null;
  tty: boolean;
  user: string;
}): Attribution {
  const { restart, control, tty } = input;
  const standing = control?.shutdown ?? null;
  if (standing !== null) {
    return { record: false, why: `a shutdown asked by ${standing.by} stands, so this start takes nothing and exits` };
  }
  if (restart) return { record: true, by: restart.by, reason: restart.reason };
  return { record: true, by: tty ? `human:${input.user}` : "daemon", reason: null };
}

/**
 * Record a start once, off **the control read on which the daemon decides to
 * take work** — never off an earlier one.
 *
 * The daemon used to attribute its start from a read taken at startup and
 * notice a shutdown only later, when the work loop's first pass read the stream
 * again after the filters and the reconcile — so a start could record nothing
 * and take work. One read now decides both, so a start that reads a standing
 * drain exits on that read, and a start that takes work has recorded itself
 * before its first pass. That is also what `lingtai service start` waits on.
 *
 * Called with every read the daemon acts on and does anything only on the
 * first. Never throws: a start that could not be recorded is said, and the
 * daemon still conducts.
 */
export function startRecorder(input: {
  restart: { by: string; reason: string } | null;
  tty: boolean;
  user: string;
  record: (a: Extract<Attribution, { record: true }>) => Promise<void>;
  log: (line: string) => void;
}): (control: Pick<ControlState, "shutdown">) => Promise<void> {
  let decided = false;
  return async (control) => {
    if (decided) return;
    decided = true;
    const attribution = attributeStart({ restart: input.restart, control, tty: input.tty, user: input.user });
    if (!attribution.record) {
      input.log(paint.muted(`not recorded as a start: ${attribution.why}`));
      return;
    }
    await input.record(attribution).catch((err: unknown) => {
      input.log(paint.fail(`the start could not be recorded: ${(err as Error).message}`));
    });
  };
}
