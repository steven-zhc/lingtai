/**
 * The integrator: merge base in, verify, merge out.
 *
 * This is the file that exists because of a specific, expensive silence. The old
 * loop's `integrate()` had six `return 1` paths and not one of them emitted a
 * log line, a comment or a label. #58 and #59 re-ran five times for roughly $29
 * while the actual cause — uncommitted work in the operator's own checkout of
 * `main` — was never reported by anything at all.
 *
 * So there is one rule here, and the code is shaped around it rather than merely
 * observing it: **no path returns without an event.** Every exit goes through
 * `refuse()` or `succeed()`, both of which append before they return, and the
 * only way to leave this function is through one of them. A reason is a typed
 * value from the catalogue, not a string someone wrote at the time.
 *
 * Two structural changes make most of those failures impossible rather than
 * merely reported:
 *
 * **The integrator owns its worktree.** It is cut from the same bare mirror the
 * agent's came from, and the operator's checkout is never read, written or
 * looked at. A dirty working copy somewhere else cannot affect a merge that does
 * not touch it.
 *
 * **The lane holds no lock, because git is what makes a merge safe** (#194).
 * It took one until then — a lock file, and a Postgres advisory lock before
 * that — and what that lock bought was never the guarantee. A ref update is
 * atomic: two integrations computed against one base both reach the push, one
 * lands and the other is rejected as not a fast-forward, and that is true with
 * a lock, without one, and between two machines where a lock never reached.
 * What the lock bought was *cheaper failure* — the loser was told before it cut
 * a worktree — and that is not worth a mechanism a reader has to learn.
 *
 * **The loser of a push merges against where the base is now and tries again**,
 * here rather than anywhere else. Nothing is wrong with its branch and no
 * judgement is owed: everything above the push is a pure recomputation against
 * a base that moved, it costs seconds and buys no agent, and the caller it
 * would otherwise return to blocks the item on a person who can do nothing but
 * click Requeue. `LOST_PUSHES` bounds it; a base that moves out from under
 * every one of those pushes is the `push-rejected` refusal, recorded exactly
 * as `lane-busy` was recorded before it.
 *
 * That retry does not bend the rule above, and it does not weaken it either:
 * **the whole run of pushes is one `IntegrationAttempted` and one terminal**,
 * because the caller asked for one merge and is owed one answer. A lost push
 * that this lane goes on to win is the single thing in here that says nothing —
 * a refusal is what interrupts a person and wakes a queue pass, and a race
 * still being won is neither (`LostPush`).
 *
 * So two integrations against one base **overlap by design**, and each one owns
 * a worktree of its own rather than one per base.
 *
 * That worktree is an `Effect.acquireRelease` pair inside a `Scope`
 * ([0026](../../../doc/decisions/0026-the-conversion-past-the-seam.md)) — one
 * resource now, where there used to be two. It was a pair of nested `finally`
 * blocks, which is the same guarantee written out by hand: correct here, and
 * correct only because one function happened to own both ends of it.
 */
import { integrationStream } from "@lingtai/domain";
import { type RefusalReason, parsePayload, reduceIntegration } from "@lingtai/domain";
import { ConcurrencyError, type EventStore, eventStore } from "@lingtai/event-store";
import { Effect, Either } from "effect";
import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { basename } from "node:path";
import { stateDir } from "@lingtai/env";
import { RepoFailed, type TokenSource, gitEffect } from "./git.ts";
import { worktreePath } from "./worktree.ts";

export interface IntegrateOptions {
  project: string;
  owner: string;
  repo: string;
  base: string;
  branch: string;
  workItemId: string;
  /** The commit the gates gave their verdicts about. */
  headSha: string;
  /** False when a gate refused. The integrator records it and does not merge. */
  stepsPassed: boolean;
  stepDetail?: string;
  token?: TokenSource;
  home?: string;
  gitEnv?: NodeJS.ProcessEnv;
  store?: EventStore;
  /**
   * Re-run after merging the base in, before merging out. The gates already ran
   * against the agent's head; this is the "does it still work with what landed
   * in the meantime" question, which is a different one.
   */
  verify?: (cwd: string) => Promise<{ ok: boolean; evidence: string }>;
}

