/**
 * The process that holds the long-lived work.
 *
 * One daemon holds the projection follower and — from #43 — the conductor. The
 * UI is a separate server that controls it and watches it, and holds nothing
 * ([0013](../../../doc/decisions/0013-daemon-hosts-the-work.md)).
 *
 * The dividing line is who holds work in flight. A dead UI costs a screen; a
 * dead conductor costs a paid agent run, an orphaned worktree, and a claim
 * somebody waits out. Hosting the conductor in the board would have made saving
 * a stylesheet a way to kill a run, and would have made "unattended" mean "keep
 * a web server alive".
 *
 * ## Nothing here is on a timer
 *
 * Postgres notifies on append and `subscribe` resumes from the checkpoint, so a
 * process that was asleep or dead catches up on the way back rather than
 * skipping what it missed. That is why a daemon that dies is a board that goes
 * *behind* rather than a board that goes wrong.
 *
 * ## Failure is loud
 *
 * A projection whose handler throws stops with its checkpoint intact, and this
 * stops with it. Serving three-quarters of a board is how you get a board
 * nobody checks — and the incident that motivated all of this was two work
 * items merging for real while their cards sat still, which nothing reported.
 *
 * One of those failures is knowable on the way up: a projection whose table no
 * longer has the columns its DDL declares will throw on the first event that
 * needs one, and `start()` compares the two before it follows. So a drifted
 * shape is a daemon that refuses with the remedy in the message, rather than one
 * that runs until the wrong event arrives (#90).
 */
import { paint } from "@lingtai/env/colour";
import type { Projection, ProjectionRunner } from "@lingtai/projector";
import { ProjectionShapeError, createProjectionRunner } from "@lingtai/projector";
import { type DaemonLock, acquireDaemonLock } from "./lock.ts";

export interface DaemonOptions {
  /** Everything the follower keeps current. */
  projections: readonly Projection[];
  /** Session-mode connection for the lock. Defaults to the configured one. */
  lockUrl?: string;
  lockKey?: string;
  log?: (line: string) => void;
}

export type DaemonStart =
  | { ok: true; daemon: Daemon }
  /**
   * Another daemon holds the lock. Not an error: running `lingtai daemon` while
   * launchd's copy is up is a reasonable thing to do, and the right answer is
   * to say who has it and exit 0.
   */
  | { ok: false; reason: "already-running"; holder: string | null };

export interface Daemon {
  /** Resolves when the daemon stops, with why. */
  readonly stopped: Promise<StopReason>;
  stop(): void;
  /** Set when a projection's handler threw. */
  readonly failure: { projection: string; error: unknown } | null;
}

export type StopReason = "asked" | "projection-failed";

export async function startDaemon(options: DaemonOptions): Promise<DaemonStart> {
  const log = options.log ?? (() => {});

  const held = await acquireDaemonLock({
    // Named, so that a `lingtai run` turned away by this lock — and
    // `lingtai doctor` — says *daemon* rather than a bare pid (#93).
    name: "lingtai daemon",
    ...(options.lockUrl === undefined ? {} : { url: options.lockUrl }),
    ...(options.lockKey === undefined ? {} : { key: options.lockKey }),
  });
  if (!held.ok) return { ok: false, reason: "already-running", holder: held.holder };

  const lock: DaemonLock = held.lock;
  const state: { failure: { projection: string; error: unknown } | null } = { failure: null };
  const runners: ProjectionRunner[] = [];

  let settle: (reason: StopReason) => void = () => {};
  const stopped = new Promise<StopReason>((resolve) => {
    settle = resolve;
  });

  let stopping = false;
  const shutdown = (reason: StopReason): void => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      for (const runner of runners) {
        await runner.stop().catch(() => {});
        await runner.close().catch(() => {});
      }
      await lock.release();
      settle(reason);
    })();
  };

  try {
    for (const projection of options.projections) {
      const runner = createProjectionRunner({
        projection,
        onError: (error, phase) => {
          // A connection error retries inside `subscribe`; a handler error has
          // already stopped that runner, and a half-current board is worse than
          // an absent one because nobody distrusts it.
          if (phase !== "handler") return;
          state.failure ??= { projection: projection.name, error };
          log(paint.fail(`${projection.name} stopped: ${String(error)}`));
          shutdown("projection-failed");
        },
      });
      runners.push(runner);
      try {
        await runner.start();
      } catch (err) {
        // Said here, beside the lag, rather than left to the throw on the way
        // out. A shape that has drifted from its table is the one projection
        // failure a daemon can see *before* it costs anything: #84's column
        // landed, the daemon came up green, and it stopped eight events later
        // with a run in flight and nothing on the board saying why (#90).
        if (err instanceof ProjectionShapeError)
          log(paint.fail(`${projection.name}\twill not follow — ${err.message}`));
        throw err;
      }
      const lag = await runner.lag();
      // Chrome: a name and two sequence numbers. Dim, so that the refusal above
      // it is what the eye lands on when there is one.
      log(paint.muted(`${projection.name}\tfollowing at ${lag.lastSeq}/${lag.headSeq}`));
    }
  } catch (err) {
    // Started nothing useful. Release rather than sit on the lock and keep the
    // next daemon out.
    for (const runner of runners) await runner.close().catch(() => {});
    await lock.release();
    throw err;
  }

  log(paint.accent(`daemon up — ${runners.length} projection(s)`));

  return {
    ok: true,
    daemon: {
      stopped,
      stop: () => shutdown("asked"),
      get failure() {
        return state.failure;
      },
    },
  };
}
