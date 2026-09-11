/**
 * One work item, discovery through merge, with a person watching.
 *
 * This is the wiring, and almost none of the logic — every piece it calls has
 * its own tests and its own reasons. What is here is the *order*, and the order
 * is the part that has to be right:
 *
 *   resolve the recipe from origin/<base>   never from the agent's branch, and
 *                                           it must name that branch as its own
 *   resolve the environment                 a declared name with no value
 *                                           refuses here, before the money
 *   discover, claim                         the constraint decides the race
 *   provision the worktree                  filtered env, submodules, 0600
 *   prove the hook fails closed             before anything is dispatched
 *   RunStarted                              the conductor knows more than the hook
 *   run the agent                           on the socket, restricted by nothing
 *   the diff → `proposed`                   each refusal typed and recorded
 *   a refused review → a fix → `proposed`   the findings bought an agent (0038)
 *   → `merge`                               only when `proposed` passed
 *   → integrate                             a point with actions always runs
 *
 * **Every exit appends.** A run that ends leaves either `RunFinished` or
 * `RunFailed`, and a work item that does not land is either released or blocked
 * with a question. The old loop could end in silence in at least seven places;
 * that is the thing being replaced.
 *
 * **And a failure that belongs to the managed repository has a third exit**
 * since [0025](../../../doc/decisions/0025-a-failure-buys-one-agent.md): it
 * buys one agent. Not a sixth gate point — the set stays five and stays closed
 * — but an *outcome* of the merge lane refusing. `RepairRequested` goes down,
 * the item is released, and the next claim is the repair, told what went wrong
 * and ending by asking a person to approve the diff it produced. The decision
 * of whether to buy one is `repair.ts`'s; what is here is where it is asked.
 *
 * **A refused *review* buys an agent too, and spends it here rather than next
 * time** ([0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)).
 * Still not a sixth point: `proposed` simply runs again, on the head a fixing
 * agent committed, with the refused findings' failure scenarios handed to the
 * fixer verbatim and put back to the reviewer as the question *does that
 * sequence still produce that outcome*. The worktree is up and the diff is the
 * thing under discussion, so nothing is released and nothing is re-claimed; when
 * the rounds are spent and the review still refuses, a person is asked, and what
 * they are shown says **two agents disagreed**. The decisions are `fix.ts`'s.
 *
 * It used to say so and then keep the promise by hand: two nested `finally`
 * blocks and a `catch (err)` whose own comment admitted what it was. Since
 * [0026](../../../doc/decisions/0026-the-conversion-past-the-seam.md) the
 * promise is structural instead.
 *
 * **Four things a run acquires, and one scope each.** The worktree, the hook
 * socket and the agent process are `Effect.acquireRelease` pairs, so each is
 * released because its scope closed — on the happy path, on a typed refusal, on
 * a defect and on an interruption alike. The scopes also encode an ordering
 * that used to be a comment beside an explicit call: *the worktree is gone
 * before the integrator runs*, because the integrator is outside its scope.
 *
 * The fourth is the run's log file
 * ([0034](../../../doc/decisions/0034-the-run-log.md)), and its scope is wider
 * than the other three for the reason the others' are narrow: its release
 * decides **keep or delete**, and that turns on whether the run landed, which
 * is not known until after the worktree is gone.
 *
 * **And one ending stops the conductor rather than the item.** A run that never
 * started ([0031](../../../doc/decisions/0031-a-run-that-never-started.md)) met
 * something account-wide, so the item is released like any other failure and
 * `ctl-conductor` is told to take nothing at all until the limit lifts. It is
 * the only place in this file that appends outside the run and the work item,
 * and it is deliberate: per-item backoff answering an account-wide condition is
 * what eighty events in ninety-two seconds looked like.
 *
 * **The refusals come first, deliberately.** Everything up to the claim
 * acquires nothing, so a run that stops at an unreadable recipe or a missing
 * environment value has provisioned no worktree to release — the lesson 0024
 * recorded about where a scope *starts*, kept here as a test rather than as an
 * intention.
 */
import { type ResolvedRecipe, baseDivergence, parseDuration } from "@lingtai/recipe";
import { type Tier, parsePayload } from "@lingtai/domain";
import {
  type GateFinding,
  type PipelineResult,
  gatesFromRecipe,
  runGatePipeline,
} from "@lingtai/actions";
import type { GitHubClient } from "@lingtai/github";
import { NO_RUN_LOG, type RunLog, type Runtime, missingForTier, writeUnhookedSettingsEffect } from "@lingtai/agent";
import { type EventStore, eventStore } from "@lingtai/event-store";
import { claimWorkItem, releaseWorkItem } from "./claim.ts";
import { decideRepair, diagnoseRefusal } from "./repair.ts";
import {
  decideFix,
  declineWhy,
  diagnoseDisagreement,
  disagreementQuestion,
  fixBrief,
} from "./fix.ts";
import { standDown } from "./never-started.ts";
import { priorAttempts } from "./attempts.ts";
// The one composer, shared with the board. See `prompt.ts` for why it is not
// here any more.
import { nextPrompt, renderPrompt } from "./prompt.ts";
import {
  CONTROL_STREAM,
  type ToAppend,
  reduceControl,
  reduceWorkItem,
  workItemStream,
} from "@lingtai/domain";
import { runnableNow } from "./discover.ts";
import { appendEndActions, resolveEndActions } from "./end-point.ts";
import { labelsFor } from "./labels.ts";
import { tellGitHubAbout } from "./tell.ts";

import { GATE_POINTS, type ProjectState } from "@lingtai/domain";
import { extensionEnv, runnableEnv } from "@lingtai/agent-env";
import { stateDir } from "@lingtai/env";
import type { TokenSource } from "@lingtai/repo";
import { Data, Effect, Either } from "effect";
import { AgentHost, Repo } from "./ports.ts";
import { spawn } from "node:child_process";
import { RUN_LOG_END, runLogEnd, runLogPath } from "./run-log.ts";

export interface RunOnceOptions {
  project: ProjectState;
  client: GitHubClient;
  runtime: Runtime;
  /** The issue to work. Phase 1 nominates by number rather than taking the queue. */
  issue: number;
  /** Absolute path to the compiled `lingtai-hook`. */
  hookBinary: string;
  /** False wires no hooks and skips the smoke test. See `RenderOptions.guard`. */
  guard?: boolean;
  /** The ticket prompt. Versioned, and recorded on every `RunPrompted`. */
  prompt: string;
  promptVersion?: string;
  token?: TokenSource;
  home?: string;
  store?: EventStore;
  gitEnv?: NodeJS.ProcessEnv;
  /** Overrides the clone source. The tests point it at a local repository. */
  remote?: string;
  /**
   * False stops after the gates, with the branch pushed and every verdict
   * recorded, and asks a person for the merge.
   *
   * This is not a separate mechanism from the human gate (#20). It requests the
   * same `ApprovalRequested` a `human:` action at `merge` requests, which is
   * what keeps it from becoming a second vocabulary for one idea. A recipe that
   * declares nothing at `merge` still holds under the flag; one that declares a
   * person there holds whether or not the flag was passed. The hold is
   * bound to `onSha` like any other verdict, so a force-push invalidates it by
   * arithmetic rather than by anyone remembering to.
   */
  merge?: boolean;
  log?: (line: string) => void;
}

export type RunOnceResult =
  | { ok: true; workItemId: string; runId: string; mergeCommit: string }
  /**
   * Reached the merge and stopped, because a person asked it to. Deliberately
   * not `ok: false` with a stage — nothing refused, and calling it a failure
   * would be the kind of convenient fiction the log exists to prevent.
   */
  | { ok: "held"; workItemId: string; runId: string; headSha: string; gate: string }
  | { ok: false; workItemId: string | null; runId: string | null; stage: string; detail: string };

/**
 * A refusal taken **after** the claim, in the error channel.
 *
 * The two facts a refusal carries are different and were being conflated: what
 * the caller is told (`stage`, `detail`) and why the work item is going back to
 * the queue (`release`). Each one used to be written out at the call site, next
 * to a `release(...)` somebody had to remember to `await` first. Here the
 * handler at the bottom of `runOnce` does both, once, for every one of them.
 *
 * Refusals taken *before* the claim are plain returns: there is no stream to
 * release and nothing acquired to unwind.
 */
class Stopped extends Data.TaggedError("Stopped")<{
  readonly stage: string;
  readonly detail: string;
  /** Why the work item is going back to the queue. Names the run's ending. */
  readonly release: string;
}> {}

/**
 * A failure's own words, at the width one line on a card survives.
 *
 * The same 300 the repair's handover question clips to, and for its reason: a
 * `detail` is the runtime's output verbatim, a release reason is a sentence
 * somebody reads in a column, and the whole of it is on the log a click away.
 * Whitespace is flattened because the output has newlines in it and the card
 * does not.
 */
function said(detail: string, n = 300): string {
  const one = detail.replace(/\s+/g, " ").trim();
  if (one === "") return "no detail was recorded";
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** How a runtime is spawned for the fail-closed smoke test. */
function runBinary(
  bin: string,
  env: Record<string, string>,
  stdin: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) => resolve({ code, stderr }));
    child.on("error", (err) => resolve({ code: null, stderr: err.message }));
    child.stdin.end(stdin);
  });
}