export type IntegrateResult =
  | { ok: true; mergeCommit: string }
  | { ok: false; reason: RefusalReason; detail: string };

/**
 * A push this lane lost and is about to answer itself.
 *
 * **Not an `IntegrateResult`, and deliberately not on the log.** An
 * `IntegrationRefused` is a declared subscriber event — `.lingtai/config.yaml`
 * sends it to `desktop`, which renders it as *#202 did not merge* — and
 * `COMPLETION_EVENTS` wakes a queue pass on it. Appending one for a race the
 * lane goes on to win would interrupt a person about a merge that landed two
 * seconds later, with nothing in the system to retract it, and would wake the
 * conductor while the integration it is about is still running. The whole
 * argument for retrying here is that a lost race owes nobody an explanation;
 * saying it on the log anyway is making the noise the retry was meant to stop.
 *
 * So the type is what keeps it internal: the loop below is the only thing that
 * can see one, and the only way out of this function is still an
 * `IntegrateResult` that has already been appended.
 */
interface LostPush {
  readonly lostThePush: true;
  /** Git's own words, kept for the refusal that a run of these becomes. */
  readonly detail: string;
}

/** Files whose presence in a diff means a human applies the migration, not the agent. */
const MIGRATION_GLOB = /(^|\/)(prisma\/)?migrations?\//i;

/**
 * Git's words for *somebody else got there first*.
 *
 * The bracketed reason differs — `fetch first`, `non-fast-forward` — and the
 * wording has moved between versions, so what is matched is the rejection
 * itself rather than any one cause of it. A push that failed for some other
 * reason (no credentials, no network) is not this, and goes to the unexpected
 * channel where it belongs.
 */
const PUSH_REJECTED = /\[rejected\]|non-fast-forward|fetch first|updates were rejected/i;

/**
 * How many times a base may move out from under this merge before a person is
 * told about it.
 *
 * Each retry is a fetch, a worktree, a merge and a push — seconds, no agent, no
 * money — against the base as it now stands, which is precisely what the move
 * on the refusal's card asks a person to do by hand. Three of them, so four
 * pushes in all — bounded rather than endless because a base that beats one
 * merge four times running is busy in a way a person should hear about, and
 * because a loop with no ceiling in the one place that writes to the base
 * branch is the wrong thing to leave running unattended.
 *
 * **Four pushes, one attempt.** The whole run of them is a single
 * `IntegrationAttempted` and a single terminal, because it is a single
 * integration: see `LostPush` for why the ones in the middle say nothing on the
 * log.
 */
const LOST_PUSHES = 3;

/**
 * How long one of this lane's worktrees may sit untouched before it is a corpse.
 *
 * **Nothing else reclaims one.** The name carries a uuid so that two
 * integrations against one base cannot stand in one directory, which means a
 * process killed inside a merge — a second Ctrl+C, a `--timeout`, a crash —
 * leaves both a checkout and a registration that no scope will ever close, and
 * `git worktree prune` does not touch one whose directory is still there. The
 * fixed `integrator-<base>` this replaced was bounded at one per base; a uuid
 * is bounded by nothing, so each integration sweeps what earlier ones left
 * behind before it cuts its own.
 *
 * Age is the whole of what tells a corpse from a colleague now that two on one
 * base is ordinary. An hour is `runtime.limits.wall`, the ceiling on the pass
 * that owns the merge — past it, whatever cut the directory is not coming back
 * for it.
 */
const WORKTREE_IS_ABANDONED_AFTER = 60 * 60 * 1_000;

