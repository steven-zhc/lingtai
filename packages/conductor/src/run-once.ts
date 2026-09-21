/**
 * One work item, discovery through merge, with a person watching.
 *
 * This is the wiring, and almost none of the logic — every piece it calls has
 * its own tests and its own reasons. What is here is the *order*, and the order
 * is the part that has to be right:
 *
 *   resolve the recipe from ~/.lingtai/     never from the repository, and it
 *                                           must name the registered base as its own
 *   resolve the environment                 a declared name with no value
 *                                           refuses here, before the money
 *   discover, claim                         the constraint decides the race
 *   provision the worktree                  filtered env, submodules, 0600
 *   prove the hook fails closed             before anything is dispatched
 *   RunStarted                              the conductor knows more than the hook
 *   run the agent                           on the socket, restricted by nothing
 *   the diff → `proposed`                   each refusal typed and recorded
 *   a refused review → a fix → `proposed`   the findings bought an agent (0038)
 *   the rounds spent → a restart            a fresh pass, if one is bought (0040)
 *   → `merge`                               only when `proposed` passed
 *   → integrate                             a point with actions always runs
 *
 * **Every exit appends.** A run that ends leaves either `RunFinished` or
 * `RunFailed` — both, for a run stopped at its turns, whose receipt is its
 * spend — and a work item that does not land is either released or blocked
 * with a question. The old loop could end in silence in at least seven places;
 * that is the thing being replaced.
 *
 * **A failure of the managed repository's used to have a third exit** — it
 * bought one agent, a whole new run, and the next claim became that repair
 * ([0025](../../../doc/decisions/0025-a-failure-buys-one-agent.md)). There is
 * no such exit any more (`#143`). A refusal the loop below cannot answer is a
 * question for a person, carrying `attribution.ts`'s reading of it: what
 * refused, whose failure it is, and the move that is left. Nothing re-implements
 * a branch that already exists, which is 0039 §Consequences.
 *
 * **A refused *review* buys an agent, and spends it here rather than next
 * time** ([0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)).
 * Still not a sixth point: `proposed` simply runs again, on the head a fixing
 * agent committed, with the refused findings' failure scenarios handed to the
 * fixer verbatim and put back to the reviewer as the question *does that
 * sequence still produce that outcome*. The worktree is up and the diff is the
 * thing under discussion, so nothing is released and nothing is re-claimed; when
 * the rounds are spent and the review still refuses, a person is asked, and what
 * they are shown says **two agents disagreed**. The decisions are `fix.ts`'s.
 *
 * **A spent pass is not always the person's, since**
 * [0040](../../../doc/decisions/0040-rounds-bound-depth-restarts-bound-breadth.md).
 * `rounds` bounds depth and `runtime.limits.restarts` bounds breadth: above
 * zero, a review that outlasted the rounds pushes the approach it is
 * abandoning, appends `PassRestarted` and **releases** the item, and the next
 * claim is an ordinary pass from the base carrying the findings. Section 12 is
 * where that is asked and `restart.ts` is what decides it — only a judgement
 * buys one, so a red build and a conflict still end at section 13's hold. The
 * key defaults to zero, which is every project today, and then the paragraph
 * above is the whole of it and the person is asked on the first spent pass.
 *
 * It used to say so and then keep the promise by hand: two nested `finally`
 * blocks and a `catch (err)` whose own comment admitted what it was. Since
 * [0026](../../../doc/decisions/0026-the-conversion-past-the-seam.md) the
 * promise is structural instead.
 *
 * **Four things a run acquires, and one scope each.** The worktree, the hook
 * socket and the agent process are `Effect.acquireRelease` pairs, so each is
 * released because its scope closed — on the happy path, on a typed refusal, on
 * a defect and on an interruption alike.
 *
 * **The worktree's scope is the pass**
 * ([0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md) §1),
 * which is a change: it used to close before the integrator, and every
 * expensive path in this file followed from that. It was not a preference. The
 * worktree held `agent/<n>` checked out against the mirror the lane fetches
 * into, and git refuses to update a ref some worktree has checked out — so the
 * worktree and the merge could not coexist, and *release it first* was the only
 * available order. `provisionWorktree` cuts a detached checkout now; nothing
 * holds the branch, and the two can. The hook socket and the agent process keep
 * their narrow scopes, which is what an agent may not outlive.
 *
 * The fourth is the run's log file
 * ([0034](../../../doc/decisions/0034-the-run-log.md)), and its scope is wider
 * still, for the reason the narrow ones are narrow: its release decides **keep
 * or delete**, and that turns on whether the run landed. It is acquired before
 * the worktree and released after it, which is what one scope and reverse order
 * of acquisition give without anybody arranging it.
 *
 * **And one ending stops the conductor rather than the item.** A run that never
 * started ([0031](../../../doc/decisions/0031-a-run-that-never-started.md)) met
 * something account-wide, so the item is released like any other failure and
 * `ctl-conductor` is told to take nothing at all until the limit lifts. It is
 * the only place in this file that appends outside the run and the work item,
 * and it is deliberate: per-item backoff answering an account-wide condition is
 * what eighty events in ninety-two seconds looked like.
 *
 * **The agents inside a pass meet the same wall** (`#133`,
 * [0041](../../../doc/decisions/0041-a-gate-that-never-ran.md)). A reviewer or
 * a fixer that never started judged nothing, so it is not a refusal: the gate
 * appends `GateNeverRan`, and the pass pushes, stands the conductor down and
 * releases exactly as a run that never started does — no round, no hold, no
 * lane, and no sentence about the diff.
 *
 * **The refusals come first, deliberately.** Everything up to the claim
 * acquires nothing, so a run that stops at an unreadable recipe or a missing
 * environment value has provisioned no worktree to release — the lesson 0024
 * recorded about where a scope *starts*, kept here as a test rather than as an
 * intention.
 */
import { type ResolvedRecipe, baseDivergence, parseDuration } from "@lingtai/recipe";
import { currentRecipe } from "./projects.ts";
import { type Tier, parsePayload, retiredRepairPending } from "@lingtai/domain";
import {
  type GateFinding,
  type PipelineResult,
  gatesFromRecipe,
  runGatePipeline,
} from "@lingtai/actions";
import type { GitHubClient } from "@lingtai/github";
import {
  NO_RUN_LOG,
  type RunLog,
  type Runtime,
  missingForTier,
  taggedTrace,
  writeUnhookedSettingsEffect,
} from "@lingtai/agent";
import { type EventStore, eventStore } from "@lingtai/event-store";
import { claimWorkItem, releaseWorkItem } from "./claim.ts";
import { diagnoseRefusal } from "./attribution.ts";
import {
  type FixOn,
  type FixStop,
  type RestartArm,
  decideFix,
  declineWhy,
  diagnoseDisagreement,
  diagnoseUnfixed,
  disagreementQuestion,
  fixBrief,
  fixStopOf,
  mergeAnywayBecause,
  stopAction,
  stopNeeds,
  unfixedQuestion,
} from "./fix.ts";
import { armBranch, decideRestart, restartReason } from "./restart.ts";
import { type NeverStarted, standDown } from "./never-started.ts";
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
import { gatesResolved } from "./gates-resolved.ts";
import { labelsFor } from "./labels.ts";
import { tellGitHubAbout } from "./tell.ts";

import type { ProjectState } from "@lingtai/domain";
import { extensionEnv, productionPatterns, runnableEnv } from "@lingtai/agent-env";
import { stateDir } from "@lingtai/env";
import type { TokenSource } from "@lingtai/repo";
import { Data, Effect, Either } from "effect";
import { AgentHost, Repo } from "./ports.ts";
import { spawn } from "node:child_process";
import { RUN_LOG_END, runLogEnd, runLogPath } from "./run-log.ts";

/**
 * What a `watch:` action is shown: every path the diff touches, **both ends of
 * a rename**.
 *
 * `--no-renames` is the whole of it. With rename detection on, which is git's
 * default, `--name-only` prints only where a file went — so moving a watched
 * file somewhere unwatched listed nothing the watch matched, and `tamper`
 * passed the deletion of the test that pins it (#31).
 */
export const changedFilesArgs = (baseSha: string): string[] => [
  "diff",
  "--name-only",
  "--no-renames",
  `${baseSha}...HEAD`,
];

/**
 * Why a resolved recipe will not run on the runtime a conductor dispatches, or
 * null when it will (#180).
 *
 * One sentence for both places that ask: `runOnce`, which refuses before its
 * claim, and `lingtai doctor`'s recipe row, which must not be `ok` for a
 * recipe every pass of which that refusal stops.
 */
