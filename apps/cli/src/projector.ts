/**
 * The projector a command holds while it appends.
 *
 * **One rule, both hosts: every process that appends holds a projector for as
 * long as it runs** ([0022](../../../doc/decisions/0022-the-seams.md)). The
 * daemon always did. A command used to do something else — append, return, and
 * then catch the projections up on its way out — which is two mechanisms for
 * one job, and `run` had the worse one. The board was frozen for the whole of a
 * run and jumped to current when the command exited (`#64`).
 *
 * Two projectors on one log is now the normal case rather than an edge case,
 * and it is safe by construction: `apply` is idempotent and the checkpoint
 * advances inside the same transaction as its writes, so whichever one gets
 * there second finds nothing left to do. No lock, no coordination.
 *
 * **Who holds one, and who does not.** `lingtai run`, `lingtai end replay` and
 * `lingtai approve` do: each does work the board renders, and each is run with
 * the board open. `lingtai pause`, `resume` and `now` do not, and the reason is
 * not latency — `start()` catches up to the head *before* it returns, so a
 * pause issued against a daemon that has been down for an hour would replay the
 * hour before it paused anything. An emergency control must not queue behind a
 * fold. They presuppose a daemon anyway, which advances the checkpoint the
 * moment their event lands. Stated here rather than left to be worked out per
 * command, because "which ones do it" is exactly the question `#64` cost.
 *
 * The hazard is the reason this is a scope and not a start at the top and a
 * close at the bottom. An open projector holds a session-mode Postgres
 * connection **and keeps the event loop alive**, and `run` returns early on
 * four paths. A `finally` covers every `return` and every throw inside `work`,
 * which is exactly what those paths need and what a pair of statements would
 * not give them.
 */
import { createProjectionRunner, taskViewProjection } from "@lingtai/projector";
import { Context, Effect, Layer } from "effect";

/**
 * Runs `work` with the projections following the log, and releases them after.
 *
 * A projector that will not start is reported and never fatal. The log is what
 * is authoritative; refusing to do the work because the board cannot be kept
 * current would turn a stale board into no work at all, and the next daemon
 * catches up from the checkpoint regardless.
 */
export async function withProjector<T>(
  log: (line: string) => void,
  work: () => Promise<T>,
): Promise<T> {
  const runner = createProjectionRunner({ projection: taskViewProjection });

  let following = false;
  try {
    // Creates the tables, catches up to the head, then follows. Resolves once
    // it is current, so the board is not behind before the work even starts.
    await runner.start();
    following = true;
  } catch (err) {
    log(`the board will not follow this run: ${(err as Error).message}`);
    log("the log is intact; a daemon catches up from the checkpoint — lingtai daemon --no-conduct");
  }

  try {
    return await work();
  } finally {
    // Said out loud rather than left to be noticed. A projection that stopped
    // part-way through leaves a board that is half-current, which is worse than
    // one that is plainly behind because nobody distrusts it.
    if (following && runner.failure) {
      log(`the projection stopped during this run: ${String(runner.failure)}`);
      log("the board is behind until it is rebuilt — lingtai projection rebuild task_view");
    }
    await runner.close().catch(() => {});
  }
}

/**
 * The same thing, as a resource with a lifetime.
 *
 * **This is where `Scope` earns what
 * [0023](../../../doc/decisions/0023-effect-at-the-boundary.md) is for.** The
 * `finally` above works, and it works because one function owns both the
 * acquire and the release. `run()` does not have that shape: it refuses on four
 * paths before the work begins, and each of those is a `return` that has to
 * remember. `Layer.scoped` makes the release structural — the runner is closed
 * when the scope closes, whichever way control left it, including a typed
 * refusal raised before the projector was ever read.
 */
export class Projector extends Context.Tag("lingtai/cli/Projector")<
  Projector,
  { readonly following: boolean; readonly failure: unknown }
>() {}

export const ProjectorLive = (log: (line: string) => void): Layer.Layer<Projector> =>
  Layer.scoped(
    Projector,
    Effect.acquireRelease(
      Effect.promise(async () => {
        const runner = createProjectionRunner({ projection: taskViewProjection });
        let following = false;
        try {
          await runner.start();
          following = true;
        } catch (err) {
          log(`the board will not follow this run: ${(err as Error).message}`);
          log("the log is intact; a daemon catches up from the checkpoint — lingtai daemon --no-conduct");
        }
        return { runner, following };
      }),
      ({ runner, following }) =>
        Effect.promise(async () => {
          if (following && runner.failure) {
            log(`the projection stopped during this run: ${String(runner.failure)}`);
            log("the board is behind until it is rebuilt — lingtai projection rebuild task_view");
          }
          await runner.close().catch(() => {});
        }),
    ).pipe(
      Effect.map((held) => ({ following: held.following, failure: held.runner.failure })),
    ),
  );