/**
 * Any port failure, as the refusal it is.
 *
 * `RepoFailed` and `AgentHostFailed` both say *what could not be done*; this
 * says what that means for the run. The typed channel is what makes it one
 * line at each call site rather than a `try`/`catch` around each one.
 */
const failing =
  (stage: string) =>
  <A, E extends { readonly detail: string }, R>(self: Effect.Effect<A, E, R>) =>
    Effect.mapError(
      self,
      (err) => new Stopped({ stage, detail: err.detail, release: `${stage}: ${err.detail}` }),
    );

export function runOnce(
  options: RunOnceOptions,
): Effect.Effect<RunOnceResult, never, Repo | AgentHost> {
  return Effect.gen(function* () {
    // Asked for, not threaded through. `runOnce` is the thing that needs them,
    // so it is the thing that names them — which is the half of 0023 the
    // `RunPorts` parameter was still standing in for.
    const repo = yield* Repo;
    const host = yield* AgentHost;

    const store = options.store ?? eventStore;
    const home = options.home ?? stateDir();
    const log = options.log ?? (() => {});
    const project = options.project.project!;
    /**
     * The template's own version. What actually goes on the log is this plus
     * the failure block's fingerprint, once that block is known — see
     * `promptVersionFor` and `#82`'s fourth criterion.
     */
    const basePromptVersion = options.promptVersion ?? "ticket@1";

    /**
     * The log, as an `Effect`.
     *
     * `Effect.promise` and not `Effect.tryPromise` on purpose: the event store
     * is not a port and a store that will not append is not a refusal this
     * function can make on anyone's behalf. It is a defect, and the handler at
     * the bottom is where defects are answered for.
     */
    const appendAtEnd = (stream: string, events: readonly ToAppend[]) =>
      Effect.promise(async () => {
        const at = (await store.read(stream)).length;
        await store.append(stream, at, events);
      });

    // ---- 1. the recipe, from the base branch --------------------------------
    // The base recorded at `lingtai add`, not the repository's default branch. Those
    // are the same only by convention, and `nextloom-ai-admin`'s default is a
    // feature branch — reading the rules from one branch while merging into
    // another is exactly the confusion 0005 exists to prevent.
    const recipeAt: Either.Either<ResolvedRecipe, string> = yield* Effect.either(
      Effect.tryPromise({
        try: async () => {
          const from = options.project.base ?? (await options.client.defaultBranch());
          return await (
            await import("@lingtai/recipe")
          ).resolveRecipe((p, r) => options.client.fileAt(p, r), from);
        },
        // Refusing here is the point of 0005: an unreadable or non-compliant recipe
        // must stop the run rather than fall back to a default.
        catch: (err) => (err as Error).message,
      }),
    );
    if (Either.isLeft(recipeAt)) {
      return { ok: false, workItemId: null, runId: null, stage: "recipe", detail: recipeAt.left };
    }
    const resolved = recipeAt.right;
    const recipe = resolved.recipe;
    // The other half of that comment, which the code above did not do: the ref the
    // rules came from and the branch they say they govern have to be one branch.
    // Here rather than beside the merge, and for the same reason the `env.required`
    // refusal below is where it is — nothing is claimed yet, so a project whose two
    // bases disagree costs a fetch and stops. It refuses rather than picking a
    // winner: both branches are recorded decisions, and nothing here repairs a
    // recorded decision silently (0024 §3).
    const divergence = baseDivergence(resolved, `${options.client.owner}/${options.client.repo}`);
    if (divergence) {
      return { ok: false, workItemId: null, runId: null, stage: "recipe", detail: divergence };
    }
    // Safe now, and only now: past the refusal these two are the same branch.
    const base = recipe.repo.base;
    log(`recipe ${resolved.configHash.slice(0, 12)} from ${resolved.ref}, tier ${resolved.tier}`);

    // ---- 2. the environment, before anything is claimed ----------------------
    // A declared name with no value refuses the whole project for this pass: no
    // worktree, no agent, no money. It used to be a log line — `env: X not set,
    // so not planted` — after which the run claimed the ticket and spent $0.97
    // producing nothing against a database it could not reach (ADR 0020).
    //
    // Here rather than beside the worktree, because everything between costs
    // something: the claim is an event other schedulers respect, and the clone
    // is a network round trip.
    const asked = yield* Effect.either(
      host.resolveEnv({
        project,
        // All three, because all three are the recipe's and none is this
        // file's business: `required` refuses, `allow`/`deny` filter (0021).
        required: recipe.env.required,
        allow: recipe.env.allow,
        deny: recipe.env.deny,
        home,
      }),
    );
    if (Either.isLeft(asked)) {
      // ProductionValueError. Refusing before the claim for the same reason.
      return { ok: false, workItemId: null, runId: null, stage: "env", detail: asked.left.detail };
    }
    const env = asked.right;
    // Returned rather than logged: the refusal is a whole paragraph naming the
    // file to write, and every caller already prints `stage: detail`.
    if (env.refusal) {
      return { ok: false, workItemId: null, runId: null, stage: "env", detail: env.refusal };
    }
    log(
      `env: ${env.names.length === 0 ? "nothing declared" : env.names.map((n) => `${n.name} from ${n.layer}`).join(", ")}`,
    );

    /**
     * The environment of one extension — every `run:` action's, and nothing
     * else's ([0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §1).
     *
     * `runnableEnv` over the declared names only. Not `env.values`: that is the
     * agent's, and handing it to a command is what put one project's credential
     * in every extension's process. Layer 1's six are added because a command
     * with no `PATH` cannot find `pnpm`, which is the failure `RUNNABLE` exists
     * to have answered once.
     *
     * Missing names are not refused here. `lingtai doctor` says so before a run
     * starts, which is where the answer is still cheap; refusing mid-run would
     * put an operator's typo between an agent's work and its gates.
     */
    const envForExtension = (declared: readonly string[]): Record<string, string> =>
      runnableEnv(extensionEnv(env.merged, declared).values);

    // ---- 3. capability matching, before anything is claimed ------------------
    const tier: Tier = resolved.tier;
    const missing = missingForTier(options.runtime.capabilities, tier);
    const workItemId = workItemStream(project, options.issue);

    if (missing.length > 0) {
      // Never silently downgrade. The refusal is an event on the work item so the
      // board can say why nothing ran — appended at whatever version the stream
      // is at, including zero. Nothing precedes it now that discovery appends
      // nothing, and a refusal nobody can read is the failure mode this whole
      // file exists to remove.
      yield* appendAtEnd(workItemId, [
        {
          type: "DispatchRefused",
          actor: "conductor",
          data: parsePayload("DispatchRefused", {
            requiredTier: tier,
            runtime: options.runtime.capabilities.id,
            missing,
          }),
        },
      ]);
      return {
        ok: false,
        workItemId,
        runId: null,
        stage: "dispatch",
        detail: `${options.runtime.capabilities.id} cannot provide ${tier}: missing ${missing.join(", ")}`,
      };
    }

    // ---- 4. discover and claim ----------------------------------------------
    // Eligibility is asked, not looked up. Nothing was appended when this issue
    // was first seen (0012), so there is no "was it discovered" to read — the
    // recipe decides against the issue as GitHub reports it right now, which is
    // also the only way a label edit takes effect without a second mechanism.
    const found = yield* Effect.promise(() =>
      runnableNow({ client: options.client, recipe, only: [options.issue] }),
    );
    const runnable = found.runnable.find((r) => r.ref === String(options.issue));
    if (!runnable) {
      const why = found.skipped.find((s) => s.ref === options.issue)?.reason ?? "not runnable";
      return { ok: false, workItemId, runId: null, stage: "discover", detail: why };
    }

    const runId = `run-${crypto.randomUUID()}`;

    /**
     * Whether this run is a repair, read **before** the claim consumes it.
     *
     * A failure that bought an agent appended `RepairRequested` and then
     * released the item, so between those two the fold carries a pending
     * repair and the next claim is it
     * ([0025](../../../doc/decisions/0025-a-failure-buys-one-agent.md)). There
     * is no second event and no flag on `RunStarted`: a repair is an ordinary
     * run, and the only thing that differs is what its prompt was told and that
     * it ends by asking a person rather than by merging.
     *
     * Read here rather than after the claim because the claim is what clears
     * it — `claimWorkItem` appends, and the fold moves it into `repairRun`.
     */
    const before = yield* Effect.promise(() => store.read(workItemId));
    const item = reduceWorkItem(before);
    const repairOf = item.pendingRepair;
    /**
     * A sentence a person added for this attempt, and only this one.
     *
     * Read here and not after the claim for the same reason `repairOf` is: the
     * claim below is what consumes it (0032 §5), so a read taken afterwards
     * would find nothing and the edit would silently never reach the agent —
     * a control the page claims and the code does not have, which is exactly
     * the shape `renderPrompt` refuses for `{{failure}}`.
     */
    const edit = item.pendingPrompt;
    if (edit) log(`carrying a prompt edit from ${edit.by} (${edit.text.length} bytes)`);
    if (repairOf) {
      log(`repairing ${repairOf.reason} from ${repairOf.after} (attempt ${repairOf.attempt})`);
    }

    /**
     * What the earlier attempts did, for this one's prompt.
     *
     * Read from the same envelopes and for the same reason `repairOf` is read
     * here: the claim below appends, and this run must not appear in its own
     * history. Empty for a first attempt, and then everything downstream —
     * prompt bytes, `promptVersion` — is what it was before `#82` (`attempts.ts`).
     *
     * **One extra stream read, and only when there is a history.** The last
     * attempt is the one whose evidence is quoted, because it is the one the
     * worktree is next to; the earlier ones are a row each out of the work item
     * stream already in hand. That is what keeps a fifth attempt from pasting
     * four gate logs into a prompt.
     */
    const previous = priorAttempts(before).at(-1);
    const lastRun = previous
      ? yield* Effect.promise(() => store.read(previous.runId))
      : null;

    /**
     * What this run is told that a first attempt is not.
     *
     * Composed by `prompt.ts` and not here, because the board composes the same
     * document to show a person before they approve it (`#104`) — and a page
     * that builds its own approximation of the prompt invites somebody to
     * approve a document that is not the one that runs.
     *
     * Settled **before the claim**, like `repairOf` and `edit`: the claim is
     * what consumes both, so a version computed afterwards would describe a
     * prompt this run is not getting. The ticket is filled in much later, from
     * inside the scope that has a worktree, which is why `renderPrompt` is a
     * second call rather than part of this one.
     */
    const next = nextPrompt({
      base: basePromptVersion,
      budget: recipe.runtime.budget,
      item: before,
      lastRun,
    });
    const failure = next.failure;
    const promptVersion = next.version;
    if (previous) {
      log(`attempt ${next.attempt}: ${previous.runId} ended — ${previous.ended ?? "no ending recorded"}`);
    }

    // The claim carries what the task is, because it is now the only place a
    // title enters the log at all.
    const claim = yield* Effect.promise(() =>
      claimWorkItem(workItemId, { runId, store, title: runnable.title, kind: runnable.kind }),
    );
    if (!claim.ok) {
      return {
        ok: false,
        workItemId,
        runId: null,
        stage: "claim",
        detail: JSON.stringify(claim.refusal),
      };
    }
    log(`claimed ${workItemId} as ${runId}`);
    // The issue says what the log says, from here on. Inline rather than queued
    // (0022): three calls do not need a table, and a call that does not land is
    // written down and converged later rather than retried.
    yield* Effect.promise(() =>
      tellGitHubAbout({ store, github: options.client, workItemId, labels: labelsFor("running") }),
    );

    // ---- 5. from here on, the item is claimed and every exit appends ---------
    const branch = `agent/${options.issue}`;
    const refusal = (stage: string, detail: string): RunOnceResult => ({
      ok: false,
      workItemId,
      runId,
      stage,
      detail,
    });

    let released = false;
    /**
     * How a run that did not land gives the item back — and there are two ways.
     *
     * An ordinary run **releases**: the item returns to the queue, and the
     * backoff decides when it is seen again. A repair **hands over**: it blocks
     * with a question naming the failure it was bought for and how far it got.
     *
     * That difference is `#84`'s *a repair that cannot fix it says so and hands
     * over the question, rather than proposing something it did not do*.
     * Releasing a failed repair would be worse than doing nothing — the pending
     * repair has been consumed, so the next attempt would be an ordinary run
     * that knows nothing about the conflict and walks straight back into it.
     */
    const release = (reason: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (released) return Effect.void;
        released = true;
        return Effect.tryPromise({
          try: async () => {
            if (repairOf) {
              const question =
                `the repair could not fix it — ${repairOf.reason}: ` +
                `${repairOf.detail.slice(0, 300)} — this attempt ended: ${reason}`;
              const held = await store.read(workItemId);
              const handed = resolveEndActions(held, recipe.gates.end, "blocked");
              // A failure needing acknowledgement rather than a decision: the
              // repair was Lingtai's move and it did not work, so what a person
              // is being handed is a fact, not a question about a diff.
              //
              // The refusal's own reading, with what the repair did put in place
              // of the decline — and **no recommendation**. There is no diff to
              // approve (#84), and requeueing is what the code above refuses to
              // do on its own: the pending repair is spent, so the next
              // ordinary attempt would know nothing about this failure and walk
              // back into it. Nothing here can honestly name a move.
              const diagnosis = {
                ...diagnoseRefusal({
                  reason: repairOf.reason,
                  detail: repairOf.detail,
                  branch,
                  base,
                  why: "one was, and it could not fix it",
                }),
                done: `a repair ran as ${runId} and ended: ${reason}`,
                recommendation: null,
              };
              await store.append(workItemId, held.length, [
                {
                  type: "WorkItemBlocked",
                  actor: "conductor",
                  data: parsePayload("WorkItemBlocked", {
                    question,
                    needsFrom: "human",
                    runId,
                    needs: "acknowledgement",
                    diagnosis,
                  }),
                },
                ...handed,
              ]);
              await tellGitHubAbout({
                store,
                github: options.client,
                workItemId,
                question,
                labels: labelsFor("waiting"),
                appended: handed,
              });
              return;
            }
            // A work item that does not land goes back to the queue rather than
            // sitting claimed by a run that is over.
            await releaseWorkItem(workItemId, runId, reason, store).catch(() => {});
            // `end` fires on *any* terminal outcome, and a run that produced
            // nothing mergeable is the `failed` one. On its own append because
            // the release owns the one above; logged rather than thrown because
            // this path is already carrying somebody else's failure and must not
            // replace it with its own.
            const ended = await appendEndActions(store, workItemId, recipe.gates.end, "failed").catch(
              (err) => {
                log(`end actions not resolved: ${(err as Error).message}`);
                return [];
              },
            );
            await tellGitHubAbout({
              store,
              github: options.client,
              workItemId,
              labels: labelsFor("queued"),
              appended: ended,
            });
          },
          catch: (err) => err,
        }).pipe(
          // For the same reason the two lines above swallow theirs: a release is
          // the last thing a failing run does, and a release that throws would
          // replace the reason the run ended with the reason the cleanup did.
          Effect.ignore,
        );
      });

    /**
     * The conductor stops, because the item backing off is the wrong instrument.
     *
     * [0031](../../../doc/decisions/0031-a-run-that-never-started.md) §3. What
     * a run that never started met is account-wide: every queued item would
     * meet it identically, and six of them did — eighty events in ninety-two
     * seconds, six claims, six worktrees, six branches, nothing spent. Per-item
     * backoff answered an account-wide condition one item at a time, and that
     * is what it looks like when it does.
     *
     * The item itself is *released* as any failed run's is; it keeps its place
     * and nothing is taken from anybody. What changes is that nothing else is
     * taken either, until the pause lifts.
     *
     * **Once, not once per item.** A pause already holding is left exactly as
     * it is — which is the assertion the whole thing is for, and is also what
     * keeps this from overwriting a pause a person made. A person's pause has
     * no expiry (0031 §5); replacing it with one that lifts itself would end a
     * hold they meant to keep.
     */
    const standDownConductor = (detail: string): Effect.Effect<void> =>
      Effect.promise(async () => {
        const events = await store.read(CONTROL_STREAM);
        const control = reduceControl(events);
        if (control.paused) {
          log(`a run never started; the conductor is already paused — ${control.reason ?? "no reason given"}`);
          return;
        }
        const { until, reason } = standDown({
          detail,
          backoffMs: parseDuration(recipe.source.backoff),
        });
        await store.append(CONTROL_STREAM, events.length, [
          {
            type: "ConductorPaused",
            actor: "conductor",
            // `by` is Lingtai and not a person, which is what the board's chip
            // and `lingtai doctor` will say. A pause with nobody's name on it
            // would read as a bug rather than as a decision.
            data: parsePayload("ConductorPaused", {
              by: "lingtai",
              reason,
              until: until.toISOString(),
            }),
          },
        ]);
        log(`a run never started — conductor paused until ${until.toISOString()}`);
      }).pipe(
        // A pause that would not append must not replace the reason the run
        // ended with the reason the pause failed: the run's own `RunFailed` is
        // already down, and the release below still has to happen. It is logged
        // rather than thrown for the reason the release's own catches are.
        Effect.catchAllDefect((defect) =>
          Effect.sync(() =>
            log(`could not pause the conductor: ${defect instanceof Error ? defect.message : String(defect)}`),
          ),
        ),
      );

    /**
     * A fourth scope, outside the other three, and it is the log's.
     *
     * The worktree, the socket and the agent process each have one already.
     * This one is wider than all of them because what closes it has to know
     * something none of them does: **whether the run landed**
     * ([0034](../../../doc/decisions/0034-the-run-log.md) §4). The worktree's
     * scope ends before the merge lane — that is what "before the integrator"
     * means and it cannot be relaxed — so a decision taken there would be taken
     * while the answer is still unknowable.
     *
     * It still runs on every outcome, which is the property 0034 asked for:
     * landed, held, failed, crashed, interrupted. The `catchTag`,
     * `catchAllDefect` and `ensuring` below are outside it, so the file is
     * closed before the release they perform is even attempted.
     */
    const claimed = Effect.gen(function* () {
      /**
       * Whether this run's diff reached the base branch.
       *
       * Read by the release below and set in exactly one place — beside the
       * `WorkItemLanded` append, which is the only sentence in this file that
       * means it. A mutable flag rather than a returned value because the
       * release is a `finally` in every sense: it runs on the paths that never
       * return anything at all.
       */
      let didLand = false;

      /**
       * The run's log, and the keep-or-delete that ends it.
       *
       * **Landed → delete. Did not land → keep.** The diff is on the branch and
       * the events are on the log, so what an agent was thinking during a run
       * that worked has the least marginal value of anything here; what is kept
       * is exactly the investigable set, and the rule needs no timer, no
       * sweeper and no retention period. `#84` cost $26.53 and, once landed,
       * what it was thinking is gone — that cost is real and is accepted.
       *
       * A log that could not be opened is `NO_RUN_LOG` rather than a refusal.
       * The observability of a run is not worth failing it for, and the events
       * — which are the half that settles anything — are unaffected.
       */
      const runLog = yield* Effect.acquireRelease(
        host
          .runLog({ path: runLogPath(home, project, runId) })
          .pipe(
            Effect.catchAll((err) =>
              Effect.sync(() => {
                log(`no run log: ${err.detail}`);
                return NO_RUN_LOG satisfies RunLog;
              }),
            ),
          ),
        (opened) =>
          Effect.promise(async () => {
            // The sentence, and the label a reader recognises it by. `#110`
            // follows this file from another process and has nothing else to
            // tell *the writer has finished* from *the writer is thinking*;
            // both look like a file that has stopped growing. The words are
            // `runLogEnd`'s so that the writing and the reading of this one
            // line cannot drift apart into a tail that never returns.
            opened.note(RUN_LOG_END, runLogEnd(didLand));
            await opened.close(didLand ? "delete" : "keep");
          }),
      );
      runLog.note("run", `${runId} · ${workItemId} · ${branch} → ${base}`);

      /**
       * Everything that needs the worktree, and nothing that does not.
       *
       * The scope ends where `await ports.repo.remove(...)` used to be called by
       * hand, and for the reason that call gave: the worktree holds `agent/<n>`
       * checked out against the same mirror, and git refuses to update a ref
       * some worktree has checked out. Keeping it alive through the merge is
       * what made the first end-to-end run fail. The integrator is below this
       * block because that is now what "before the integrator" *means*.
       */
      const decided = yield* Effect.scoped(
        Effect.gen(function* () {
          const worktree = yield* Effect.acquireRelease(
            repo
              .provision({
                project,
                owner: options.client.owner,
                repo: options.client.repo,
                base,
                branch,
                runId,
                submodules: recipe.repo.submodules,
                plantAt: recipe.env.plantAt,
                env: env.values,
                token: options.token,
                home,
                remote: options.remote,
                gitEnv: options.gitEnv,
              })
              .pipe(failing("worktree")),
            () => repo.remove({ project, runId, home }),
          );
          log(`worktree ${worktree.path} at ${worktree.baseSha.slice(0, 7)}`);

          /** A git command in the worktree, which is where all of them run. */
          const gitInWorktree = (args: string[]) =>
            repo.git(args, { token: options.token, env: options.gitEnv, cwd: worktree.path });

          // ---- 6. the hook, proven to fail closed before anything is dispatched
          // It refuses nothing (ADR 0016 §6) and carries everything: the prompt, the
          // files touched, compaction, and the Stop that fires the gates. Proving it
          // fails closed is therefore about the *record*, not about mediation — a
          // hook that cannot reach the conductor must stop the run rather than let it
          // produce nothing and look like it produced everything.
          const wiring = yield* host
            .wire({ runId, hookBinary: options.hookBinary, home })
            .pipe(failing("hook"));
          // The cold reviewer's own settings, with no hook in them. `wiring`'s
          // settings and `wiring.env` are one thing and the `agent` gate had
          // only the first, so the hook refused the reviewer's opening prompt
          // and every review returned that refusal instead of findings. See
          // `writeUnhookedSettings` for why the answer is no hook rather than a
          // second socket.
          const reviewSettingsPath = yield* writeUnhookedSettingsEffect(runId, "review", home).pipe(
            failing("hook"),
          );

          const smoke = yield* host
            .smokeTest(options.hookBinary, runBinary)
            .pipe(failing("hook"));
          if (!smoke.ok) {
            return yield* new Stopped({
              stage: "hook",
              detail: smoke.detail,
              release: "the hook did not fail closed",
            });
          }

          // ---- 7. the `prepared` point ------------------------------------
          // A gate like any other now, rather than its own stage with its own three
          // events. It runs after the hook smoke test, which costs milliseconds — a
          // broken hook should not take a ten-minute install to discover — and before
          // the agent, which is the whole point: everything past here assumes the
          // agent can run this repository's own commands, and until this stage
          // existed that assumption was simply false.
          //
          // `onSha` is the base: nothing has been committed yet, so the verdict is
          // about the tree the agent is being handed.
          const prepared = yield* Effect.promise(() =>
            runGatePipeline({
              point: "prepared",
              gates: gatesFromRecipe(recipe.gates.prepared, { env: envForExtension }),
              context: {
                runId,
                onSha: worktree.baseSha,
                cwd: worktree.path,
                env: runnableEnv(env.values),
              },
              emit: async (event) => {
                const at = (await store.read(runId)).length;
                await store.append(runId, at, [
                  { type: event.type, actor: "conductor", data: parsePayload(event.type, event.data) },
                ]);
              },
            }),
          );
          if (!prepared.ok) {
            const which = prepared.failedAt ?? prepared.heldAt ?? "prepared";
            return yield* new Stopped({
              stage: "prepare",
              detail: `the ${which} action refused:\n${prepared.results.at(-1)?.evidence ?? ""}`,
              release: `prepare failed at ${which}`,
            });
          }

          let proposedSha: string | null = null;

          /**
           * The socket and the agent, each for exactly as long as it is needed.
           *
           * Two acquisitions rather than one: the hook socket, which used to be
           * closed by a `finally`, and the agent process itself, which was not
           * released by anything at all. A run interrupted mid-agent left a
           * `claude` process holding the worktree; the abort controller here is
           * the release, and `RunRequest.signal` is where the runtime already
           * knew what to do with it.
           */
          const ran = yield* Effect.scoped(
            Effect.gen(function* () {
              const server = yield* host
                .serve({
                  socketPath: wiring.socketPath,
                  store,
                  /**
                   * The live picture, given somewhere to go (0034 §3).
                   *
                   * This callback has existed since the socket did and nothing
                   * consumed it: the events the hook derives are deliberately
                   * buffered — `run.touched`, flushed at the end — because the
                   * board wants what the agent *changed* rather than every read
                   * it made. So a live view of every tool call was already
                   * arriving and was being thrown away, while the only
                   * observable of a running agent was `ps`.
                   *
                   * Writing here is free: `note` returns immediately and the
                   * write happens behind it, so the hook's reply is not waiting
                   * on a disk. The verdict is on the line because the day
                   * something is denied, that line has to look different.
                   */
                  onDecision: (_r, hook, verdict, call) =>
                    runLog.note(
                      call.tool === "" ? hook : call.tool,
                      `${verdict.padEnd(6)}${call.target}`,
                    ),
                  onLifecycle: (_r, hook) => {
                    if (hook === "Stop") proposedSha = "pending";
                    runLog.note("hook", hook);
                  },
                })
                .pipe(failing("hook"));

              // ---- 8. RunStarted, then the agent --------------------------
              /**
               * The limits as applied, resolved once.
               *
               * The runtime is handed these and the log records these, from one
               * expression — two readings of `recipe.runtime.limits` could
               * disagree about what `2h` is, and the whole point of recording
               * them is that they are what was actually in force.
               */
              const limits = {
                turns: recipe.runtime.limits.turns,
                wallMs: parseDuration(recipe.runtime.limits.wall),
              };
              const agentEnv = runnableEnv({ ...env.values, ...wiring.env });

              /**
               * How the agent is about to be invoked, asked of the adapter that
               * will invoke it.
               *
               * `RunStarted` used to name the runtime and stop, so *"what
               * command did we run"* was unanswerable (#88). It is asked here,
               * before the spawn, from the same function that builds the argv —
               * and a runtime with no answer records null rather than a
               * reconstruction.
               */
              const spawned = options.runtime.invocation?.({
                runId,
                cwd: worktree.path,
                settingsPath: wiring.settingsPath,
                env: agentEnv,
                limits,
              });

              // Not version 0 any more: prepare wrote first. Asserting 0 here would
              // have failed the moment a recipe declared a single prepare step.
              yield* appendAtEnd(runId, [
                {
                  type: "RunStarted",
                  actor: "conductor",
                  data: parsePayload("RunStarted", {
                    workItemId,
                    runtime: options.runtime.capabilities.id,
                    model: "",
                    promptVersion,
                    baseSha: worktree.baseSha,
                    configHash: resolved.configHash,
                    worktree: worktree.path,
                    invocation: spawned
                      ? { command: spawned.command, args: [...spawned.args], tier, limits }
                      : null,
                  }),
                },
              ]);
              // ---- the plan, before anything runs at any point --------------
              // The log could not otherwise say what was *supposed* to happen: a point
              // with nothing configured looked exactly like a point that did not exist,
              // and `ProjectConfigured` carries a hash rather than the configuration.
              //
              // This is what ADR 0016 §4 rests on. It buys the board its `skipped`
              // slots, and it makes "configured but did not run" — the half of the
              // responsibility that is ours — detectable by comparing this to the
              // verdicts that follow.
              yield* appendAtEnd(runId, [
                {
                  type: "GatesResolved",
                  actor: "conductor",
                  data: parsePayload("GatesResolved", {
                    runId,
                    configHash: resolved.configHash,
                    points: GATE_POINTS.map((gate) => ({
                      gate,
                      actions: recipe.gates[gate].map((a) => a.name),
                    })),
                  }),
                },
              ]);

              yield* Effect.acquireRelease(
                Effect.promise(async () =>
                  server.register(runId, (await store.read(runId)).length, promptVersion),
                ),
                () => Effect.sync(() => void server.unregister(runId)),
              );

              // The ticket itself, which the implementer was never given. The prompt
              // said "read the issue" and handed over a number: no title, no body, and
              // no `gh` to fetch it with. The first real run spent 30 turns and $1.11
              // discovering that there was nothing to work from, and wrote to
              // `.lingtai/config.yaml` — the only file in the worktree that looked
              // like an instruction.
              //
              // Fetched once here and shared with the review gate below, so a run costs
              // one call for it rather than two.
              const ticket = yield* Effect.promise(() => options.client.getIssue(options.issue));

              const abort = yield* Effect.acquireRelease(
                Effect.sync(() => new AbortController()),
                (controller) => Effect.sync(() => controller.abort()),
              );

              const outcome = yield* Effect.tryPromise({
                try: () =>
                  options.runtime.run({
                    runId,
                    cwd: worktree.path,
                    // The failure block is empty for a first attempt and for
                    // nothing else. It is the whole difference between a second
                    // attempt and the first one again: an agent that is not
                    // told what went wrong is the same agent, at the same
                    // price, arriving at the same place.
                    prompt: renderPrompt(options.prompt, ticket, failure),
                    settingsPath: wiring.settingsPath,
                    // Opened here, written to by the hook trace above, and
                    // handed across the seam because `#109` puts the agent's
                    // own stream in the same file and the adapter is the only
                    // thing that holds it (0034 §1, §3). The writer rather than
                    // the path: one handle, so the cap is one number and the
                    // two accounts interleave a line at a time rather than
                    // inside one.
                    log: runLog,
                    env: agentEnv,
                    limits,
                    signal: abort.signal,
                  }),
                catch: (err) =>
                  new Stopped({
                    stage: "run",
                    detail: (err as Error).message,
                    release: `run failed: ${(err as Error).message}`,
                  }),
              });

              // Flush what the hook counted in memory before anything else reads it.
              yield* Effect.promise(() => server.flush(runId).catch(() => {}));
              return { outcome, ticket, version: server.get(runId)?.version ?? 1 };
            }),
          );

          const { outcome, ticket, version } = ran;

          if (outcome.failure) {
            runLog.note("run", `failed — ${outcome.failure.kind}: ${outcome.failure.detail}`);
            // Never silence. Every ending has a kind.
            yield* Effect.promise(() =>
              store.append(runId, version, [
                {
                  type: "RunFailed",
                  actor: "conductor",
                  data: parsePayload("RunFailed", outcome.failure),
                },
              ]),
            );
            if (outcome.failure.kind === "never-started") {
              yield* standDownConductor(outcome.failure.detail);
            }
            return yield* new Stopped({
              stage: "run",
              detail: outcome.failure.detail,
              /**
               * The card's own line, and it says what happened rather than only
               * what class it was.
               *
               * `WorkItemReleased.reason` *is* the card's sentence — the release
               * follows the `RunFailed` and overwrites the note the projection
               * wrote from it — so `run failed: ${kind}` was where the reason
               * stopped. `history.ts` renders the same event as
               * `${kind}: ${detail}`, which is how `You've hit your session
               * limit · resets 11pm (America/Chicago)` came to be in the history
               * and nowhere a person scanning the board would find it (0031 §6,
               * `#100`). One interpolation, and the whole of an incident was
               * unreadable from the board.
               *
               * **What it cost is part of what happened.** A run that never
               * started took no turns and spent nothing (0031 §1); a crash
               * halfway through spent an agent. Neither appends `RunFinished`,
               * so neither card carries a cost pill — the sentence is the only
               * place the difference can be said, and a card that cost nothing
               * must not read like one that bought an hour of agent.
               *
               * Clipped where `repairOf`'s question above is clipped, and for
               * its reason: a crash's detail is the runtime's output verbatim,
               * and the whole of it is on the log a click away.
               */
              release:
                outcome.failure.kind === "never-started"
                  ? `the run never started — nothing was spent: ${said(outcome.failure.detail)}`
                  : `run failed — ${outcome.failure.kind}: ${said(outcome.failure.detail)}`,
            });
          }

          yield* Effect.promise(() =>
            store.append(runId, version, [
              {
                type: "RunFinished",
                actor: "conductor",
                data: parsePayload("RunFinished", {
                  exitCode: outcome.exitCode ?? 0,
                  turns: outcome.turns,
                  durationMs: outcome.durationMs,
                  costUsd: outcome.costUsd,
                }),
              },
            ]),
          );
          log(`run finished: ${outcome.turns} turns, ${outcome.costUsd ?? "unknown"} usd`);
          runLog.note(
            "run",
            `finished: ${outcome.turns} turns, ${outcome.costUsd ?? "unknown"} usd`,
          );

          // ---- 9. the diff the `proposed` gates will be about ----------------
          /**
           * What is committed, counted — asked again after a fix.
           *
           * A function because the head moves inside this run now: a refused
           * review buys an agent that commits
           * ([0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)),
           * and the `RunProducedDiff` for the head the gates are judging has to
           * be the head they are judging. Two copies of three `reduce`s would be
           * two places for the numbers on a card to stop describing the diff.
           */
          const numstat = Effect.gen(function* () {
            const stat = yield* gitInWorktree([
              "diff",
              "--numstat",
              `${worktree.baseSha}..HEAD`,
            ]).pipe(failing("diff"));
            const rows = stat.split("\n").filter(Boolean).map((l) => l.split("\t"));
            return {
              files: rows.length,
              insertions: rows.reduce((n, r) => n + (Number(r[0]) || 0), 0),
              deletions: rows.reduce((n, r) => n + (Number(r[1]) || 0), 0),
            };
          });

          const headSha = yield* gitInWorktree(["rev-parse", "HEAD"]).pipe(failing("diff"));
          const { files, insertions, deletions } = yield* numstat;

          if (headSha === worktree.baseSha) {
            return yield* new Stopped({
              stage: "diff",
              detail: "no commits",
              release: "the agent produced no commits",
            });
          }

          yield* appendAtEnd(runId, [
            {
              type: "RunProducedDiff",
              actor: "conductor",
              data: parsePayload("RunProducedDiff", {
                branch,
                headSha,
                files,
                insertions,
                deletions,
              }),
            },
            {
              // The moment the gate pipeline fires.
              type: "RunProposedCompletion",
              actor: "conductor",
              data: parsePayload("RunProposedCompletion", { headSha }),
            },
          ]);
          void proposedSha;

          // ---- 10. the gates ---------------------------------------------------
          // The reviewer sees the ticket and the diff, and gets the diff from here
          // because the gates package does not know about git and should not learn.
          //
          // `runPromise` here and nowhere else below the host: 0023 keeps
          // `actions` a package of plain functions, so the callbacks it is handed
          // are promises. This is the direction of the call reversing, not the
          // boundary moving. `orDie` because a git failure inside a gate callback
          // is the defect channel's business, and the handler at the bottom of
          // this function is where that is answered.
          const gitForGates = (args: string[]) => Effect.runPromise(Effect.orDie(gitInWorktree(args)));
          const gateDeps = {
            // Every `run:` action at these points gets what it declared and
            // nothing else. See `envForExtension`.
            env: envForExtension,
            agent: {
              runtime: options.runtime,
              issue: async () => ({
                ref: String(ticket.number),
                title: ticket.title,
                body: ticket.body,
              }),
              diff: () => gitForGates(["diff", `${worktree.baseSha}...HEAD`]),
              // **Not `wiring.settingsPath`.** That file registers the hook, and
              // the two variables the hook needs live in `wiring.env`, which a
              // `GateContext` does not carry — so the reviewer used to be handed
              // a hook it could not reach and was refused before it read a line.
              settingsPath: reviewSettingsPath,
              limits: {
                turns: recipe.runtime.limits.turns,
                wallMs: parseDuration(recipe.runtime.limits.wall),
                diffBytes: recipe.runtime.budget.diff,
              },
            },
            watch: {
              changedFiles: async () => {
                const names = await gitForGates([
                  "diff",
                  "--name-only",
                  `${worktree.baseSha}...HEAD`,
                ]);
                return names.split("\n").filter(Boolean);
              },
            },
          };

          // The `proposed` point: the agent stopped and there are commits, so a
          // change has been proposed and the gates are about to judge it.
          //
          // A function of the head and the findings, because it runs more than
          // once: a refused review buys an agent and the point runs again on what
          // that agent committed (0038 §1). The same actions, in the same order,
          // with one thing added — the scenarios the last refusal was made of,
          // which the reviewer is asked about by name (0038 §2).
          const gates = gatesFromRecipe(recipe.gates.proposed, gateDeps);
          const judge = (onSha: string, recheck: readonly GateFinding[]) =>
            Effect.promise(() =>
              runGatePipeline({
                point: "proposed",
                gates,
                context: {
                  runId,
                  onSha,
                  cwd: worktree.path,
                  env: runnableEnv(env.values),
                  recheck,
                },
                emit: async (event) => {
                  const at = (await store.read(runId)).length;
                  await store.append(runId, at, [
                    { type: event.type, actor: "conductor", data: event.data },
                  ]);
                },
              }),
            );

          let head = headSha;
          let pipeline = yield* judge(head, []);
          log(`gates: ${pipeline.results.map((r) => `${r.gate}=${r.verdict}`).join(" ")}`);

          // ---- 10a. a refusal buys an agent, and the review runs again ---------
          /**
           * The loop [0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)
           * §1 draws, and the rule it replaces was one line long: a gate refused,
           * the item blocked, a person decided. Nothing sat between *refused* and
           * *your problem*, so on 2026-09-10 the three items waiting on a person
           * were the three whose fixes were least in doubt.
           *
           * **Here and not in the merge lane**, which is the difference between
           * this and a repair: the worktree is still up, the head is still the
           * thing under discussion, and the gates can simply run again. Nothing
           * is released, nothing is claimed, and a fix never becomes a second
           * attempt at the ticket.
           *
           * Whether it happens at all is `decideFix`'s and not this file's, for
           * `decideRepair`'s reason — a rule about spending money inside an `if`
           * here is a rule nobody can check. What is here is the order.
           */
          let rounds = 0;
          let disagreement: {
            action: string;
            findings: readonly GateFinding[];
            rounds: number;
            why: string;
          } | null = null;

          // One controller for every round: a fixer left running when this scope
          // closes would hold the worktree the same way an implementer did before
          // it was released by anything.
          const fixAbort = yield* Effect.acquireRelease(
            Effect.sync(() => new AbortController()),
            (controller) => Effect.sync(() => controller.abort()),
          );

          while (!pipeline.ok && pipeline.failedAt !== null) {
            // The refusal, by verdict rather than by position: the pipeline stops
            // at the first one, so it is also the last result — and asking for
            // the verdict says what is meant. It carries the findings, which is
            // why `PipelineResult.results` does.
            const refused = pipeline.results.filter((r) => r.verdict === "failed").at(-1)!;
            const decision = decideFix({
              refusal: { action: refused.gate, findings: refused.findings },
              policy: recipe.repair,
              roundsSpent: rounds,
            });

            if (!decision.fix) {
              log(`no fix for ${refused.gate}: ${decision.why}`);
              runLog.note("fix", `none: ${decision.why}`);
              // **Only a refusal with findings was ever this purse's to spend.**
              // A red build carries none: it is the merge lane's business and
              // `repair.maxAttempts`'s, so calling it a disagreement would hand a
              // person "two agents disagreed" about a typecheck error, and
              // recording a decline for it would put a certainty on the log once
              // per broken build.
              //
              // A refusal that *did* carry findings gets both, for
              // `RepairDeclined`'s reason: "nothing happened because nobody asked
              // for it" and "nothing happened and we do not know why" are the two
              // things a log exists to keep apart.
              if (refused.findings.length > 0) {
                disagreement = {
                  action: refused.gate,
                  findings: refused.findings,
                  rounds,
                  why: decision.why,
                };
                yield* appendAtEnd(runId, [
                  {
                    type: "FixDeclined",
                    actor: "conductor",
                    data: parsePayload("FixDeclined", {
                      runId,
                      round: rounds,
                      action: refused.gate,
                      why: decision.why,
                      findings: refused.findings,
                    }),
                  },
                ]);
              }
              break;
            }

            // Appended **before** the agent runs, as `RepairRequested` is
            // appended before the release: the scenarios it was handed are the
            // acceptance contract, and a log that learned them afterwards could
            // only ever show the ones that survived.
            yield* appendAtEnd(runId, [
              {
                type: "FixRequested",
                actor: "conductor",
                data: parsePayload("FixRequested", {
                  runId,
                  round: decision.round,
                  action: refused.gate,
                  onSha: head,
                  findings: refused.findings,
                }),
              },
            ]);
            log(`bought a fix for ${refused.gate} — round ${decision.round}`);
            runLog.note("fix", `round ${decision.round} for ${refused.gate}`);

            // Its own settings with no hook in them, exactly as the reviewer's:
            // the hook carries the lifecycle of a *run*, and a fixer is a step
            // inside one. And its own id — `sessionIdFor` is a function of the
            // run id, so handing it this run's would resume the implementer's
            // session and give it back the reasoning 0038 §3 takes away.
            const fixSettings = yield* writeUnhookedSettingsEffect(
              runId,
              `fix-${decision.round}`,
              home,
            ).pipe(failing("hook"));

            // The same diff the reviewer was shown, from the same function and
            // under the same ceiling: two agents arguing about a change have to
            // be looking at the same change.
            const underReview = yield* Effect.promise(() => gateDeps.agent.diff());

            const fixed = yield* Effect.promise(() =>
              options.runtime
                .run({
                  runId: `${runId}:fix:${decision.round}`,
                  cwd: worktree.path,
                  prompt: fixBrief({
                    findings: refused.findings,
                    round: decision.round,
                    of: recipe.repair.fix,
                    action: refused.gate,
                    diff: underReview,
                    diffBytes: recipe.runtime.budget.diff,
                  }),
                  settingsPath: fixSettings,
                  env: runnableEnv(env.values),
                  limits: {
                    turns: recipe.runtime.limits.turns,
                    wallMs: parseDuration(recipe.runtime.limits.wall),
                  },
                  signal: fixAbort.signal,
                })
                // A fixer that threw is a fixer that produced nothing, and this
                // run still has somewhere to go: the refusal stands and a person
                // is shown it. Failing the whole run here would throw away the
                // diff, the verdicts and the findings.
                .catch((err) => ({
                  exitCode: null,
                  turns: 0,
                  durationMs: 0,
                  costUsd: null,
                  failure: { kind: "crash" as const, detail: (err as Error).message },
                  text: null,
                  sessionId: "",
                })),
            );

            const after = yield* gitInWorktree(["rev-parse", "HEAD"]).pipe(failing("diff"));
            const committed = after !== head;
            rounds = decision.round;

            yield* appendAtEnd(runId, [
              {
                type: "FixApplied",
                actor: "conductor",
                data: parsePayload("FixApplied", {
                  runId,
                  round: decision.round,
                  headSha: committed ? after : null,
                  turns: fixed.turns,
                  costUsd: fixed.costUsd,
                  failure: fixed.failure ? `${fixed.failure.kind}: ${fixed.failure.detail}` : null,
                }),
              },
            ]);
            runLog.note(
              "fix",
              `round ${decision.round}: ${committed ? after.slice(0, 7) : "no commit"}` +
                ` · ${fixed.turns} turns, ${fixed.costUsd ?? "unknown"} usd` +
                (fixed.failure ? ` · ${fixed.failure.kind}` : ""),
            );

            if (!committed) {
              // Nothing to re-review: the reviewer would be asked the same
              // question about the same commit and would answer it the same way,
              // and paying for that is the one thing a second opinion must not
              // be. The findings stand, and they stand as a disagreement.
              //
              // **A decline and a crash arrive here as the same branch and are
              // not the same event** (0039 §5). Committing nothing is the
              // fixer's one way to object, and `fixBrief` now tells it so; a
              // fixer that threw produced nothing and meant nothing by it. One
              // sentence for both would tell a person "the fixing agent
              // committed nothing" about a process that was killed.
              //
              // And a decline with no reason attached is barely a decline, so
              // the agent's last message travels with it. It is the whole of
              // the objection the prompt promises will reach somebody — clipped
              // here, because this sentence is read on a card.
              disagreement = {
                action: refused.gate,
                findings: refused.findings,
                rounds,
                why: fixed.failure
                  ? `the fixing agent did not finish (${fixed.failure.kind}: ${fixed.failure.detail}), ` +
                    "so there is nothing new for the review to read"
                  : declineWhy(fixed.text),
              };
              break;
            }

            head = after;
            const moved = yield* numstat;
            // The card's numbers describe the diff that is now under review, not
            // the one that was refused two events ago.
            yield* appendAtEnd(runId, [
              {
                type: "RunProducedDiff",
                actor: "conductor",
                data: parsePayload("RunProducedDiff", { branch, headSha: head, ...moved }),
              },
            ]);

            // And the question asked again, with the scenarios the fixer was
            // handed. `recheck` is what makes it a re-review rather than a second
            // review: the reviewer is asked whether those sequences still produce
            // those outcomes, which is the one question a deleted line cannot
            // answer for itself.
            pipeline = yield* judge(head, refused.findings);
            log(
              `gates after fix ${rounds}: ` +
                pipeline.results.map((r) => `${r.gate}=${r.verdict}`).join(" "),
            );
          }

          // The agent's branch has to exist on the remote for the integrator to
          // merge it; it works in a worktree, not on origin.
          //
          // **The lease is spelled out, and it has to be.** Bare
          // `--force-with-lease` reads a remote-tracking ref, and Lingtai's
          // mirror is bare with a `+refs/heads/*:refs/heads/*` refspec — there
          // are no `refs/remotes/origin/*` for it to read, so git refuses with
          // `stale info` the moment `agent/<n>` already exists on origin. That
          // never showed while every run was an issue's first attempt; a repair
          // is a second run on the same branch, so it is now the ordinary case.
          // The value is what origin had when this worktree was cut, which is
          // the lease anyone would want: refuse if somebody else pushed since.
          yield* gitInWorktree([
            "push",
            `--force-with-lease=refs/heads/${branch}:${worktree.remoteHead ?? ""}`,
            "origin",
            `HEAD:refs/heads/${branch}`,
          ]).pipe(failing("push"));

          // ---- 11. the `merge` point -------------------------------------------
          // A pipeline like the two before it, at the point that decides whether
          // this branch reaches the base branch at all.
          //
          // It was resolved into `GatesResolved`, printed by `lingtai add` and drawn
          // on the board from the day a recipe could name it, and never built into a
          // pipeline — so Lingtai's own `human:` action here watched two of its own
          // changes merge with nobody's approval (#58). A control the log claims and
          // the code does not have is worse than an unimplemented one, because every
          // signal an operator has says it is there.
          //
          // In the worktree and before it is removed, since an action here runs
          // commands like any other; after the push, so the branch it is judging
          // exists on the remote.
          //
          // Only when `proposed` passed. A pipeline stops at the first refusal and
          // so do the points: a change whose gates refused is not about to merge,
          // and asking a person to approve one — or paying a reviewer to read it —
          // is a question about a diff that is going nowhere. The refusal already
          // on the log is the answer.
          let atMerge: PipelineResult = {
            ok: true,
            failedAt: null,
            heldAt: null,
            results: [],
            skipped: [],
          };
          if (pipeline.ok) {
            atMerge = yield* Effect.promise(() =>
              runGatePipeline({
                point: "merge",
                gates: gatesFromRecipe(recipe.gates.merge, gateDeps),
                context: {
                  runId,
                  onSha: head,
                  cwd: worktree.path,
                  env: runnableEnv(env.values),
                },
                emit: async (event) => {
                  const at = (await store.read(runId)).length;
                  await store.append(runId, at, [
                    { type: event.type, actor: "conductor", data: event.data },
                  ]);
                },
              }),
            );
            if (atMerge.results.length > 0) {
              log(`merge: ${atMerge.results.map((r) => `${r.gate}=${r.verdict}`).join(" ")}`);
            }
          }

          return { headSha: head, pipeline, atMerge, disagreement };
        }),
      );

      // And the worktree has done its job: the scope above closed and took it
      // down. Everything below runs without one.
      const { headSha, pipeline, atMerge, disagreement } = decided;

      // ---- 12. hold, if anything asked for a person -------------------------
      // Three things can ask: a gate at `proposed` whose verdict is
      // `needs-approval` — a `human` action, or a `watch` one that saw a
      // migration — a gate at `merge`, and the operator, with `--no-merge`.
      //
      // **One path, deliberately.** #38 shipped `--no-merge` emitting
      // `ApprovalRequested` precisely so that when the human gate arrived they
      // would not become two vocabularies for one idea. A gate has already
      // emitted its own request through the pipeline; the flag emits one here.
      // Everything after this point is identical whichever asked.
      //
      // The flag asks even when a gate refused. "The build is red, merge
      // anyway" is a decision a person is allowed to make — that is what a
      // waiver is for — and pre-empting it would make the flag mean something
      // different on a red run than on a green one.
      //
      // **And a repair always asks.** This is the requirement the two stuck
      // items prove is missing: fixing the branch is not enough, because the
      // run whose approval was consumed is still `gating` and nothing re-offers
      // the decision. A repair that leaves an item unapprovable has not
      // repaired it — so it ends by requesting approval on the *new* head,
      // whatever the recipe says at `merge` and whatever the flag says. Merging
      // a repair unattended would also be the one thing 0025 refuses: the
      // person is meant to approve the diff the repair produced.
      //
      // **And a disagreement asks, rather than going to the merge lane**
      // ([0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)).
      // A reviewer refused, an agent was bought or declined, and the review
      // still refuses: that is a judgement about a diff and not a failure of
      // one. Stopping here rather than below is what keeps the two purses
      // apart — the merge lane would refuse with `gate-failed` and `decideRepair`
      // would spend `repair.maxAttempts` on a finding, which is §4's race in the
      // one direction that costs money. A person can still merge it: the
      // approval below is requested on this head like any other.
      if (
        pipeline.heldAt !== null ||
        atMerge.heldAt !== null ||
        options.merge === false ||
        repairOf !== null ||
        disagreement !== null
      ) {
        // `heldAt` is an *action* name; the point is the pipeline it came from.
        // The operator's `--no-merge` is a hold at the `merge` point that names
        // itself as the action, so a card tells it from a configured one; a
        // repair names itself `repair` for the same reason.
        // **A disagreement names itself, for exactly the reason the two above
        // do, and it is worth saying why the obvious alternative destroys the
        // thing it was trying to point at.**
        //
        // Naming it after the reviewer reads well — *the thing a person is
        // looking at is that action's findings* — and gives this request the
        // same `${gate}:${action}` key as the `GateFailed` that holds them.
        // `task-view.ts:427` folds both through one `setGate`, so the request,
        // which carries no verdict and no findings, overwrites the refusal it
        // exists to report: verdict, evidence and findings replaced by an empty
        // `pending` entry, on every projection and every rebuild.
        //
        // So the pointer travels in the question, which is what a person reads,
        // and the key stays the request's own.
        const gate = pipeline.heldAt !== null || disagreement !== null ? "proposed" : "merge";
        const action =
          pipeline.heldAt ??
          atMerge.heldAt ??
          (disagreement ? "disagreement" : null) ??
          (repairOf ? "repair" : "no-merge");

        if (pipeline.heldAt === null && atMerge.heldAt === null) {
          yield* appendAtEnd(runId, [
            {
              type: "ApprovalRequested",
              actor: "conductor",
              data: parsePayload("ApprovalRequested", {
                gate,
                action,
                runId,
                onSha: headSha,
                // Either point's refusal, since the flag asks on a red run
                // too and the question has to say which colour it is. A
                // repair says what it was repairing, because that is the
                // thing being judged — the diff answers a failure, and
                // "approve this" without naming it is half a question.
                question:
                  (repairOf ? `A repair for ${repairOf.reason}. ` : "") +
                  (disagreement
                    ? `Merge ${branch} into ${base} anyway? Two agents disagreed: ` +
                      `the ${disagreement.action} reviewer still refuses it after ` +
                      `${disagreement.rounds} fix round(s).`
                    : pipeline.ok && atMerge.ok
                      ? `Merge ${branch} into ${base}? Every gate passed.`
                      : `Merge ${branch} into ${base} anyway? The ${pipeline.failedAt ?? atMerge.failedAt} gate refused.`),
                artifacts: [`${branch}@${headSha}`],
              }),
            },
          ]);
        }
        // Blocked rather than released, the same as a refusal — a question for
        // a person belongs in "Waiting on you", not back in the queue where
        // another run could claim it and throw the question away.
        const question = disagreement
          ? disagreementQuestion({ ...disagreement, branch, base })
          : repairOf
            ? `a repair for ${repairOf.reason} is waiting on you: ${branch} into ${base}`
            : `held at the ${gate} gate: ${branch} into ${base}`;
        /**
         * The hold, as something a person can act on rather than only read.
         *
         * This is the block #83 calls the good one: a `human:` gate asking for a
         * decision that is genuinely a person's, so it `needs: "judgement"`.
         * What it lacked was the other half — *and here is what I would do.*
         *
         * **Approve is recommended exactly when every gate passed.** There is a
         * commit behind it (`ApprovalRequested.onSha`, requested just above), so
         * the recommendation is one the existing vocabulary can carry out; a red
         * run gets no recommendation, because approving over a refusal is the
         * one judgement nothing but a person should make.
         */
        const green = pipeline.ok && atMerge.ok;
        const failedAt = pipeline.failedAt ?? atMerge.failedAt;
        /**
         * **A disagreement is diagnosed as one, and not as a gate refusing.**
         * 0038's consequence: what reaches a person is no longer a finding, it is
         * *two agents looked at this and did not agree*. The sentence is
         * `fix.ts`'s, with the findings verbatim under it — a card that said "the
         * review gate refused" would be describing the first half of something
         * that has since happened twice.
         */
        const diagnosis = disagreement
          ? diagnoseDisagreement({ ...disagreement, branch, base, headSha })
          : {
              what:
                `${branch} is at ${headSha.slice(0, 7)} and ` +
                (green
                  ? `every gate passed. The ${gate} point holds for ${action}.`
                  : `the ${failedAt} gate refused it. The ${gate} point holds for ${action}.`),
              // What was done about it, when something was: a repair spent an
              // agent and this diff is what it produced. An ordinary hold had no
              // failure to do anything about, and says so by saying nothing.
              done: repairOf
                ? `a repair for ${repairOf.reason} ran as ${runId} and produced this diff`
                : null,
              // No raw output: nothing failed here that a git message describes.
              // The gate verdicts are on the task's own page with their evidence.
              raw: null,
              recommendation: green
                ? {
                    action: "approve" as const,
                    why: repairOf
                      ? `every gate passed on what the repair for ${repairOf.reason} produced`
                      : "every gate passed on this diff; approving merges what this run produced",
                  }
                : null,
            };
        const ended = yield* Effect.promise(async () => {
          const blocked = await store.read(workItemId);
          // In the same append as the outcome it is about. A hold is a terminal
          // outcome for this run, and a `when: blocked` action is as configured
          // as any other.
          const resolvedEnd = resolveEndActions(blocked, recipe.gates.end, "blocked");
          await store.append(workItemId, blocked.length, [
            {
              type: "WorkItemBlocked",
              actor: "conductor",
              data: parsePayload("WorkItemBlocked", {
                question,
                needsFrom: "human",
                runId,
                needs: "judgement",
                diagnosis,
              }),
            },
            ...resolvedEnd,
          ]);
          return resolvedEnd;
        });
        // The item reached a terminal state of its own, so the release below has
        // nothing left to do — and must not undo this by putting the question
        // back in the queue.
        released = true;
        yield* Effect.promise(() =>
          tellGitHubAbout({
            store,
            github: options.client,
            workItemId,
            question,
            labels: labelsFor("waiting"),
            appended: ended,
          }),
        );

        log(`held at ${headSha.slice(0, 7)} — asked for approval to merge into ${base}`);
        return { ok: "held", workItemId, runId, headSha, gate } satisfies RunOnceResult;
      }

      // ---- 13. the merge lane ---------------------------------------------
      // Only one of the two can have refused — `merge` runs only when
      // `proposed` passed — and the integrator records that one.
      const refused = pipeline.failedAt !== null ? pipeline : atMerge;
      const merged = yield* repo.integrate({
        project,
        owner: options.client.owner,
        repo: options.client.repo,
        base,
        branch,
        workItemId,
        headSha,
        gatesPassed: pipeline.ok && atMerge.ok,
        gateDetail: refused.failedAt
          ? `${refused.failedAt}: ${refused.results.find((r) => r.gate === refused.failedAt)?.evidence ?? ""}`
          : undefined,
        token: options.token,
        home,
        gitEnv: options.gitEnv,
        store,
      });

      if (!merged.ok) {
        // ---- the failure's own outcome -------------------------------------
        // A failure of the managed repository's buys one agent, and Lingtai's
        // own never does
        // ([0025](../../../doc/decisions/0025-a-failure-buys-one-agent.md)).
        // The decision is `decideRepair`'s and not this file's: it is a rule
        // about spending money, and a rule about spending money inside an `if`
        // here is a rule nobody can check.
        //
        // The mechanical remedy has already run by the time this line is
        // reached — `integrate()` merges the base in before it merges out — and
        // `IntegrationRefused` is on the log as the record of its exhaustion.
        // That ordering is 0025 §4 and it is why a conflict costs nothing by
        // default.
        const failed = yield* Effect.promise(() => store.read(workItemId));
        const decision = decideRepair({
          failure: { source: "integration", reason: merged.reason, detail: merged.detail },
          policy: recipe.repair,
          item: reduceWorkItem(failed),
          runId,
        });

        if (decision.repair) {
          // Recorded, then released — in that order, because the order *is* the
          // mechanism: the fold carries a pending repair between the two, and
          // the next claim is that repair.
          yield* appendAtEnd(workItemId, [
            {
              type: "RepairRequested",
              actor: "conductor",
              data: parsePayload("RepairRequested", {
                runId,
                reason: merged.reason,
                detail: merged.detail.slice(0, 4_000),
                fingerprint: decision.fingerprint,
                attempt: decision.attempt,
              }),
            },
          ]);
          yield* release(`repairing ${merged.reason} (attempt ${decision.attempt})`);
          log(`bought a repair for ${merged.reason} — attempt ${decision.attempt}`);
          return refusal("integrate", `${merged.reason}: ${merged.detail}`);
        }

        // Blocked rather than released: a refusal is a question for a person,
        // and the board's "Waiting on you" column is where it goes. The decline
        // goes on the log beside it so the card can say *why* no agent was
        // bought — an item whose integration failed must never be left with a
        // control that refuses and no sentence explaining it.
        const question = `${merged.reason}: ${merged.detail.slice(0, 400)} — no repair: ${decision.why}`;
        // The question above is #83's own exhibit — a reason code, 400 characters
        // of git output and a colon — and it is still appended, because it is
        // what the log has always said and shortening it would lose the failure.
        // What is new is beside it: the refusal read as a sentence, what had
        // already been tried, the output verbatim, and the move it implies.
        const diagnosis = diagnoseRefusal({
          reason: merged.reason,
          detail: merged.detail,
          branch,
          base,
          why: decision.why,
        });
        const ended = yield* Effect.promise(async () => {
          const blocked = await store.read(workItemId);
          const resolvedEnd = resolveEndActions(blocked, recipe.gates.end, "blocked");
          await store.append(workItemId, blocked.length, [
            {
              type: "RepairDeclined",
              actor: "conductor",
              data: parsePayload("RepairDeclined", {
                runId,
                reason: merged.reason,
                detail: merged.detail.slice(0, 4_000),
                fingerprint: decision.fingerprint,
                why: decision.why,
              }),
            },
            {
              type: "WorkItemBlocked",
              actor: "conductor",
              data: parsePayload("WorkItemBlocked", {
                question,
                needsFrom: "human",
                runId,
                // A failure, not a decision: nothing is being asked of the
                // operator's judgement — something broke and the log is asking
                // them to acknowledge it and take the move it recommends.
                needs: "acknowledgement",
                diagnosis,
              }),
            },
            ...resolvedEnd,
          ]);
          return resolvedEnd;
        });
        released = true;
        yield* Effect.promise(() =>
          tellGitHubAbout({
            store,
            github: options.client,
            workItemId,
            question,
            labels: labelsFor("waiting"),
            appended: ended,
          }),
        );
        return refusal("integrate", `${merged.reason}: ${merged.detail}`);
      }

      const ended = yield* Effect.promise(async () => {
        const landed = await store.read(workItemId);
        // One transaction with the landing itself. This used to be a second
        // append on this line only, which is how every item that landed by any
        // other route — an approval, on the CLI or the board — never resolved
        // the point at all.
        const resolvedEnd = resolveEndActions(landed, recipe.gates.end, "landed");
        await store.append(workItemId, landed.length, [
          {
            type: "WorkItemLanded",
            actor: "conductor",
            data: parsePayload("WorkItemLanded", { mergeCommit: merged.mergeCommit, base }),
          },
          ...resolvedEnd,
        ]);
        return resolvedEnd;
      });
      released = true;
      yield* Effect.promise(() =>
        tellGitHubAbout({
          store,
          github: options.client,
          workItemId,
          labels: labelsFor("landed"),
          appended: ended,
        }),
      );
      log(`landed ${merged.mergeCommit.slice(0, 7)} on ${base}`);
      // The one sentence in this file that means the run landed, and so the one
      // place the log's keep-or-delete can be decided from (0034 §4, §5). The
      // release above reads it when the scope closes, a few lines from now.
      didLand = true;
      return { ok: true, workItemId, runId, mergeCommit: merged.mergeCommit } satisfies RunOnceResult;
    });

    // `Effect.scoped` here and not around the generator's body: the scope the
    // log is acquired in has to close before the handlers below run, and after
    // the merge lane above them.
    return yield* Effect.scoped(claimed).pipe(
      // Every typed refusal, in one place: it releases with the reason it
      // carries and reports the stage it names. There is no `release(...)` call
      // beside a `return` anywhere above, which is the point.
      Effect.catchTag("Stopped", (stopped) =>
        release(stopped.release).pipe(Effect.as(refusal(stopped.stage, stopped.detail))),
      ),
      // **The defect channel.** What is left of the catch-all, and only that: a
      // failure the type system can see has already been handled one line up,
      // so anything arriving here is a bug — a store that would not append, a
      // gate callback that threw. It still releases and still reports, because
      // "every exit appends" has to be true of the endings nobody predicted.
      Effect.catchAllDefect((defect) => {
        const detail = defect instanceof Error ? defect.message : String(defect);
        return release(`unexpected failure: ${detail}`).pipe(
          Effect.as(refusal("unexpected", detail)),
        );
      }),
      // And the one ending neither of the above sees: an interruption, which is
      // not a failure and not a defect. `release` is idempotent, so on every
      // other path this is a no-op that has already happened.
      Effect.ensuring(release("the run was interrupted")),
    );
  });
}