export function agentRefusal(
  resolved: Pick<ResolvedRecipe, "recipe" | "provenance">,
  dispatched: string,
): string | null {
  const named = resolved.recipe.runtime.agent;
  if (named === dispatched) return null;
  const from = resolved.provenance?.["runtime.agent"];
  return `runtime.agent is ${named}${from ? ` (${from})` : ""}, and this conductor runs ${dispatched}`;
}

export interface RunOnceOptions {
  project: ProjectState;
  client: GitHubClient;
  /** The recipe this run obeys. `currentRecipe` — the machine's file — unless a test says otherwise. */
  recipe?: () => Promise<ResolvedRecipe>;
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
 * A `detail` is the runtime's output verbatim, a release reason is a sentence
 * somebody reads in a column, and the whole of it is on the log a click away.
 * 300 is what the repair's handover question used to clip to, kept because the
 * column it is read in has not changed.
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

    // ---- 1. the recipe, from this machine -----------------------------------
    // `~/.lingtai/<project>/recipe.yml` (0046 §3, #180), the same read every
    // other command that conducts makes. Its `ref` is the base recorded at
    // `lingtai add`, and the divergence check below still holds the recipe's
    // `repo.base` to it.
    const recipeAt: Either.Either<ResolvedRecipe, string> = yield* Effect.either(
      Effect.tryPromise({
        try: () => (options.recipe ?? (() => currentRecipe(options.project, options.client)))(),
        // An unreadable or non-compliant recipe must stop the run rather than
        // fall back to a default.
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
    // The agent the recipe resolved to is the agent that runs, or nothing runs.
    // `runtime.agent` is named in a file or detected (0046 §3) and printed with
    // where it came from, so a run handed another runtime would be the silent
    // pick that rule refuses — and it would record the runtime it was handed,
    // with nothing anywhere saying the named one was not used. Before the claim,
    // for the same reason as the refusals around it.
    const wrongAgent = agentRefusal(resolved, options.runtime.capabilities.id);
    if (wrongAgent !== null) {
      return {
        ok: false,
        workItemId: null,
        runId: null,
        stage: "recipe",
        detail: `${wrongAgent} — nothing was claimed. Name ${options.runtime.capabilities.id} there to run with it; no other runtime is dispatched yet`,
      };
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
        patterns: productionPatterns(recipe.env.refuseHosts),
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
      runnableEnv(extensionEnv(env.merged, declared, productionPatterns(recipe.env.refuseHosts)).values);

    // The tripwire over every extension's declared values, here and not only
    // when `envForExtension` is first called. `resolveAgentEnv` checks what
    // reaches the agent, after `deny`; a name an extension declares is read
    // from `merged`, so a denied production value would otherwise first throw
    // at `gates.prepared` — past the claim, as a defect in the middle of a run.
    const extensionRefusal = Either.try(() => {
      for (const point of Object.values(recipe.gates)) {
        for (const action of point) {
          if ("run" in action) extensionEnv(env.merged, action.env, productionPatterns(recipe.env.refuseHosts));
        }
      }
      for (const subscriber of recipe.subscribers) {
        extensionEnv(env.merged, subscriber.env, productionPatterns(recipe.env.refuseHosts));
      }
    });
    if (Either.isLeft(extensionRefusal)) {
      const detail = extensionRefusal.left instanceof Error ? extensionRefusal.left.message : String(extensionRefusal.left);
      return { ok: false, workItemId: null, runId: null, stage: "env", detail };
    }

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

    const before = yield* Effect.promise(() => store.read(workItemId));
    const item = reduceWorkItem(before);
    /**
     * A sentence a person added for this attempt, and only this one.
     *
     * Read **before** the claim because the claim is what consumes it (0032
     * §5), so a read taken afterwards would find nothing and the edit would
     * silently never reach the agent — a control the page claims and the code
     * does not have, which is exactly the shape `renderPrompt` refuses for
     * `{{failure}}`.
     *
     * It has a `repairOf` beside it, read here for the same reason: a failure
     * that bought an agent left a pending repair on the item and the next claim
     * *became* it. Nothing buys one since `#143`, so on a new ticket `repairOf`
     * is null and every claim is an ordinary pass.
     */
    const edit = item.pendingPrompt;
    if (edit) log(`carrying a prompt edit from ${edit.by} (${edit.text.length} bytes)`);
    /**
     * A repair the old code bought, released, and never claimed — **only on a
     * log written before `#143`**, which is exactly the item a daemon restarted
     * onto this code finds in its queue.
     *
     * Honoured rather than dropped. It was bought already, so honouring it
     * spends nothing new; dropping it makes this claim an ordinary pass that is
     * told nothing about the failure and merges unattended, where the repair it
     * was released for would have asked a person (0025). So it is briefed
     * (`nextPrompt`) and it holds at `merge` below, as it always did.
     */
    const repairOf = retiredRepairPending(before);
    if (repairOf) {
      log(`repairing ${repairOf.reason} from ${repairOf.after} (attempt ${repairOf.attempt}), bought before #143`);
    }

    /**
     * What the earlier attempts did, for this one's prompt.
     *
     * Read from the same envelopes and for the same reason the edit is: the
     * claim below appends, and this run must not appear in its own history. Empty for a first attempt. A first attempt whose ticket
     * had no question answered before it (#147) and no edit then gets
     * everything downstream — prompt bytes, `promptVersion` — as it was before
     * `#82` (`attempts.ts`); an answered one carries the decision from attempt 1.
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
     * Settled **before the claim**, like `edit`: the claim is what consumes it,
     * so a version computed afterwards would describe a prompt this run is not
     * getting. The ticket is filled in much later, from
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
     * How a run that did not land gives the item back.
     *
     * **One way, and `#143` is what made it one.** The item returns to the
     * queue, and the backoff decides when it is seen again.
     *
     * A repair used to hand over instead — block with a question naming the
     * failure it had been bought for and how far it got — because releasing one
     * would have been worse than doing nothing: the pending repair had been
     * consumed, so the next attempt would have been an ordinary run that knew
     * nothing about the conflict and walked straight back into it. Nothing buys
     * a repair now, so no run arrives here carrying a failure of its
     * predecessor's that a release would throw away. What a refusal this pass
     * could not answer gets instead is the hold at section 13, which asks a
     * person rather than the queue.
     */
    const release = (reason: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (released) return Effect.void;
        released = true;
        return Effect.tryPromise({
          try: async () => {
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
     *
     * **The pause is the same at every depth and the sentence is not.** `what`
     * carries which agent never started, because
     * [0041](../../../doc/decisions/0041-a-gate-that-never-ran.md) §3 reuses
     * this whole mechanism for the agents inside a pass — where *no turns taken,
     * nothing spent* would be false about a pass whose implementer ran and was
     * paid.
     */
    const standDownConductor = (what: NeverStarted, detail: string): Effect.Effect<void> =>
      Effect.promise(async () => {
        const it =
          what.of === "run"
            ? "a run"
            : what.of === "gate"
              ? `the ${what.gate} gate's agent`
              : `the fixing agent for ${what.action}`;
        const events = await store.read(CONTROL_STREAM);
        const control = reduceControl(events);
        if (control.paused) {
          log(`${it} never started; the conductor is already paused — ${control.reason ?? "no reason given"}`);
          return;
        }
        const { until, reason } = standDown({
          detail,
          what,
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
        log(`${it} never started — conductor paused until ${until.toISOString()}`);
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
     * The outermost scope, and it is the log's.
     *
     * It is wider than the socket's and the agent's because what closes it has
     * to know something neither of them does: **whether the run landed**
     * ([0034](../../../doc/decisions/0034-the-run-log.md) §4).
     *
     * It is wider than the worktree's too, and only just: since
     * [0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md)
     * §1 the worktree is acquired **in this scope**, after the log, so the merge
     * lane runs with it still up and the two release in order — worktree, then
     * log — without anybody arranging it. What this paragraph used to say is
     * that the worktree's scope ends before the merge lane and cannot be
     * relaxed. It could, and relaxing it is 0039.
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
       * **The worktree, and it lives as long as the pass**
       * ([0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md) §1).
       *
       * Acquired in the run's own scope rather than in the block below, which is
       * the whole of §1: the block below closes before the merge lane, and this
       * does not. Everything a refusal could be answered by — the branch, the
       * build, the diff — is therefore still on disk when the refusal happens,
       * and *a new run* stops being the answer to anything except a run that
       * ended.
       *
       * **It could not be here until the checkout stopped holding the branch.**
       * The ordering this replaces was not a preference: the worktree held
       * `agent/<n>`, git refuses to update a ref some worktree has checked out,
       * and the merge lane fetches exactly that ref — so keeping it alive
       * through the merge is what broke the first end-to-end run. The comment
       * that recorded this sat 690 lines below the one that cited it, which is
       * why 0039 was written believing nothing recorded it at all.
       * `provisionWorktree` cuts a detached checkout now, and
       * `worktree.test.ts` pins the fetch rather than the checkout.
       *
       * Released after the lane, before the run log — one scope, reverse order
       * of acquisition, and the log's release still decides keep-or-delete from
       * a `didLand` that is by then known.
       */
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

      /**
       * **The ticket, fetched once, before anything that reads it.**
       *
       * The implementer's prompt and the review gate both want it, and it used
       * to be fetched inside the agent's own block and handed back out — which
       * worked while the gates only ran after the agent. They run after the
       * merge lane too now (`#142`), so it is fetched where everything that
       * needs it can see it, and a run still costs one call for it.
       */
      const ticket = yield* Effect.promise(() => options.client.getIssue(options.issue));

      // The cold reviewer's own settings, with no hook in them. `wiring`'s
      // settings and `wiring.env` are one thing and the `agent` gate had
      // only the first, so the hook refused the reviewer's opening prompt
      // and every review returned that refusal instead of findings. See
      // `writeUnhookedSettings` for why the answer is no hook rather than a
      // second socket.
      const reviewSettingsPath = yield* writeUnhookedSettingsEffect(runId, "review", home).pipe(
        failing("hook"),
      );

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
            const names = await gitForGates(changedFilesArgs(worktree.baseSha));
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
      const judge = (onSha: string, recheck: readonly GateFinding[], round: number) =>
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
              round,
              // The run's own log, so a review is not eighteen dark minutes
              // (#153). The pipeline tags it per action.
              log: runLog,
            },
            emit: async (event) => {
              const at = (await store.read(runId)).length;
              await store.append(runId, at, [
                { type: event.type, actor: "conductor", data: event.data },
              ]);
            },
          }),
        );

      /**
       * **Hoisted out of the block below, and `#142` is why** (0039 §2).
       *
       * Everything above is a function of the worktree, the recipe and the
       * ticket — none of it of the agent — and it used to sit after the agent
       * ran because that was the only place it was called from. A conflict is
       * answered in the worktree now, and what answers it has to run the point
       * again on what the agent committed, from outside the block that ends
       * when the agent does.
       */
      /**
       * Everything that runs while an agent might be, and nothing that does not.
       *
       * What this scope still owns is the fix loop's abort controller: a fixer
       * left running when it closes would hold the worktree the way an
       * implementer did before anything released it. The worktree itself moved
       * out — see above.
       */
      yield* Effect.scoped(
        Effect.gen(function* () {

          // ---- 6. the hook, proven to fail closed before anything is dispatched
          // It refuses nothing (ADR 0016 §6) and carries everything: the prompt, the
          // files touched, compaction, and the Stop that fires the gates. Proving it
          // fails closed is therefore about the *record*, not about mediation — a
          // hook that cannot reach the conductor must stop the run rather than let it
          // produce nothing and look like it produced everything.
          const wiring = yield* host
            .wire({ runId, hookBinary: options.hookBinary, home })
            .pipe(failing("hook"));

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
                log: runLog,
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
                  data: parsePayload("GatesResolved", gatesResolved(runId, resolved)),
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
              return { outcome, version: server.get(runId)?.version ?? 1 };
            }),
          );

          const { outcome, version } = ran;

          if (outcome.failure) {
            runLog.note("run", `failed — ${outcome.failure.kind}: ${outcome.failure.detail}`);
            // Never silence. Every ending has a kind.
            //
            // `out-of-turns` is the one failure that arrives with a receipt:
            // the binary ended the session at `--max-turns` and printed its
            // turns and cost (`#89`). Those go on the log as `RunFinished`
            // first, because that is the only event the card, the task page
            // and the board's totals read spend off — without it the runs that
            // overspent would be counted as free. `RunFailed` follows, so the
            // run still ends as failed with its kind.
            const receipt =
              outcome.failure.kind === "out-of-turns"
                ? [
                    {
                      type: "RunFinished" as const,
                      actor: "conductor" as const,
                      data: parsePayload("RunFinished", {
                        exitCode: outcome.exitCode ?? 1,
                        turns: outcome.turns,
                        durationMs: outcome.durationMs,
                        costUsd: outcome.costUsd,
                      }),
                    },
                  ]
                : [];
            yield* Effect.promise(() =>
              store.append(runId, version, [
                ...receipt,
                {
                  type: "RunFailed",
                  actor: "conductor",
                  data: parsePayload("RunFailed", outcome.failure),
                },
              ]),
            );
            if (outcome.failure.kind === "never-started") {
              yield* standDownConductor({ of: "run" }, outcome.failure.detail);
            }
            /**
             * **Held, not released.** A release is a backoff and another claim
             * with the whole turn budget, and nothing counts these endings, so
             * the ticket would buy a run to the limit every backoff until
             * somebody noticed. The recipe's reading of the limit is *"the
             * ticket was scoped wrong"* — which no retry of the same ticket
             * answers — so it goes to a person, as a lane refusal does.
             * `released` is set so the `Stopped` below reports the stage and
             * does not undo the block by putting the item back in the queue.
             */
            if (outcome.failure.kind === "out-of-turns") {
              const { detail } = outcome.failure;
              const question = `out-of-turns: ${said(detail)}`;
              const ended = yield* Effect.promise(async () => {
                const blocked = await store.read(workItemId);
                const resolvedEnd = resolveEndActions(blocked, recipe.gates.end, "blocked");
                await store.append(workItemId, blocked.length, [
                  {
                    type: "WorkItemBlocked",
                    actor: "conductor",
                    data: parsePayload("WorkItemBlocked", {
                      question,
                      needsFrom: "human",
                      runId,
                      needs: "acknowledgement",
                      diagnosis: {
                        what:
                          `the run reached the recipe's turn limit (${recipe.runtime.limits.turns}) and was stopped: ` +
                          `${said(detail)}. The limit is a scope alarm — the ticket asks ` +
                          `for more than one run should do.`,
                        done: null,
                        raw: detail,
                        recommendation: {
                          action: "requeue",
                          why:
                            "narrow or split the ticket first; requeued as written, it buys another run " +
                            "to the same limit",
                        },
                      },
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
               * place the difference can be said (`out-of-turns` alone appends
               * its receipt, above), and a card that cost nothing
               * must not read like one that bought an hour of agent.
               *
               * Clipped by `said`, and for its reason: a crash's detail is
               * the runtime's output verbatim, and the whole of it is on the
               * log a click away.
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

          // A use, for a variable this block assigns from a hook callback and
          // nothing reads. It sat below the gates until they moved out from
          // under it (`#142`), which is where it turned into a dangling name.
          void proposedSha;
        }),
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

      const firstHead = yield* gitInWorktree(["rev-parse", "HEAD"]).pipe(failing("diff"));
      const { files, insertions, deletions } = yield* numstat;

      if (firstHead === worktree.baseSha) {
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
            headSha: firstHead,
            files,
            insertions,
            deletions,
          }),
        },
        {
          // The moment the gate pipeline fires.
          type: "RunProposedCompletion",
          actor: "conductor",
          data: parsePayload("RunProposedCompletion", { headSha: firstHead }),
        },
      ]);

      // ---- 10. one pass, and it is a loop -----------------------------------
      /**
       * **The shape [0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md)
       * draws, written as what it is.**
       *
       * A pass was three pieces of one loop: a `while` around the `proposed`
       * point for a refused review, the merge lane a hundred lines below it, and
       * the code that asks a person in between. Each had its own idea of what a
       * refusal costs, and only the first could send anything back to the agent
       * — which is why a red build and a conflict each bought a **whole new
       * run**, re-implementing a branch that was sitting on disk.
       *
       * It is one loop now, and every refusal is an iteration of it:
       *
       *     the point refuses    → the agent, with the findings
       *     the build goes red   → the agent, with the output
       *     the lane conflicts   → the agent, with the conflict in its tree
       *     rounds spent         → a person
       *     it merges            → it landed
       *
       * **One ceiling, so one counter.** `rounds` is spent by whichever refusal
       * happened, and that is only honest because they all end in the same
       * place: 0038 §4 kept two purses precisely because the two failures went
       * to two destinations, and a shared ceiling was then a race.
       *
       * The worktree outlives every iteration (0039 §1, `#140`), which is the
       * whole reason this can be a loop at all. Before it, the third case had
       * nowhere to go back to.
       */
      let head = firstHead;
      let rounds = 0;
      /**
       * How many diffs each action has refused in this pass.
       *
       * **`rounds` cannot answer this, and a card that asked it of `rounds`
       * overstated the evidence** (`#197`). One ceiling means one counter, and
       * the paragraph above is why that is honest about *money* — but it makes
       * `rounds` useless as a count of what any one action said. `build`
       * refuses A, a round fixes it, `review` refuses B, that round's fixer is
       * killed: `rounds` is 2 and each of the two points has refused exactly
       * once. The card read 2 and told a person `build` "ran 2 times in all, on
       * 2 different diffs, and refused every one" — two red results where there
       * is one, in the direction that makes somebody readier to merge over it.
       *
       * So the count the sentences need is kept per action, incremented where a
       * refusal is actually taken in hand — one per pipeline refusal and one
       * per conflict the lane could not apply. A conflict the base moved out
       * from under is not counted, because no agent was bought and the lane is
       * simply re-entered.
       */
      const refusals = new Map<string, number>();
      const refusedAgain = (action: string): number => {
        const soFar = (refusals.get(action) ?? 0) + 1;
        refusals.set(action, soFar);
        return soFar;
      };
      /**
       * What origin last had for this branch, as far as this pass knows.
       *
       * Starts as what it had when the worktree was cut and moves to whatever
       * this pass pushed. See the push below: a lease that does not move is a
       * lease this pass breaks itself on its second round.
       */
      let lease: string | null = worktree.remoteHead;
      /** The findings the next `proposed` run is asked about again (0038 §2). */
      let recheck: readonly GateFinding[] = [];
      let pipeline: PipelineResult = { ok: true, failedAt: null, heldAt: null, neverRanAt: null, results: [], skipped: [] };
      let atMerge: PipelineResult = { ok: true, failedAt: null, heldAt: null, neverRanAt: null, results: [], skipped: [] };
      let merged: Effect.Effect.Success<ReturnType<typeof repo.integrate>> | null = null;

      /**
       * The point still refuses and there are no rounds left to buy.
       *
       * **Whatever refused, this is where it stops.** The approval below reads
       * it and asks a person. `on` is carried because the three read nothing
       * alike: *two agents disagreed* is the right sentence for a judgement and
       * the wrong one for a typecheck error or a moved base.
       */
      let unresolved: {
        action: string;
        on: FixOn;
        findings: readonly GateFinding[];
        evidence: string;
        rounds: number;
        /**
         * How many diffs **this action** refused, off the tally above (`#197`).
         *
         * Beside `rounds` rather than instead of it: they answer two questions
         * and a card asks both. *How much was bought* is the budget and belongs
         * to the pass; *how often did this point say no* is this action's, and
         * reading the first for the second is what made a card claim two red
         * results where there was one.
         */
        refusals: number;
        why: string;
        /**
         * Which of the five endings this is, for the headline a person reads
         * first (`#197`).
         *
         * Beside `why` rather than instead of it, and beside `exhausted` rather
         * than derived from it: `why` is the sentence under the headline and
         * `exhausted` is the two-way question `decideRestart` asks about money.
         * Neither can say *a rate limit killed the fixer* — which is what a
         * person has to be told before they are asked to adjudicate anything.
         */
        stop: FixStop;
        /**
         * Whether the **ceiling** is what stopped the rounds, as opposed to an
         * agent declining or a refusal carrying no criterion.
         *
         * Carried rather than re-derived because it is what `decideRestart`
         * turns on (0040), and the alternative was reading `why` — a sentence
         * written for a card. A decline is somebody's objection and a restart
         * would bury it; the ceiling being spent is the only one of the three
         * endings a second approach answers.
         */
        exhausted: boolean;
      } | null = null;

      // One controller for every round: a fixer left running when this run ends
      // would hold the worktree the way an implementer did before it was
      // released by anything.
      const fixAbort = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      );

      /**
       * An agent inside this pass never started, and this pass ends without a
       * word about the diff
       * ([0041](../../../doc/decisions/0041-a-gate-that-never-ran.md), `#133`).
       *
       * 0031 §3 one layer down. The implementer ran and was paid, so nothing
       * about the *run* is `never-started` and the dispatch path above never
       * sees this — but the reviewer, or the fixer a refusal bought, asked the
       * same account and met the same wall. What that measured is the account,
       * so the answer is the account's: the conductor stands down, and the item
       * is **released** rather than blocked, so the queue brings it back when
       * the limit lifts and nobody requeues anything.
       *
       * **Not a round, not a hold, not the lane.** A round would buy an agent
       * from the account that just refused one; a hold would put *merge anyway?
       * the review gate refused* to a person about a diff nothing read — under
       * `--no-merge`, which this repository always passes — and the lane would
       * record `gate-failed`. All three are sentences about the diff.
       *
       * **Stood down first, then pushed**, with the lease the loop's own push
       * uses: the next attempt's prompt names `agent/<n>` (`attempts.ts`), and a
       * pass that stopped for the account should leave the work where it can be
       * read. But the push is a courtesy to the next attempt and the pause is the
       * answer to the account, so a rejected lease or a dropped network must not
       * turn this ending into a push failure — that would release the item as
       * `push: …`, leave the conductor running, and let the next claim meet the
       * same wall (0031 §3). A push that fails is said, and the ending stands.
       */
      const agentNeverStarted = (what: Exclude<NeverStarted, { of: "run" }>, detail: string) =>
        Effect.gen(function* () {
          const who =
            what.of === "gate" ? `the ${what.gate} gate's agent` : `the agent fixing ${what.action}`;
          runLog.note(what.of, `${who} never started — ${detail}`);
          yield* standDownConductor(what, detail);
          const pushed = yield* Effect.either(
            gitInWorktree([
              "push",
              `--force-with-lease=refs/heads/${branch}:${lease ?? ""}`,
              "origin",
              `HEAD:refs/heads/${branch}`,
            ]),
          );
          if (Either.isRight(pushed)) {
            lease = head;
          } else {
            runLog.note("push", `not pushed, and the pass still ends for the account — ${pushed.left.detail}`);
          }
          const unpushed = Either.isLeft(pushed) ? ` (and ${branch} was not pushed: ${said(pushed.left.detail, 120)})` : "";
          return yield* new Stopped({
            stage: what.of,
            detail: `${who} never started: ${detail}`,
            // Not `the ${gate} gate refused it`, and not `nothing was spent`
            // either — the implementer ran and its cost is on `RunFinished`.
            // What is true of the diff is that nobody judged it.
            release:
              what.of === "gate"
                ? `the ${what.gate} gate never ran — its agent never started, so nothing judged this diff: ${said(detail)}${unpushed}`
                : `the agent fixing ${what.action} never started, so nothing answered the refusal: ${said(detail)}${unpushed}`,
          });
        });

      /**
       * One round: decide, record, dispatch, record what came back.
       *
       * Whether it happens at all is `decideFix`'s and not this file's: a rule
       * about spending money inside an `if` here is a rule nobody can check,
       * which is why the only purchase left in the system is decided in a pure
       * module with tests. What is here is the order, and the order is the same
       * for all three refusals, which is 0039 §2 in one function rather than in
       * three.
       */
      const buyRound = (refusal: {
        action: string;
        findings: readonly GateFinding[];
        evidence: string;
        on?: FixOn;
      }) =>
        Effect.gen(function* () {
          const decision = decideFix({
            refusal,
            rounds: recipe.runtime.limits.rounds,
            roundsSpent: rounds,
          });

          if (!decision.fix) {
            log(`no fix for ${refusal.action}: ${decision.why}`);
            runLog.note("fix", `none: ${decision.why}`);
            // **Every refusal this loop could have bought for is recorded
            // declining it**, which was `RepairDeclined`'s reason before that
            // event was retired: "nothing happened because nobody asked for it"
            // and "nothing happened and we do not know why" are the two things
            // a log exists to keep apart. Until 0039 a red build was neither —
            // it was the merge lane's business, so it left no `FixDeclined` and
            // no trace here at all.
            //
            // The one refusal that still records nothing is the one this loop
            // was never able to act on: `decideFix` refused it for carrying no
            // criterion, so there was no decision about money to record, and the
            // lane is left to record the gate failure instead.
            if (refusal.findings.length === 0 && refusal.evidence.trim() === "") {
              return { kind: "unbought" as const };
            }
            yield* appendAtEnd(runId, [
              {
                type: "FixDeclined",
                actor: "conductor",
                data: parsePayload("FixDeclined", {
                  runId,
                  round: rounds,
                  action: refusal.action,
                  why: decision.why,
                  findings: refusal.findings,
                }),
              },
            ]);
            return {
              kind: "declined" as const,
              round: rounds,
              why: decision.why,
              on: refusal.on ?? (refusal.findings.length > 0 ? ("findings" as const) : ("output" as const)),
              // The rule, carried whole rather than flattened into `exhausted`
              // below: two of its three values are the same answer about money
              // and three different sentences to a person (`#197`).
              stop: { ended: decision.rule } satisfies FixStop,
              // The ceiling, or the recipe declining to have one — both mean
              // *nothing more patches this diff in place*, which is the
              // question `decideRestart` asks. `no-criterion` does not: a gate
              // that refused with nothing to hold a fixer to is not a spent
              // budget, and a whole fresh pass answers it no better than a
              // round would have.
              exhausted: decision.rule !== "no-criterion",
            };
          }

          // Appended **before** the agent runs: the evidence it was handed is
          // the acceptance contract, and a log that learned it afterwards could
          // only ever show the rounds that survived.
          yield* appendAtEnd(runId, [
            {
              type: "FixRequested",
              actor: "conductor",
              data: parsePayload("FixRequested", {
                runId,
                round: decision.round,
                // The ceiling this round is counted against, so *round 2 of 3*
                // is readable off the log by a projection, which may not open a
                // recipe. Written here because a field declared and handed to
                // nothing is `#89`'s shape, and the zod default of zero would
                // have made it look present.
                of: recipe.runtime.limits.rounds,
                action: refusal.action,
                onSha: head,
                findings: refusal.findings,
              }),
            },
          ]);
          log(`bought a fix for ${refusal.action} — round ${decision.round}`);
          runLog.note("fix", `round ${decision.round} for ${refusal.action}`);

          // Its own settings with no hook in them, exactly as the reviewer's:
          // the hook carries the lifecycle of a *run*, and a round is a step
          // inside one. And its own id — `sessionIdFor` is a function of the run
          // id, so handing it this run's would resume the implementer's session
          // and give it back the reasoning 0038 §3 takes away.
          const fixSettings = yield* writeUnhookedSettingsEffect(
            runId,
            `fix-${decision.round}`,
            home,
          ).pipe(failing("hook"));

          // The same diff the reviewer was shown, from the same function and
          // under the same ceiling: two agents arguing about a change have to be
          // looking at the same change.
          const underReview = yield* Effect.promise(() => gateDeps.agent.diff());

          const fixed = yield* Effect.promise(() =>
            options.runtime
              .run({
                runId: `${runId}:fix:${decision.round}`,
                cwd: worktree.path,
                // The one argument that differs between the three (0039 §2).
                // `decideFix` already worked out which shape the refusal is, and
                // re-deciding it here would be a second source of truth for one
                // question.
                prompt: fixBrief({
                  refusal:
                    decision.on === "findings"
                      ? { on: "findings", findings: refusal.findings }
                      : decision.on === "conflict"
                        ? { on: "conflict", base, paths: refusal.evidence }
                        : { on: "output", output: refusal.evidence },
                  round: decision.round,
                  of: recipe.runtime.limits.rounds,
                  action: refusal.action,
                  diff: underReview,
                  diffBytes: recipe.runtime.budget.diff,
                }),
                settingsPath: fixSettings,
                // The run's log, filed under the round (#153). Unhooked like the
                // reviewer, so its tool calls come off the stream.
                log: taggedTrace(runLog, `fix:${decision.round}`),
                traceTools: true,
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

          if (fixed.failure?.kind === "never-started") {
            // The account, not an objection and not a crash: see
            // `agentNeverStarted`. A block here would ask a person about a
            // refusal nothing has yet tried to answer.
            return yield* agentNeverStarted(
              { of: "fix", action: refusal.action, round: decision.round },
              fixed.failure.detail,
            );
          }

          if (!committed) {
            // Nothing to run again: the point would be asked the same question
            // about the same commit and would answer it the same way, and paying
            // for that is the one thing a second opinion must not be. The
            // refusal stands, and a person is asked.
            //
            // **A decline and a crash arrive here as the same branch and are not
            // the same event** (0039 §5). Committing nothing is the fixer's one
            // way to object, and `fixBrief` tells it so; a fixer that threw
            // produced nothing and meant nothing by it. One sentence for both
            // would tell a person "the fixing agent committed nothing" about a
            // process that was killed.
            //
            // **And the distinction now reaches the headline** (`#197`). It was
            // made here and spent on `why`, which lands three sentences into the
            // second paragraph of a card whose first sentence said *two agents
            // disagreed*. `stop` carries the same branch up to where a person
            // reads first; `why` below is unchanged, because the evidence under
            // the headline was never the thing that was wrong.
            //
            // **And the branch is three ways, not two.** `fixStopOf` reads the
            // kind against a total record rather than treating everything that
            // is not a decline as a crash: `out-of-turns` is the repository's
            // failure (`attribution.ts`), and the block a page above answers a
            // whole run ending that way with *narrow or split the ticket — a
            // retry buys another run to the same limit*. A card here telling a
            // person the opposite is the same ticket read twice and answered
            // both ways.
            return {
              kind: "declined" as const,
              round: decision.round,
              on: decision.on,
              stop: (fixed.failure
                ? fixStopOf(fixed.failure)
                : { ended: "declined" }) satisfies FixStop,
              why: fixed.failure
                ? `the fixing agent did not finish (${fixed.failure.kind}: ${fixed.failure.detail}), ` +
                  "so there is nothing new for the review to read"
                : declineWhy(fixed.text),
              // **Not exhausted, and the rounds may well be left over.** This
              // pass stopped because an agent objected or died, not because it
              // ran out of money, so a restart is not what answers it (0040):
              // an objection is for a person to read, and a crash is for a
              // person to see. Either would be buried by paying for a fresh
              // approach.
              exhausted: false,
            };
          }

          // The card's numbers describe the diff that is now under review, not
          // the one that was refused two events ago.
          const moved = yield* numstat;
          yield* appendAtEnd(runId, [
            {
              type: "RunProducedDiff",
              actor: "conductor",
              data: parsePayload("RunProducedDiff", { branch, headSha: after, ...moved }),
            },
          ]);
          return { kind: "committed" as const, round: decision.round, head: after };
        });

      /**
       * Put the moved base into the run's own worktree, conflict and all.
       *
       * **A description of a conflict is not something anyone can resolve.** The
       * markers are. So the lane's refusal is not forwarded as prose: the base
       * is merged in here, left exactly as `git merge` left it, and the agent
       * arrives in the middle of it. That is the one way the three briefs differ
       * in more than an argument, and it is why.
       *
       * From `origin` rather than from the mirror's copy of the base, which is
       * what the lane just found stale. Returns the conflicting paths, or `null`
       * when it applies cleanly after all — the base can move twice, and the
       * second move can be the one that makes the first mergeable. That costs no
       * round, because no agent was bought.
       */
      const stageConflict = Effect.gen(function* () {
        yield* gitInWorktree(["fetch", "origin", base]).pipe(failing("push"));
        const applied = yield* Effect.either(gitInWorktree(["merge", "--no-edit", "FETCH_HEAD"]));
        if (Either.isRight(applied)) return null;
        const paths = yield* gitInWorktree(["diff", "--name-only", "--diff-filter=U"]).pipe(
          Effect.orElseSucceed(() => ""),
        );
        return paths;
      });

      for (;;) {
        // ---- the `proposed` point -------------------------------------------
        // The reviewer sees the ticket and the diff, and gets the diff from the
        // gate deps because the gates package does not know about git and should
        // not learn.
        //
        // A function of the head and the findings, because it runs once per
        // round: the same actions, in the same order, with one thing added — the
        // scenarios the last refusal was made of, which the reviewer is asked
        // about by name (0038 §2).
        pipeline = yield* judge(head, recheck, rounds);
        recheck = [];
        log(`gates: ${pipeline.results.map((r) => `${r.gate}=${r.verdict}`).join(" ")}`);

        // Before the refusal is read: a gate whose agent never started refused
        // nothing, and must not reach `buyRound`, the hold or the lane.
        if (pipeline.neverRanAt !== null) {
          yield* agentNeverStarted(
            { of: "gate", gate: `proposed:${pipeline.neverRanAt.gate}` },
            pipeline.neverRanAt.detail,
          );
        }

        // ---- the branch, on the remote -------------------------------------
        //
        // **Defined here, above every way out of this loop, because the last
        // fix was one `if` and the class had two** (`#154`, then `#157`). The
        // agent's branch has to exist on the remote for the integrator to merge
        // it, and for a person to read what they are being asked to approve; it
        // works in a worktree, not on origin, and 0039 throws the worktree away
        // with the pass.
        //
        // `#154` moved the push above the *held* break and said in its own
        // comment that this covered "a refusal no round was bought for". It did
        // not. A refusal whose fixing agent declines leaves forty lines earlier
        // — `bought.kind === "declined"` — and never reached the push at all.
        // `#157` ran for twelve turns, wrote an ADR and two commits, was refused
        // by `build`, declined a fix, and its worktree was collected with the
        // only copy of the work in it. That is this repository's most-repeated
        // shape, committed in the act of fixing it: one instance closed, the
        // class left open, and a comment asserting otherwise.
        //
        // So the push is a value and a helper rather than a line at one exit,
        // and every path that leaves this loop with commits calls one of them.
        // Adding a third `if` would have been the third time.
        const push = [
          "push",
          `--force-with-lease=refs/heads/${branch}:${lease ?? ""}`,
          "origin",
          `HEAD:refs/heads/${branch}`,
        ];

        /**
         * The push a run makes on its way to a stop, which must not change the
         * stop.
         *
         * Tolerant, as the stand-down's is: a hold and a declined refusal are
         * both decisions about the work, and a push that failed must not turn
         * either into a different ending. The person is still owed the question;
         * they are told the branch is not there to answer it with.
         */
        const pushOnTheWayOut = Effect.gen(function* () {
          const pushed = yield* Effect.either(gitInWorktree(push));
          if (Either.isRight(pushed)) {
            lease = head;
          } else {
            runLog.note("push", `${branch} was not pushed, and the stop stands — ${pushed.left.detail}`);
          }
        });

        if (!pipeline.ok && pipeline.failedAt !== null) {
          // The refusal, by verdict rather than by position: the pipeline stops
          // at the first one, so it is also the last result — and asking for the
          // verdict says what is meant. It carries the findings, which is why
          // `PipelineResult.results` does.
          const refused = pipeline.results.filter((r) => r.verdict === "failed").at(-1)!;
          // Counted here and not below, because this is where *this action said
          // no about this diff* is a fact — whatever the loop then decides to
          // buy, or not to.
          const refusedDiffs = refusedAgain(refused.gate);
          const bought = yield* buyRound({
            action: refused.gate,
            findings: refused.findings,
            evidence: refused.evidence,
          });
          if (bought.kind === "committed") {
            head = bought.head;
            rounds = bought.round;
            recheck = refused.findings;
            continue;
          }
          if (bought.kind === "declined") {
            unresolved = {
              action: refused.gate,
              on: bought.on,
              findings: refused.findings,
              evidence: refused.evidence,
              rounds: bought.round,
              refusals: refusedDiffs,
              why: bought.why,
              stop: bought.stop,
              exhausted: bought.exhausted,
            };
            // The work is going to a person, so the person has to be able to
            // read it. This is the exit `#154`'s fix missed.
            yield* pushOnTheWayOut;
            break;
          }
          // Nothing this loop could have bought for. The lane below records the
          // gate failure, which is where a refusal with no criterion has always
          // gone.
        }

        if (pipeline.heldAt !== null) {
          yield* pushOnTheWayOut;
          break;
        }

        // Strict here, and only here: this run is going on to merge, and an
        // integrator that cannot find the branch is a failure of the run rather
        // than a stop somebody is owed an explanation for.
        yield* gitInWorktree(push).pipe(failing("push"));
        lease = head;

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
        // Reset rather than declared: this runs once per round, and the loop
        // reads it after. A `let` here would shadow the one the hold below asks
        // about — a hold that renders and does nothing, which is the exact shape
        // of #58.
        atMerge = { ok: true, failedAt: null, heldAt: null, neverRanAt: null, results: [], skipped: [] };
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
                round: rounds,
                log: runLog,
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
          // The same ending at the other point that runs an `agent` action.
          if (atMerge.neverRanAt !== null) {
            yield* agentNeverStarted(
              { of: "gate", gate: `merge:${atMerge.neverRanAt.gate}` },
              atMerge.neverRanAt.detail,
            );
          }
        }

        /**
         * **The head the gates gave their verdicts about.**
         *
         * The implementer's, or whatever the last round committed — which is the
         * same thing said twice only when no round was bought. Everything below
         * asks about *this* commit, and 0025's rule that an approval is bound to a
         * sha is why it has a name of its own rather than being read again.
         */
        const headSha = head;

        if (atMerge.heldAt !== null || options.merge === false || repairOf !== null) break;

        // ---- the merge lane -------------------------------------------------
        // Only one of the two can have refused — `merge` runs only when
        // `proposed` passed — and the integrator records that one.
        const refusedAt = pipeline.failedAt !== null ? pipeline : atMerge;
        merged = yield* repo.integrate({
          project,
          owner: options.client.owner,
          repo: options.client.repo,
          base,
          branch,
          workItemId,
          headSha: head,
          gatesPassed: pipeline.ok && atMerge.ok,
          gateDetail: refusedAt.failedAt
            ? `${refusedAt.failedAt}: ${refusedAt.results.find((r) => r.gate === refusedAt.failedAt)?.evidence ?? ""}`
            : undefined,
          token: options.token,
          home,
          gitEnv: options.gitEnv,
          store,
        });
        if (merged.ok) break;

        /**
         * **A conflict goes back to the agent, and it is the refusal that used
         * to cost the most.**
         *
         * The lane merged the base in, found it does not apply, aborted, and let
         * go — `integrate()` returning is what releases the lane's worktree,
         * which is its whole scope since #194 took the lock away. So nothing
         * below holds anything while an agent works, and the lane is simply
         * re-entered afterwards. That was the objection that looked fatal to
         * this and was not; the lock it was about is gone either way.
         *
         * The base may move again while the agent resolves one. Then this comes
         * round again, which is ordinary optimistic retry bounded by `rounds`,
         * and each retry is seconds.
         */
        if (merged.reason !== "conflict") break;

        const paths = yield* stageConflict;
        const afterStaging = yield* gitInWorktree(["rev-parse", "HEAD"]).pipe(failing("diff"));
        if (paths === null) {
          // It applies now. No agent, no round — the head moved, so the point is
          // asked about it again and the lane re-entered.
          log(`${base} moved again and now merges cleanly — retrying`);
          head = afterStaging;
          merged = null;
          continue;
        }

        // A conflict the lane could not apply, which is one refusal by `merge`.
        // The `paths === null` return above is not one: the base moved again
        // and it merges, so nothing refused anything.
        const refusedDiffs = refusedAgain("merge");
        const bought = yield* buyRound({
          action: "merge",
          findings: [],
          evidence: paths,
          on: "conflict",
        });
        if (bought.kind === "committed") {
          head = bought.head;
          rounds = bought.round;
          merged = null;
          continue;
        }
        if (bought.kind === "declined") {
          unresolved = {
            action: "merge",
            on: "conflict",
            findings: [],
            evidence: paths,
            rounds: bought.round,
            refusals: refusedDiffs,
            why: bought.why,
            stop: bought.stop,
            exhausted: bought.exhausted,
          };
        }
        break;
      }

      /**
       * **The head every verdict above was about**, and the one a person is
       * asked to approve.
       *
       * The implementer's, or whatever the last round committed — the same thing
       * said twice only when no round was bought. It has a name of its own
       * rather than being read again from git because 0025's rule is that an
       * approval is bound to a sha: reading `HEAD` here a second time would
       * quietly re-point the question at whatever the worktree happens to hold.
       */
      const headSha = head;

      // ---- 12. the rounds are spent, and there may be another approach ------
      /**
       * **`rounds` bounds depth; this bounds breadth**
       * ([0040](../../../doc/decisions/0040-rounds-bound-depth-restarts-bound-breadth.md)).
       *
       *     refusal         → round      the loop above
       *     rounds spent    → restart    here: release, and the next claim is
       *                                  an ordinary fresh pass
       *     restarts spent  → a person   the hold below
       *
       * **The mechanism is a push, an append and a release**, which is why
       * this is one branch rather than a second dispatcher. `attempts.ts` already writes the
       * abandoned branch, its sha, the `git fetch` and the findings into every
       * second attempt's prompt, and hands the judgement — build on it or start
       * over — to the agent explicitly. That prompt is what made
       * [experiment 011](../../../doc/experiments/011-patching-versus-starting-over.md)'s
       * second arm land for half the money. What was missing was never a
       * dispatcher; it was the decision to take it, and until now that decision
       * was a person typing `requeue`.
       *
       * The push is what makes that prompt true rather than a lie — see it
       * below. A restart is the one ending that promises another agent a
       * branch, and a pass that spent its rounds never reached the push inside
       * the loop above.
       *
       * **The whole of the arms' history is on the item's stream**, appended
       * before the release: the fold has to carry this arm before anything can
       * claim the next one, or the ceiling counts one restart short for ever.
       *
       * Read fresh rather than off the `item` folded before the claim, because
       * this is a rule about spending money and it asks the log what it says
       * now rather than what it said before this pass began.
       */
      let restartDeclined: string | null = null;
      /**
       * Every approach already abandoned on this item, newest first.
       *
       * Empty on every project that leaves `restarts` at zero, and then the
       * block below is byte-identical to the one it was. When it is not empty it
       * is the criterion 0040 §3 asks for: *reaching the second ceiling blocks
       * for a person with every arm's findings on the card.* Each arm's refusal
       * is on a run stream no later pass reads, so `PassRestarted` is where they
       * survive and this is where they are read back.
       */
      let arms: readonly RestartArm[] = [];
      if (unresolved !== null) {
        // Who else is waiting, named rather than counted, because the sentence
        // a declined restart leaves on the card has to say which of them it
        // deferred to. `--no-merge` is deliberately **not** here: it says *do
        // not merge without me*, and a restart merges nothing — the fresh pass
        // will hold at the same flag. Excluding it would also make this
        // unreachable on the one repository that has to prove it, since Lingtai
        // on Lingtai passes the flag every time.
        const alsoAsked =
          pipeline.heldAt !== null
            ? `the ${pipeline.heldAt} action`
            : atMerge.heldAt !== null
              ? `the ${atMerge.heldAt} action`
              : repairOf !== null
                ? "a repair"
                : null;
        const folded = reduceWorkItem(yield* Effect.promise(() => store.read(workItemId)));
        // Newest first, which is the order they are read in. The fold keeps them
        // oldest first because that is the order they happened.
        arms = [...folded.restarts].reverse();
        const second = decideRestart({
          refusal: { action: unresolved.action, on: unresolved.on, exhausted: unresolved.exhausted },
          restarts: recipe.runtime.limits.restarts,
          item: folded,
          alsoAsked,
        });

        if (second.restart) {
          /**
           * **The abandoned approach is published before anything names it.**
           *
           * The only push in a pass is inside the loop above, *after* the
           * refusal is handled, so a review that spent the rounds never
           * reaches it: the branch has commits and no ref. The worktree is cut
           * `--force --detach` and `removeWorktree` deletes it when this scope
           * closes, so without this the `branch` and `headSha` below name an
           * approach that exists nowhere — and `attempts.ts` would tell the
           * next agent `git fetch origin agent/<n>` for a ref origin has never
           * heard of. That prompt is the whole of the restart mechanism
           * (0040 §2), so the ending that promises the branch is the ending
           * that has to put it there.
           *
           * The same lease as the push above, for the same reason: origin's
           * `agent/<n>` may be the arm before this one, and what this pass has
           * of it is what it last looked at.
           *
           * **Two refs, because they answer two different questions.**
           * `agent/<n>` is the one `attempts.ts` names, so it has to be the
           * *newest* arm — which means the arm after this one overwrites it,
           * force, from a history with no ancestor in common. `armBranch` is
           * this arm's own and nothing else ever writes it, so every abandoned
           * approach stays fetchable and `PassRestarted` can name a ref that
           * is still there when the last restart is spent and a person is
           * shown all of them. Forced, not created: a pass that pushed and
           * then failed to record its arm comes back with the same ordinal,
           * and a rejected non-fast-forward there would wedge the ticket.
           *
           * Before the append, not after. A push that is refused leaves no arm
           * on the log — the pass ends as a `push` failure, the item goes back
           * through the backoff, and nothing has claimed one of the restarts
           * for an approach nobody can read.
           */
          const arm = armBranch(branch, second.n);
          yield* gitInWorktree([
            "push",
            `--force-with-lease=refs/heads/${branch}:${lease ?? ""}`,
            "origin",
            `HEAD:refs/heads/${branch}`,
            `+HEAD:refs/heads/${arm}`,
          ]).pipe(failing("push"));

          const reason = restartReason({
            action: unresolved.action,
            rounds: unresolved.rounds,
            n: second.n,
            of: second.of,
          });
          yield* appendAtEnd(workItemId, [
            {
              type: "PassRestarted",
              actor: "conductor",
              data: parsePayload("PassRestarted", {
                runId,
                restart: second.n,
                of: second.of,
                action: unresolved.action,
                rounds: unresolved.rounds,
                // This arm's own ref and not `agent/<n>`, which the next arm
                // takes. The event is read when the *last* restart is spent,
                // so the branch it names has to be the one still holding this
                // arm's commits then.
                branch: arm,
                headSha,
                findings: unresolved.findings,
              }),
            },
          ]);
          log(`starting over — restart ${second.n} of ${second.of}`);
          runLog.note("restart", reason);
          // Through `Stopped` and not through a `release(...)` beside a
          // `return`: the handler at the bottom of this function releases with
          // the reason and reports the stage, once, for every refusal taken
          // after the claim. A restart is one of those — the pass did not land.
          return yield* new Stopped({ stage: "restart", detail: reason, release: reason });
        }
        // Not its own event. "Nothing happened because nobody asked for it" and
        // "nothing happened and we do not know why" still have to be kept apart
        // — but the sentence that keeps them apart is on the block's own
        // `diagnosis`, which is an event payload and is therefore on the log.
        // A `PassRestartDeclined` would append on every spent pass of every
        // project that leaves `restarts` at zero, which is all of them, to say
        // what the recipe already says.
        restartDeclined = second.why;
      }

      // ---- 13. hold, if anything asked for a person -------------------------
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
      // **And a repair always asks.** The run whose approval had been consumed
      // was still `gating` and nothing re-offered the decision, so a repair that
      // left an item unapprovable had not repaired it. Nothing buys one since
      // `#143` — what a refused merge leaves is a block a person can answer —
      // but a repair bought before it and claimed after is still one, and still
      // asks rather than merging unattended.
      //
      // **And a point that spent its rounds asks, rather than going to the merge
      // lane** ([0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md) §3).
      // Something refused, an agent was bought or declined, and it still
      // refuses. Stopping here rather than below is what makes `rounds` the one
      // ceiling it claims to be: the merge lane would refuse with `gate-failed`
      // and — while a lane refusal still bought a run — `decideRepair` would
      // buy *another* agent for a refusal this pass has already paid up to
      // `rounds` for. One ceiling has to mean one destination, or it is not a
      // ceiling. `#143` finished that reading from the other end: the lane buys
      // nothing at all now, so the two cannot disagree even by accident.
      //
      // 0038 made this argument for a refused review and kept a red build out of
      // it, because a build was the merge lane's business then. It is not any
      // more, and the argument never depended on which kind of failure it was.
      // A person can still merge it: the approval below is requested on this
      // head like any other.
      //
      // **And since 0040 it asks only once the *second* ceiling is spent too.**
      // The block above got the refusal first and may have released the item for
      // a fresh approach instead; reaching here means either that this project
      // buys no restart — the default, and every project today — or that the
      // restarts are spent as well. `restartDeclined` is which, in
      // `decideRestart`'s own words, and it goes on the card beside the reason
      // no further round was bought: an item that stopped must never be left
      // with a ceiling nobody can see.
      if (
        pipeline.heldAt !== null ||
        atMerge.heldAt !== null ||
        options.merge === false ||
        repairOf !== null ||
        unresolved !== null
      ) {
        // `heldAt` is an *action* name; the point is the pipeline it came from.
        // The operator's `--no-merge` is a hold at the `merge` point that names
        // itself as the action, so a card tells it from a configured one.
        // **An unresolved point names itself, for exactly the reason the two
        // above do, and it is worth saying why the obvious alternative destroys
        // the thing it was trying to point at.**
        //
        // Naming it after the action reads well — *the thing a person is looking
        // at is that action's findings* — and gives this request the same
        // `${gate}:${action}` key as the `GateFailed` that holds them.
        // `task-view.ts:427` folds both through one `setGate`, so the request,
        // which carries no verdict and no findings, overwrites the refusal it
        // exists to report: verdict, evidence and findings replaced by an empty
        // `pending` entry, on every projection and every rebuild.
        //
        // So the pointer travels in the question, which is what a person reads,
        // and the key stays the request's own.
        //
        // **And the two shapes do not name themselves the same way, because
        // only one of the names is a claim** (`#197`). `unfixed` is a state —
        // the check is red and nothing fixed it — and that holds however the
        // pass ended, so the output shape has one name. `disagreement` asserted
        // that two agents looked at one diff and could not settle it, and it
        // was written on every findings-shaped block: `#187`'s rate limit is a
        // gate row on the board named *disagreement* above a question saying
        // nothing was decided. `stopAction` is that table, and its words are
        // the headlines' — a row reading `proposed · unfinished` over a card
        // reading *A fixing agent did not finish* is one fact said twice.
        const gate = pipeline.heldAt !== null || unresolved !== null ? "proposed" : "merge";
        const action =
          pipeline.heldAt ??
          atMerge.heldAt ??
          (unresolved
            ? unresolved.on === "findings"
              ? stopAction(unresolved.stop)
              : "unfixed"
            : null) ??
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
                // too and the question has to say which colour it is.
                question:
                  // A repair bought before `#143` says what it was repairing,
                  // because the diff answers a failure and "approve this"
                  // without naming it is half a question.
                  (repairOf ? `A repair for ${repairOf.reason}. ` : "") +
                  // How many approaches this is, when it is more than one. A
                  // person deciding whether to merge over a live finding wants
                  // to know whether the ticket has been attempted from scratch
                  // and refused each time — that is a different question from
                  // one stubborn diff.
                  (arms.length > 0 ? `Approach ${arms.length + 1} of ${arms[0]!.of + 1}. ` : "") +
                  (unresolved
                    ? // **And this one is kept for ever** (`#197`). The headline
                      // and the block's line both say what stopped the pass; a
                      // record that went on saying *two agents disagreed* would
                      // put the log on the wrong side of the disagreement #83 is
                      // about, and unlike the other two nothing ever rewrites it.
                      `Merge ${branch} into ${base} anyway? ${mergeAnywayBecause(unresolved)}`
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
        //
        // **`stop` rides the spread** (`#197`), which is why this line did not
        // change when the sentence it produces did. It is the first thing a
        // person sees — the GitHub comment, the board's note, `lingtai status`
        // — so a line still saying *two agents disagreed* over a card headlined
        // *a fixing agent did not finish* is the two readings contradicting
        // each other, and the one they read first winning.
        const question = unresolved
          ? unresolved.on === "findings"
            ? disagreementQuestion({ ...unresolved, branch, base, restarts: arms.length })
            : unfixedQuestion({ ...unresolved, branch, base, restarts: arms.length })
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
         * The refusal in the gate's own words.
         *
         * **A gate's name is not a reason** (#132). `the review gate refused it`
         * is every word true and a reader takes the wrong thing from it — that a
         * reviewer read the diff and found problems. On `#121` the reviewer
         * never ran: the guard hook refused its opening prompt, and the gate's
         * own evidence said so exactly. The pipeline that refused is the one
         * that carries the verdict, since `merge` runs only when `proposed`
         * passed and only one of the two can have a failure in it.
         */
        const refusedIn = pipeline.failedAt !== null ? pipeline : atMerge;
        const evidence =
          failedAt === null
            ? null
            : (refusedIn.results.find((r) => r.gate === failedAt)?.evidence ?? "");
        /**
         * **A point that spent its rounds is diagnosed as what it is, and not as
         * a gate refusing.** 0038's consequence, now in two shapes: what reaches
         * a person is no longer the first refusal, it is something that has since
         * happened `rounds + 1` times. A card saying "the review gate refused"
         * would be describing the first half of that.
         *
         * The two shapes stay apart all the way to the card. *Two agents looked
         * at this and did not agree* is a judgement being handed over; *this
         * check ran again and is still red* is a fact being reported. Collapsing
         * them would save a branch and cost the reader the only thing they need
         * to know first: whether there is anything here to decide.
         */
        /**
         * Why no further agent was bought, both ceilings in one sentence.
         *
         * `unresolved.why` names the rule that stopped the rounds and
         * `restartDeclined` names the rule that stopped the approaches, and a
         * card that carried only the first would report a ceiling a reader can
         * see and hide the one they cannot. Null on nothing: a spent pass always
         * reaches `decideRestart`, and `restarts: 0` is a rule with a sentence
         * like any other.
         */
        const whyNoMore =
          unresolved === null
            ? ""
            : restartDeclined === null
              ? unresolved.why
              : `${unresolved.why}. And no second approach: ${restartDeclined}`;
        const diagnosis = unresolved
          ? unresolved.on === "findings"
            ? diagnoseDisagreement({ ...unresolved, branch, base, headSha, why: whyNoMore, earlier: arms })
            : diagnoseUnfixed({ ...unresolved, branch, headSha, why: whyNoMore, earlier: arms })
          : {
              what:
                `${branch} is at ${headSha.slice(0, 7)} and ` +
                (failedAt !== null
                  ? `the ${failedAt} gate refused it. The ${gate} point holds for ${action}.`
                  : green
                    ? `every gate passed. The ${gate} point holds for ${action}.`
                    : // Neither green nor refused: a gate asked for a person rather
                      // than judging — a `human:` action, or a `watch` one that saw
                      // a migration. It used to fall through to the sentence above
                      // and print `the null gate refused it`, which is the same
                      // defect one word further on: a cause the block does not have.
                      `the ${action} gate at ${gate} asked for a person before anything after it ran.`),
              // What was done about it, when something was: a repair spent an agent
              // and this diff is what it produced. An ordinary hold had no failure
              // to do anything about, and says so by saying nothing.
              //
              // It does not name the run. The block that renders this already says
              // which attempt and which run it is about, and an identifier printed
              // twice in one block is the reader's problem #132 is about.
              done: repairOf ? `a repair for ${repairOf.reason} produced this diff` : null,
              // The failing gate's evidence, verbatim, and null when nothing
              // refused. This was `null` on the argument that the verdicts are on
              // the task's own page with their evidence — which is true, and is
              // three ranks down at 0.72rem behind a disclosure, so the one block
              // whose job is to say why a task stopped had only a gate's name to
              // say it with (#132). An empty string is a gate that refused and
              // recorded nothing, which is a different fact from having no gate.
              raw: evidence,
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
                // **The line above the headline has to agree with it** (`#197`,
                // and `stopNeeds` is where the table lives). Every other hold
                // here is a person's call — a `human:` action, a migration, a
                // repair's diff — so `judgement` is still what they get.
                needs: unresolved === null ? "judgement" : stopNeeds(unresolved.stop),
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

      // ---- 14. what the lane produced --------------------------------------
      /**
       * The lane itself is the loop's last step now (`#142`); this is the two
       * things that can be true when it is over.
       *
       * **Every way out of that loop without entering the lane asks a person**,
       * and the hold above returned. Reaching here with nothing is a fourth kind
       * of ending nobody wrote, so it says so and releases rather than reading a
       * null as a failure.
       */
      if (merged === null) {
        return yield* new Stopped({
          stage: "integrate",
          detail: "the pass ended without reaching the merge lane and without asking anybody",
          release: "the pass ended without reaching the merge lane",
        });
      }

      if (!merged.ok) {
        // ---- the failure's own outcome -------------------------------------
        /**
         * **A lane refusal buys nothing, and asks a person.** Every one of them,
         * with no rule to consult and no recipe key to read
         * ([0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md)
         * §Consequences, `#143`).
         *
         * 0025 asked `decideRepair` here whether the failure bought a whole new
         * run. What is left reaching this line does not deserve one and two of
         * them never did. A `conflict` is answered in this pass's own worktree
         * and never arrives (`#142`). A `gate-failed` arrives two ways, and
         * neither is a reason to buy a run. From `proposed`, it is a refusal
         * `decideFix` declined to buy for, because it carried no criterion — so
         * buying a *run* for exactly what a *round* is refused for was the same
         * decision made twice with opposite answers. From a `merge:` gate it
         * never met `decideFix` at all: the merge point runs after the round
         * loop, `integrate()` takes its verdict as `gatesPassed: false`, and it
         * comes here with no `FixRequested` or `FixDeclined` on the log — so
         * this block, with its diagnosis, is the whole of what that path gets,
         * and nothing upstream has already answered it. And a
         * `no-commits` means the branch holds nothing, which a new run starting
         * from scratch answers by definition and expensively.
         *
         * The mechanical remedy has already run by the time this line is
         * reached — `integrate()` merges the base in before it merges out — and
         * `IntegrationRefused` is on the log as the record of its exhaustion.
         * That ordering is 0025 §4 and it is the one part of that decision this
         * path still depends on.
         *
         * Blocked rather than released: a refusal is a question for a person,
         * and the board's "Waiting on you" column is where it goes. An item
         * whose integration failed must never be left with a control that
         * refuses and no sentence explaining it.
         */
        const question = `${merged.reason}: ${merged.detail.slice(0, 400)}`;
        // The question above is #83's own exhibit — a reason code, 400 characters
        // of git output and a colon — and it is still appended, because it is
        // what the log has always said and shortening it would lose the failure.
        // What is beside it is the answer: the refusal read as a sentence, what
        // had already been tried, whose failure it is, the output verbatim, and
        // the move it implies. `diagnoseRefusal` composes all of it from
        // `whoseFailure`, so this line hands it no judgement of its own.
        const diagnosis = diagnoseRefusal({
          reason: merged.reason,
          detail: merged.detail,
          branch,
          base,
        });
        const ended = yield* Effect.promise(async () => {
          const blocked = await store.read(workItemId);
          const resolvedEnd = resolveEndActions(blocked, recipe.gates.end, "blocked");
          await store.append(workItemId, blocked.length, [
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