/**
 * The promise face, for callers that are not Effect.
 *
 * `conductor/src/approve.ts` and the board reach the integrator from ordinary
 * `async` code, with no `try` around the call: `approve.ts` has spent the
 * approval by the time it gets here, so an exception out of this would leave
 * the item gating with nothing on the log to say why.
 *
 * The error channel below is `never` — every path appends and returns an
 * `IntegrateResult` — and `unexpected` is what makes that true of the defect
 * channel too, which is where a store that stopped answering arrives. So
 * running it here cannot throw.
 */
export function integrate(options: IntegrateOptions): Promise<IntegrateResult> {
  return Effect.runPromise(integrateEffect(options));
}

export function integrateEffect(options: IntegrateOptions): Effect.Effect<IntegrateResult> {
  const store = options.store ?? eventStore;
  const home = options.home ?? stateDir();
  const stream = integrationStream(options.project, options.base);
  const run = { token: options.token, env: options.gitEnv };

  // Every exit goes through one of these two. There is no `return` in this
  // function that does not append first.
  //
  // The lane's stream has more than one writer *by design*: two integrations
  // against one base overlap, and each appends its own attempt and outcome. So
  // an append here re-reads and retries on a lost race — which is exactly what
  // `ConcurrencyError` means, and the first version of this function did not do
  // it. The concurrency test found that immediately.
  //
  // **This retry is not about the lock**, and it stayed when the lock went
  // (#194): the writers it answers for are the integrations themselves, which
  // the lock never excluded from the stream — only from the merge.
  async function append(
    type: "IntegrationAttempted" | "IntegrationRefused" | "IntegrationSucceeded",
    data: unknown,
  ): Promise<void> {
    const payload = { type, actor: "conductor" as const, data: parsePayload(type, data) };
    for (let attempt = 0; attempt < 8; attempt++) {
      const at = reduceIntegration(await store.read(stream)).version;
      try {
        await store.append(stream, at, [payload]);
        return;
      } catch (err) {
        if (!(err instanceof ConcurrencyError)) throw err;
        // Someone else moved the lane on. Read where it is now and try again.
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
      }
    }
    throw new Error(`could not record ${type} on ${stream} after 8 attempts`);
  }

  const refuse = (reason: RefusalReason, detail: string): Effect.Effect<IntegrateResult> =>
    Effect.promise(async () => {
      await append("IntegrationRefused", {
        workItemId: options.workItemId,
        branch: options.branch,
        reason,
        detail: detail.slice(0, 2_000),
      });
      return { ok: false, reason, detail } as IntegrateResult;
    });

  const succeed = (mergeCommit: string): Effect.Effect<IntegrateResult> =>
    Effect.promise(async () => {
      await append("IntegrationSucceeded", {
        workItemId: options.workItemId,
        branch: options.branch,
        base: options.base,
        mergeCommit,
      });
      return { ok: true, mergeCommit } as IntegrateResult;
    });

  /**
   * The defect channel, and the last thing between a caller and an exception.
   *
   * `integrate()` above promises that it cannot throw, and everything that
   * appends can: `store.read` and `store.append` reject on a dropped
   * connection, `Effect.promise` turns that rejection into a defect, and a
   * defect no handler sees leaves `Effect.runPromise` as a rejected promise.
   * Neither caller has a `try` around it — `approve.ts` has already spent the
   * approval by then — so an escaping defect is the #84 dead end: no
   * `IntegrationRefused`, no `WorkItemBlocked`, no diagnosis, and a second
   * attempt refused.
   *
   * So a defect becomes the refusal it always was. **And if recording that
   * refusal defects too — which is the ordinary case, because the store is
   * usually what failed — the caller is still given an `IntegrateResult`**: the
   * event cannot be written by definition, and a refusal the caller can act on
   * is worth more than an exception it cannot. This is the one path in here
   * that may return without an event, and only when the log is what is down.
   */
  const unexpected = (defect: unknown): Effect.Effect<IntegrateResult> => {
    const detail = `the integration failed unexpectedly: ${
      defect instanceof Error ? defect.message : String(defect)
    }`;
    return refuse("conflict", detail).pipe(
      Effect.catchAllDefect(() =>
        Effect.succeed({ ok: false, reason: "conflict", detail } as IntegrateResult),
      ),
    );
  };

  const at = (args: string[], cwd: string) => gitEffect(args, { ...run, cwd });

  /**
   * The worktrees of this lane that nothing is coming back for.
   *
   * Found the way the system itself finds them — registered under the mirror,
   * named for the integrator — and judged by age, which is all that is left to
   * judge them by now that two live ones on one base is ordinary
   * (`WORKTREE_IS_ABANDONED_AFTER`). The directory's mtime is when it was cut,
   * so an integration in flight is minutes old at the outside.
   *
   * Every step swallows its own failure. A sweep that refused a merge would be
   * a worse bug than the one it is here to clear.
   */
  const sweepAbandoned = (mirror: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const registered = yield* at(["worktree", "list", "--porcelain"], mirror).pipe(
        Effect.orElseSucceed(() => ""),
      );
      for (const line of registered.split("\n")) {
        if (!line.startsWith("worktree ")) continue;
        const path = line.slice("worktree ".length).trim();
        if (!basename(path).startsWith("integrator-")) continue;
        const cutAt = yield* Effect.promise(
          async () => (await stat(path).catch(() => null))?.mtimeMs ?? null,
        );
        if (cutAt === null || Date.now() - cutAt < WORKTREE_IS_ABANDONED_AFTER) continue;
        yield* at(["worktree", "remove", "--force", path], mirror).pipe(Effect.ignore);
        yield* Effect.tryPromise(() => rm(path, { recursive: true, force: true })).pipe(
          Effect.ignore,
        );
      }
      // And the registrations with no directory left — git's own job, and the
      // other half of what a killed process leaves behind.
      yield* at(["worktree", "prune"], mirror).pipe(Effect.ignore);
    });

  /**
   * One merge, computed against the base as it stands and pushed.
   *
   * It is not *the* attempt — `IntegrationAttempted` is appended once, by the
   * loop at the bottom, because the run of these is one integration. What comes
   * back is either a terminal already on the log or a `LostPush`, which is not.
   */
  const attempt: Effect.Effect<IntegrateResult | LostPush> = Effect.scoped(
    Effect.gen(function* () {
      // The gates' verdict is the integrator's business only in that it refuses.
      if (!options.stepsPassed) {
        return yield* refuse("gate-failed", options.stepDetail ?? "a gate refused this diff");
      }

      const mirror = `${home}/repos/${options.project}.git`;
      // **One worktree per integration, not one per base.** A fixed
      // `integrator-<base>` was safe only because the lock meant one
      // integration on a base at a time. Nothing serialises them before the
      // push now (#194), so two overlap by design and each needs a directory —
      // and a HEAD — that the other cannot be standing in.
      const cwd = worktreePath(
        home,
        options.project,
        `integrator-${options.base.replace(/\//g, ".")}-${randomUUID().slice(0, 8)}`,
      );

      // Only the two refs this merge is about, rather than `+refs/heads/*`.
      // A wildcard fetch refuses to update any branch checked out in *some other*
      // worktree of the same mirror — which the agent's is, holding exactly this
      // branch. Narrowing it removes the whole class of collision rather than the
      // one instance.
      yield* at(
        [
          "fetch",
          "--prune",
          "origin",
          `+refs/heads/${options.base}:refs/heads/${options.base}`,
          `+refs/heads/${options.branch}:refs/heads/${options.branch}`,
        ],
        mirror,
      );

      // What an earlier integration was killed in the middle of, before this one
      // adds a directory of its own: see `WORKTREE_IS_ABANDONED_AFTER`. A
      // registration whose directory is already gone is git's own `prune` to
      // clear, and one still standing is this sweep's — nothing else in the
      // system looks at these.
      yield* sweepAbandoned(mirror);

      // The worktree is disposable; the mirror is the expensive part. Acquired
      // and released as one thing, so no path below has to remember it — and it
      // is the only thing this scope holds since the lock went (#194).
      //
      // **Detached**, for the reason the agent's worktree is (0039 §1): a
      // checked-out `integrate/<base>` is a ref in the mirror, and a second
      // integration against the same base would collide with the first on it.
      // Nothing here needs the branch — the merge moves HEAD and the push has
      // always been `HEAD:refs/heads/<base>`.
      yield* Effect.acquireRelease(
        at(["worktree", "add", "--force", "--detach", cwd, options.base], mirror),
        () => at(["worktree", "remove", "--force", cwd], mirror).pipe(Effect.ignore),
      );

      const dirty = yield* at(["status", "--porcelain"], cwd);
      if (dirty.trim()) {
        // Cannot happen with a worktree Lingtai just cut, which is the point
        // — the check is here so that if it ever does, it is an event and not a
        // mystery. The old loop merged in a checkout it did not own and this was
        // the failure it could not report.
        return yield* refuse("dirty-base", `the integrator's worktree is not clean:\n${dirty}`);
      }

      const localBase = yield* at(["rev-parse", options.base], mirror);
      const remoteBase = yield* at(["rev-parse", `refs/heads/${options.base}`], mirror);
      if (localBase !== remoteBase) {
        return yield* refuse(
          "unpushed-base",
          `${options.base} is ${localBase} locally and ${remoteBase} on origin`,
        );
      }

      const ahead = yield* at(["rev-list", "--count", `${options.base}..${options.branch}`], mirror);
      if (Number(ahead) === 0) {
        return yield* refuse("no-commits", `${options.branch} has nothing ${options.base} does not`);
      }

      const changed = yield* at(
        ["diff", "--name-only", `${options.base}...${options.branch}`],
        mirror,
      );
      const migrations = changed.split("\n").filter((f) => f && MIGRATION_GLOB.test(f));
      if (migrations.length > 0) {
        // The hold that caught #117, generalised. A migration is applied by a
        // person who has looked at it, not by a merge.
        return yield* refuse(
          "pending-migration",
          `the diff adds migration files, which need applying by hand first:\n${migrations.join("\n")}`,
        );
      }

      // Merge base in first, so a conflict is discovered here rather than
      // halfway through writing to the base branch.
      const mergedIn = yield* Effect.either(at(["merge", "--no-edit", options.branch], cwd));
      if (Either.isLeft(mergedIn)) {
        const conflicts = yield* at(["diff", "--name-only", "--diff-filter=U"], cwd).pipe(
          Effect.orElseSucceed(() => ""),
        );
        yield* at(["merge", "--abort"], cwd).pipe(
          // Nothing to abort; the merge failed before it started one.
          Effect.ignore,
        );
        return yield* refuse(
          "conflict",
          `${options.branch} does not merge into ${options.base}:\n${conflicts || mergedIn.left.detail}`,
        );
      }

      if (options.verify) {
        const verify = options.verify;
        const verified = yield* Effect.tryPromise({
          try: () => verify(cwd),
          catch: (err) => new RepoFailed({ operation: "verify", detail: (err as Error).message }),
        });
        if (!verified.ok) {
          // The gates ran against the agent's head. This is the different
          // question of whether it still works beside what landed since.
          return yield* refuse(
            "gate-failed",
            `verification after merging ${options.base} in failed:\n${verified.evidence}`,
          );
        }
      }

      const mergeCommit = yield* at(["rev-parse", "HEAD"], cwd);

      // ---- the ref update, which is what serialises this lane ----------------
      // Everything above was computed against the base as it stood when this
      // integration fetched it. Another one may have landed in the meantime;
      // git says so here, atomically, by refusing a push that is not a
      // fast-forward. **That rejection is not a refusal**, and is the one thing
      // out of this function that does not append: it is answered where it is
      // made, by recomputing against the base where it now is (`LOST_PUSHES`),
      // because nothing is wrong with the branch and nobody's judgement is
      // owed. Only a base that beats every one of those pushes becomes an
      // `IntegrationRefused`, at the loop below — see `LostPush`.
      const pushed = yield* Effect.either(
        at(["push", "origin", `HEAD:refs/heads/${options.base}`], cwd),
      );
      if (Either.isLeft(pushed)) {
        // A push that failed for some other reason is not this lane's business
        // to read, and goes to the unexpected channel at the bottom.
        if (!PUSH_REJECTED.test(pushed.left.detail)) return yield* Effect.fail(pushed.left);
        return { lostThePush: true, detail: pushed.left.detail } satisfies LostPush;
      }
      // The mirror is Lingtai's own copy of the truth; leaving it stale would
      // make the next integration compute against a base that has moved.
      yield* at(["fetch", "origin", `+refs/heads/${options.base}:refs/heads/${options.base}`], mirror);

      return yield* succeed(mergeCommit);
    }).pipe(
      // The typed channel, where the catch-all used to be. A git command that
      // refused anywhere above still leaves an event behind — which is the
      // entire difference from six silent `return 1`s — and now the compiler
      // knows that is the only thing it has to answer for.
      Effect.catchTag("RepoFailed", (err) =>
        refuse("conflict", `the integration failed unexpectedly: ${err.detail}`),
      ),
      // And the defect channel, for what is not a git failure at all. It is the
      // remains of the catch-all rather than the catch-all: everything the type
      // system can see has already been handled one line up.
      Effect.catchAllDefect(unexpected),
    ),
  );

  /**
   * **A base that moved is answered here, and not by a person.**
   *
   * One integration, whatever it takes: a single `IntegrationAttempted` at the
   * top, then as many merges as the base makes necessary, then a single
   * terminal. Nothing is reused between two of them — the base is fetched
   * afresh, the merge is recomputed in a worktree of its own, and `verify` is
   * asked again about the tree that actually exists now — but none of that is a
   * new *attempt*, because the caller asked for one merge and is owed one
   * answer.
   *
   * **That is also why a lost push appends nothing** (`LostPush`). A refusal is
   * the sentence a person reads: it reaches the `desktop` subscriber as *did
   * not merge* and wakes a queue pass, and neither is true of a race this lane
   * is still in the middle of winning. Writing one per lost push would have
   * sent up to four interruptions per successful merge, none of them
   * retractable — the exact cost the retry exists to avoid, moved from the
   * board to the notification tray.
   *
   * The retry is here rather than at the caller because both callers do the
   * same thing with a refusal — `run-once.ts` blocks the item on a human
   * acknowledgement, `approve.ts` blocks it with the approval already spent —
   * and neither has anything to decide. A rejected push says the branch is fine
   * and the base moved, which is a recomputation, not a question: an item that
   * waits for a person to click Requeue in a repository that merges unattended
   * is a ticket stopped by a race it won nothing by losing.
   */
  return Effect.gen(function* () {
    yield* Effect.promise(() =>
      append("IntegrationAttempted", {
        workItemId: options.workItemId,
        branch: options.branch,
        headSha: options.headSha,
      }),
    );

    let lastRejection = "";
    for (let push = 0; push <= LOST_PUSHES; push++) {
      const outcome = yield* attempt;
      if (!("lostThePush" in outcome)) return outcome;
      lastRejection = outcome.detail;
    }
    // Every push lost. Now it is a person's, and the card's move — requeue —
    // is the honest one: the branch is fine and the base is busy.
    return yield* refuse(
      "push-rejected",
      `${options.base} moved while ${options.branch} was being merged into it, ` +
        `every one of ${LOST_PUSHES + 1} times; origin rejected the last push:\n${lastRejection}`,
    );
    // The append at the top and the refusal just above are appends like any
    // other, and `attempt`'s own handlers are inside it and never see them.
    // This is what covers both — and whatever gets past `attempt`'s.
  }).pipe(Effect.catchAllDefect(unexpected));
}
