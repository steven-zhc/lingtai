/**
 * One work item, claim through merge — **and since `#256` the sequence is not
 * here.**
 *
 * `runPass` in [`pass.ts`](pass.ts) walks the ten steps and applies the outcome
 * rules; `bodiesFor` in [`pass-steps.ts`](pass-steps.ts) is the ten bodies. This
 * file is what they were written to be called by: it resolves the recipe and the
 * environment, builds a live `PassPorts` out of `Repo`, `AgentHost`, the GitHub
 * client and the store, hands the pass its `actionsAt` and its `emit`, and
 * **writes down the ending** — which is the one thing the pass deliberately does
 * not do ([0058](../../../doc/decisions/0058-lingtai-is-a-development-pipeline.md)
 * §2b, and `pass-steps.ts`'s *What the pass does not write*).
 *
 * It replaces `run-once.ts`, which ran five gate points around the same wiring
 * in 3479 lines. Nothing about the *stored* vocabulary changed in that swap:
 * `pass.ts` and `pass-steps.ts` append no event type of their own, so every
 * event below is one the log already carried, appended from the same place in
 * the order — the caller's.
 *
 * ## The order, which is the part that has to be right
 *
 *   resolve the recipe from ~/.lingtai/     never from the repository, and it
 *                                           must name the registered base as its own
 *   resolve the environment                 a declared name with no value
 *                                           refuses here, before the money
 *   match the tier                          a runtime that cannot provide it is
 *                                           `DispatchRefused`, never a downgrade
 *   → the pass                              ten steps, and the claim is the first
 *   write the ending                        landed, blocked or failed — once,
 *                                           whichever of the four ways it ended
 *
 * **The refusals come first, deliberately.** Everything above the pass acquires
 * nothing, so a run that stops at an unreadable recipe or a missing environment
 * value has claimed nothing and provisioned no worktree to release — the lesson
 * 0024 recorded about where a scope *starts*.
 *
 * ## What the ports are, and what they are not
 *
 * Eight methods, and every one of them **wraps rather than reimplements**, which
 * is the `#226` rule `pass-steps.ts` is held to from the other side:
 *
 * ```
 * take      runnableNow + claimWorkItem      discover.ts, claim.ts
 * cut       repo.provision                   the worktree, as long as the pass
 * draft     nothing, and `""` is the answer   no cell is open at `design`
 * dispatch  the hook, the agent, the receipt  and a fix round, when a round was bought
 * judge     nothing, and `noJudge` is why     the schema refuses a `judge:` cell
 * land      repo.integrate                    the merge lane
 * readEnd   store.read                        the item's own stream
 * recordEnd store.append                      what `end` resolved, at that version
 * ```
 *
 * **Two of them answer *nothing is declared* and that is the truthful answer
 * rather than a stub.** `KINDS_AT.design` is `[]` and `whyNoKindAt` refuses a
 * `judge:` cell at all ten steps (`recipe.ts`), so neither a design nor a judge
 * can be written in a recipe today — a port that pretended otherwise would be
 * `#61`'s shape with the pieces swapped. What a direction with no judge costs is
 * `BUILT_IN_FOR`'s: `red` and `gate-failed` are mechanical and spend nothing,
 * and a person is the floor under the other three.
 *
 * ## Four things a run acquires, and one scope each
 *
 * The run log, the worktree, the hook socket and the agent process. The log and
 * the worktree are `Effect.acquireRelease` pairs **here**, because the pass is a
 * plain promise and cannot hold a scope: the worktree is *cut* by `admit`'s port
 * and released by this file's finalizer, which is 0039 §1's *the worktree is the
 * whole of a pass* expressed as a scope rather than as an ordering somebody
 * remembers. `repo.remove` takes no error channel and tolerates a worktree that
 * was never cut, so the finalizer is unconditional.
 *
 * The socket and the agent process keep their narrow scopes inside `dispatch`,
 * which is what an agent may not outlive.
 *
 * The log's release decides **keep or delete** — landed → delete, did not land →
 * keep ([0034](../../../doc/decisions/0034-the-run-log.md) §4) — so it is
 * acquired before the worktree and released after it, which is what one scope
 * and reverse order of acquisition give without anybody arranging it.
 *
 * ## Where the worktree's path comes from, and why it is not a fourth moving field
 *
 * `pass-steps.ts` left this open — *what does not travel is the worktree's path
 * into `ActionContext.cwd`* — and the answer is that it does not have to travel.
 * `worktreePath(home, project, runId)` is a pure function of three things this
 * file knows **before** the pass starts, and `provisionWorktree` cuts at exactly
 * that path. So `context.cwd` is the caller's for the whole pass, as
 * `PassOptions.context` says it is, and the skeleton keeps its three moving
 * fields.
 *
 * `context.onSha` starts empty, and that is honest rather than a placeholder:
 * nothing has been cut, `claim` and `admit` have no cell open so no plugin reads
 * it, and `admit` returns the base sha on its ending the moment there is one.
 *
 * ## Every exit appends
 *
 * A run that ends leaves either `RunFinished` or `RunFailed` — both, for a run
 * stopped at its turns, whose receipt is its spend — and a work item that does
 * not land is either released or blocked with a question. The pass says which of
 * the four outcomes was reached (`outcomeOf`) and never writes it; the three
 * blocks below are where it is written, once each.
 *
 * **And one ending stops the conductor rather than the item.** A `never-ran` met
 * something account-wide ([0031](../../../doc/decisions/0031-a-run-that-never-started.md)),
 * so the item is released like any other failure and `ctl-conductor` is told to
 * take nothing at all until the limit lifts — per-item backoff answering an
 * account-wide condition is what eighty events in ninety-two seconds looked like.
 */
import {
  backoffOf,
  baseDivergence,
  baseOf,
  limitsFor,
  parseDuration,
  submodulesOf,
  type ResolvedRecipe,
  type StepAction,
} from "@lingtai/recipe";
import { currentRecipe } from "./projects.ts";
import { type Tier, parsePayload, retiredRepairPending } from "@lingtai/domain";
import {
  type Action,
  type ActionEvent,
  actionsFromRecipe,
  createHumanAction,
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
import { fixBrief } from "./fix.ts";
import { agentBranch, armBranch } from "./branches.ts";
import { restartReason } from "./restart.ts";
import { type NeverStarted, standDown } from "./never-started.ts";
import { priorAttempts } from "./attempts.ts";
// The one composer, shared with the board. See `prompt.ts` for why it is not
// here any more.
import { nextPrompt, renderPrompt } from "./prompt.ts";
import {
  CONTROL_STREAM,
  type Step,
  type ToAppend,
  reduceControl,
  reduceWorkItem,
  workItemStream,
} from "@lingtai/domain";
import { runnableNow } from "./discover.ts";
import { resolveEndActions } from "./end-step.ts";
import { stepsResolved } from "./steps-resolved.ts";
import { labelsFor } from "./labels.ts";
import { tellGitHubAbout } from "./tell.ts";
import {
  type Ceilings,
  type PassResult,
  type StepReached,
  outcomeOf,
  runPass,
} from "./pass.ts";
import {
  type Brief,
  type Claimed,
  type Cut,
  type Drafted,
  type Judged,
  type Landed,
  type Landing,
  type PassPorts,
  type Taken,
  type Worked,
  bodiesFor,
} from "./pass-steps.ts";

import type { ProjectState } from "@lingtai/domain";
import { extensionEnv, productionPatterns, runnableEnv } from "@lingtai/agent-env";
import { stateDir } from "@lingtai/env";
import { worktreePath, type TokenSource, type Worktree } from "@lingtai/repo";
import { Data, Effect, Either } from "effect";
import { AgentHost, Repo } from "./ports.ts";
import { spawn } from "node:child_process";
import { RUN_LOG_END, runLogEnd, runLogPath } from "./run-log.ts";

export const changedFilesArgs = (baseSha: string): string[] => [
  "diff",
  "--name-only",
  "--no-renames",
  `${baseSha}...HEAD`,
];

/**
 * A refused `agent:`: the sentence both callers print, and **which** `agent:`
 * it was.
 *
 * The sentence is one for both places (#180). `at` is here because the remedy
 * is not: `runtime.agent` is written on this machine, in `machinePath()`, and a
 * step's `agent:` is written in the project's own recipe — so a caller that
 * offers one instruction for both refusals sends the operator to a line that is
 * already correct, and its project goes on taking nothing (`#245`). Which
 * `agent:` and which file to open are one fact, so they travel together rather
 * than being re-derived by reading the sentence.
 */
export interface AgentRefusal {
  /** Which `agent:` is wrong and what this conductor runs. */
  sentence: string;
  /** Where that `agent:` is written, which is the file whose line must change. */
  at: "runtime.agent" | "step";
}

/**
 * Why a resolved recipe will not run on the runtime a conductor dispatches, or
 * null when it will (#180).
 *
 * One sentence for both places that ask: `runOnce`, which refuses before its
 * claim, and `lingtai doctor`'s recipe row, which must not be `ok` for a
 * recipe every pass of which that refusal stops.
 *
 * **Every `agent:` in the file, not only `runtime.agent`** (`#245`). A step's
 * `agent:` is a runtime too since that ticket, and one conductor dispatches one
 * runtime — the gates are handed `options.runtime`, so a `review` action naming
 * the other one would have run its cold review on the dispatched one with
 * nothing anywhere saying the named runtime was not used. That is the silent
 * pick 0046 §3 refuses, one level down from where `runtime.agent` refuses it,
 * and it is answered the same way and in the same place: before the claim, by
 * name. Per-step dispatch is not built; until it is, the only honest answer to
 * a second runtime named at a step is to say so.
 */
export function agentRefusal(
  resolved: Pick<ResolvedRecipe, "recipe" | "provenance">,
  dispatched: string,
): AgentRefusal | null {
  const named = resolved.recipe.runtime.agent;
  if (named !== dispatched) {
    const from = resolved.provenance?.["runtime.agent"];
    return {
      at: "runtime.agent",
      sentence: `runtime.agent is ${named}${from ? ` (${from})` : ""}, and this conductor runs ${dispatched}`,
    };
  }
  for (const [step, actions] of Object.entries(resolved.recipe.steps)) {
    for (const action of actions) {
      if ("agent" in action && action.agent !== dispatched) {
        return {
          at: "step",
          sentence:
            `steps.${step}'s "${action.name}" action names agent ${action.agent}, ` +
            `and this conductor runs ${dispatched}`,
        };
      }
    }
  }
  return null;
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
  | { ok: "held"; workItemId: string; runId: string; headSha: string; step: string }
  | { ok: false; workItemId: string | null; runId: string | null; stage: string; detail: string };

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
 * What a pass left the tree at, read off the visits.
 *
 * `LeftTheTreeAt` is on an ending and the walk carries it forward, so the last
 * one any visit reported is the head every verdict after it was about — and the
 * head a person is shown on a card. Empty where nothing was cut.
 */
function headReached(steps: readonly StepReached[]): string {
  return steps.reduce<string>((sha, visit) => visit.ending.head ?? sha, "");
}

/**
 * The action a step named when it did not pass, or null where none did.
 *
 * `StepReport` includes `passed`, which carries no `at` — and a `null` `at` is
 * the step's *own* work having refused rather than a declared action, which
 * `pass-steps.ts` says at each of the bodies that set it.
 */
function whatRefused(stopped: PassResult["stoppedAt"]): string | null {
  if (stopped === null) return null;
  return "at" in stopped.ending ? stopped.ending.at : null;
}

/** What a step said when it did not pass, in the words a person reads (0043). */
function detailOf(ending: PassResult["stoppedAt"]): string {
  if (ending === null) return "";
  const said = ending.ending;
  if ("detail" in said) return said.detail;
  return "question" in said ? said.question : said.ending;
}

/**
 * One work item, claim through merge, on `pass.ts`.
 *
 * The name is unchanged because what it names is unchanged — *one pass* — and
 * `schedule.ts`, `apps/cli`'s `run` and `tally.ts` all hold it. What changed is
 * everything under it: the five gate points are ten steps, the sequence is
 * `runPass`'s, and this is the caller the pass was written to be called by.
 */
export function runOnce(
  options: RunOnceOptions,
): Effect.Effect<RunOnceResult, never, Repo | AgentHost> {
  return Effect.gen(function* () {
    // Asked for, not threaded through, which is the half of 0023 the `RunPorts`
    // parameter was standing in for.
    const repo = yield* Repo;
    const host = yield* AgentHost;

    const store = options.store ?? eventStore;
    const home = options.home ?? stateDir();
    const log = options.log ?? (() => {});
    const project = options.project.project!;
    const basePromptVersion = options.promptVersion ?? "ticket@1";

    /**
     * An append at whatever version the stream is at.
     *
     * A promise rather than an `Effect`, because the ports below are plain
     * promises (`pass-steps.ts`'s *Why plain promises*) and this is what they
     * append with. A store that will not append is a defect and not a refusal
     * this function can make on anyone's behalf: the handler at the bottom is
     * where defects are answered for.
     */
    const appendNow = async (stream: string, events: readonly ToAppend[]): Promise<void> => {
      const at = (await store.read(stream)).length;
      await store.append(stream, at, events);
    };

    // ---- 1. the recipe, from this machine -----------------------------------
    // `~/.lingtai/<project>/recipe.yml` (0046 §3, #180), the same read every
    // other command that conducts makes.
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
    // The ref the rules came from and the branch they say they govern have to be
    // one branch. It refuses rather than picking a winner: both are recorded
    // decisions, and nothing here repairs a recorded decision silently (0024 §3).
    const divergence = baseDivergence(resolved, `${options.client.owner}/${options.client.repo}`);
    if (divergence) {
      return { ok: false, workItemId: null, runId: null, stage: "recipe", detail: divergence };
    }
    // The agent the recipe resolved to is the agent that runs, or nothing runs
    // (0046 §3). Before the claim, for the same reason as the refusals around it.
    const wrongAgent = agentRefusal(resolved, options.runtime.capabilities.id);
    if (wrongAgent !== null) {
      return {
        ok: false,
        workItemId: null,
        runId: null,
        stage: "recipe",
        detail: `${wrongAgent.sentence} — nothing was claimed. Name ${options.runtime.capabilities.id} there to run with it; no other runtime is dispatched yet`,
      };
    }
    // Safe now, and only now: past the refusal these two are the same branch.
    const base = baseOf(recipe);
    const limits = limitsFor(recipe, "implement");
    log(`recipe ${resolved.configHash.slice(0, 12)} from ${resolved.ref}, tier ${resolved.tier}`);

    // ---- 2. the environment, before anything is claimed ---------------------
    // A declared name with no value refuses the whole project for this pass: no
    // worktree, no agent, no money. It used to be a log line, after which the
    // run claimed the ticket and spent $0.97 producing nothing against a
    // database it could not reach (0020).
    const asked = yield* Effect.either(
      host.resolveEnv({
        project,
        // All three, because all three are the recipe's: `required` refuses,
        // `allow`/`deny` filter (0021).
        required: recipe.env.required,
        allow: recipe.env.allow,
        deny: recipe.env.deny,
        patterns: productionPatterns(recipe.env.refuseHosts),
        home,
      }),
    );
    if (Either.isLeft(asked)) {
      return { ok: false, workItemId: null, runId: null, stage: "env", detail: asked.left.detail };
    }
    const env = asked.right;
    if (env.refusal) {
      return { ok: false, workItemId: null, runId: null, stage: "env", detail: env.refusal };
    }
    log(
      `env: ${env.names.length === 0 ? "nothing declared" : env.names.map((n) => `${n.name} from ${n.layer}`).join(", ")}`,
    );

    /**
     * The environment of one extension — every `run:` action's, and nothing
     * else's (0037 §1).
     *
     * Not `env.values`: that is the agent's, and handing it to a command is what
     * put one project's credential in every extension's process.
     */
    const envForExtension = (declared: readonly string[]): Record<string, string> =>
      runnableEnv(extensionEnv(env.merged, declared, productionPatterns(recipe.env.refuseHosts)).values);

    // The tripwire over every extension's declared values, here and not only
    // when `envForExtension` is first called: a denied production value would
    // otherwise first throw mid-run, past the claim, as a defect.
    const extensionRefusal = Either.try(() => {
      for (const step of Object.values(recipe.steps)) {
        for (const action of step) {
          if ("run" in action) extensionEnv(env.merged, action.env, productionPatterns(recipe.env.refuseHosts));
        }
      }
      for (const subscriber of recipe.subscribers) {
        extensionEnv(env.merged, subscriber.env, productionPatterns(recipe.env.refuseHosts));
      }
    });
    if (Either.isLeft(extensionRefusal)) {
      const detail =
        extensionRefusal.left instanceof Error
          ? extensionRefusal.left.message
          : String(extensionRefusal.left);
      return { ok: false, workItemId: null, runId: null, stage: "env", detail };
    }

    // ---- 3. capability matching, before anything is claimed -----------------
    const tier: Tier = resolved.tier;
    const missing = missingForTier(options.runtime.capabilities, tier);
    const workItemId = workItemStream(project, options.issue);

    if (missing.length > 0) {
      // Never silently downgrade. The refusal is an event on the work item so the
      // board can say why nothing ran.
      yield* Effect.promise(() =>
        appendNow(workItemId, [
          {
            type: "DispatchRefused",
            actor: "conductor",
            data: parsePayload("DispatchRefused", {
              requiredTier: tier,
              runtime: options.runtime.capabilities.id,
              missing,
            }),
          },
        ]),
      );
      return {
        ok: false,
        workItemId,
        runId: null,
        stage: "dispatch",
        detail: `${options.runtime.capabilities.id} cannot provide ${tier}: missing ${missing.join(", ")}`,
      };
    }

    const runId = `run-${crypto.randomUUID()}`;
    const branch = agentBranch(options.issue);
    /**
     * **Where the pass works, known before it starts.**
     *
     * `provisionWorktree` cuts at exactly this path, so `context.cwd` is the
     * caller's for the whole pass — see this file's opening. Nothing reads it
     * before `admit` has cut there: `claim` and `admit` have no cell open, so
     * there is no plugin to run in a directory that does not exist yet.
     */
    const cwd = worktreePath(home, project, runId);

    /**
     * The item's stream as it was before this claim, read once.
     *
     * Everything the prompt is composed from is read from it — the edit a person
     * left, a repair bought before `#143`, what the earlier attempts did — and
     * all of it for one reason (0032 §5): **the claim is what consumes them**, so
     * a read taken afterwards finds nothing and the edit silently never reaches
     * the agent. It is also where the restarts already spent are counted, which
     * is what `Ceilings.restartsLeft` is.
     */
    const before = yield* Effect.promise(() => store.read(workItemId));
    const folded = reduceWorkItem(before);
    const edit = folded.pendingPrompt;
    if (edit) log(`carrying a prompt edit from ${edit.by} (${edit.text.length} bytes)`);
    /**
     * A repair the old code bought, released, and never claimed — **only on a log
     * written before `#143`**. Honoured rather than dropped: it was bought
     * already, so honouring it spends nothing new.
     */
    const repairOf = retiredRepairPending(before);
    if (repairOf) {
      log(`repairing ${repairOf.reason} from ${repairOf.after} (attempt ${repairOf.attempt}), bought before #143`);
    }
    const previous = priorAttempts(before).at(-1);
    const lastRun = previous ? yield* Effect.promise(() => store.read(previous.runId)) : null;
    const next = nextPrompt({
      base: basePromptVersion,
      budget: recipe.runtime.budget,
      item: before,
      lastRun,
    });
    const promptVersion = next.version;
    if (previous) {
      log(`attempt ${next.attempt}: ${previous.runId} ended — ${previous.ended ?? "no ending recorded"}`);
    }
    const arm = armBranch(branch, next.attempt);

    /**
     * **What the back edges may spend** (0061 §3, and 0040's two dimensions).
     *
     * `rounds` bounds depth and `restartsLeft` bounds breadth, and the pass reads
     * both rather than asking anybody: `onOffer` puts `implement` on the offer
     * while rounds are left and `claim` while restarts are, and offers neither
     * once they are spent. That is the whole of *the workflow counts, the judge
     * chooses* — which is why `decideFix` and `decideRestart` are no longer
     * consulted here. What each of them decided is now either the ceiling's
     * arithmetic or the judge's answer, and neither is a second opinion this file
     * is entitled to.
     */
    const ceilings: Ceilings = {
      rounds: limits.rounds,
      restartsLeft: Math.max(0, limits.restarts - folded.restarts.length),
    };

    let released = false;
    /**
     * How a run that did not land gives the item back.
     *
     * **One way, and `#143` is what made it one.** The item returns to the queue
     * and the backoff decides when it is seen again. The `end` step has already
     * resolved its declared effects against `failed` by the time this runs — the
     * pass ran it, on every ending — so this does not resolve them again, and
     * `resolveEndActions`'s once-per-outcome rule would refuse it if it tried.
     */
    const release = (reason: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (released) return Effect.void;
        released = true;
        return Effect.tryPromise({
          try: async () => {
            await releaseWorkItem(workItemId, runId, reason, store).catch(() => {});
            await tellGitHubAbout({
              store,
              github: options.client,
              workItemId,
              labels: labelsFor("queued"),
            });
          },
          catch: (err) => err,
        }).pipe(
          // A release is the last thing a failing run does, and one that threw
          // would replace the reason the run ended with the reason the cleanup did.
          Effect.ignore,
        );
      });

    /**
     * The conductor stops, because the item backing off is the wrong instrument
     * (0031 §3).
     *
     * **Once, not once per item.** A pause already holding is left exactly as it
     * is, which is also what keeps this from overwriting a pause a person made: a
     * person's pause has no expiry (0031 §5).
     */
    const standDownConductor = (what: NeverStarted, detail: string): Effect.Effect<void> =>
      Effect.promise(async () => {
        const it =
          what.of === "run"
            ? "a run"
            : what.of === "step"
              ? `the ${what.step} step's agent`
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
          backoffMs: parseDuration(backoffOf(recipe)),
        });
        await store.append(CONTROL_STREAM, events.length, [
          {
            type: "ConductorPaused",
            actor: "conductor",
            data: parsePayload("ConductorPaused", {
              by: "lingtai",
              reason,
              until: until.toISOString(),
            }),
          },
        ]);
        log(`${it} never started — conductor paused until ${until.toISOString()}`);
      }).pipe(
        // A pause that would not append must not replace the reason the run ended
        // with the reason the pause failed.
        Effect.catchAllDefect((defect) =>
          Effect.sync(() =>
            log(`could not pause the conductor: ${defect instanceof Error ? defect.message : String(defect)}`),
          ),
        ),
      );

    /**
     * The outermost scope, and it is the log's (0034 §4).
     *
     * It is wider than the socket's and the agent's because what closes it has to
     * know something neither of them does: **whether the run landed**. It is
     * wider than the worktree's too, and only just — since 0039 §1 the worktree
     * lives as long as the pass, so the two release in order, worktree then log,
     * without anybody arranging it.
     */
    const claimed = Effect.gen(function* () {
      /**
       * Whether this run's diff reached the base branch. Set in exactly one
       * place, beside the `WorkItemLanded` append, which is the only sentence
       * here that means it.
       */
      let didLand = false;
      /**
       * The merge commit the lane produced, for the caller's `ok: true`.
       *
       * Read through `landedAt()` and not off the variable: `land` is a port and
       * the compiler cannot see that it ran, so narrowing the `let` at the read
       * would make it `never`.
       */
      let mergeCommit: string | null = null;
      const landedAt = (): string | null => mergeCommit;
      /** The tree, once `admit`'s port has cut it. */
      let worktree: Worktree | null = null;
      /** The item, once `claim`'s port has taken it. */
      let took: Claimed | null = null;
      /** What `end` resolved, so the issue is told what the item recorded. */
      let endResolved: readonly ToAppend[] = [];
      /**
       * The turn limit's own words, where that is what stopped the agent.
       *
       * The pass reports an agent that ran out of turns as a `did-not-finish` and
       * says nothing about *why* it did not finish — `Worked`'s `Stopped` is one
       * string. The limit is a **scope alarm** and the recommendation that follows
       * from it is *narrow or split the ticket*, which is different from every
       * other way a dispatch can stop, so the distinction is kept here rather
       * than pushed into a vocabulary the pass would then have to carry.
       */
      let turnLimit: string | null = null;

      /**
       * The run's log, and the keep-or-delete that ends it.
       *
       * **Landed → delete. Did not land → keep.** The diff is on the branch and
       * the events are on the log, so what an agent was thinking during a run
       * that worked has the least marginal value of anything here. A log that
       * could not be opened is `NO_RUN_LOG` rather than a refusal: the
       * observability of a run is not worth failing it for.
       */
      const runLog = yield* Effect.acquireRelease(
        host.runLog({ path: runLogPath(home, project, runId) }).pipe(
          Effect.catchAll((err) =>
            Effect.sync(() => {
              log(`no run log: ${err.detail}`);
              return NO_RUN_LOG satisfies RunLog;
            }),
          ),
        ),
        (opened) =>
          Effect.promise(async () => {
            // The sentence, and the label a reader recognises it by: `#110`
            // follows this from another process and has nothing else to tell *the
            // writer has finished* from *the writer is thinking*.
            opened.note(RUN_LOG_END, runLogEnd(didLand));
            await opened.close(didLand ? "delete" : "keep");
          }),
      );
      runLog.note("run", `${runId} · ${workItemId} · ${branch} → ${base}`);

      /**
       * **The worktree's release, and it is unconditional** (0039 §1).
       *
       * `admit`'s port cuts it, which is inside the pass and therefore inside a
       * plain promise that cannot hold a scope — so the release is here, in the
       * run's own scope, acquired after the log and released before it.
       * `repo.remove` has no error channel and tolerates a path nothing cut, so
       * there is nothing to branch on: a pass that never reached `admit` releases
       * a worktree that was never there, which is a no-op and is cheaper than a
       * flag somebody has to keep true.
       */
      yield* Effect.addFinalizer(() => repo.remove({ project, runId, home }));

      /** A git command in the worktree, which is where all of them run. */
      const gitHere = (args: string[]) =>
        repo.git(args, { token: options.token, env: options.gitEnv, cwd });
      /** …as a promise, for the ports. A failure here is a defect, not a verdict. */
      const gitOrDie = (args: string[]) => Effect.runPromise(Effect.orDie(gitHere(args)));
      const gitAsked = (args: string[]) => Effect.runPromise(Effect.either(gitHere(args)));

      const baseShaOr = (fallback: string) => worktree?.baseSha ?? fallback;

      const numstat = async () => {
        const stat = await gitOrDie(["diff", "--numstat", `${baseShaOr("HEAD")}..HEAD`]).catch(
          () => "",
        );
        const rows = stat.split("\n").filter(Boolean).map((l) => l.split("\t"));
        return {
          files: rows.length,
          insertions: rows.reduce((n, r) => n + (Number(r[0]) || 0), 0),
          deletions: rows.reduce((n, r) => n + (Number(r[1]) || 0), 0),
        };
      };

      /**
       * What origin last had for this branch, as far as this pass knows. Starts
       * as what it had when the worktree was cut and moves to whatever this pass
       * pushed: a lease that does not move is a lease this pass breaks itself on
       * its second round.
       */
      let lease: string | null = null;
      /** The head this pass has already published, so nothing pushes it twice. */
      let published: string | null = null;
      /**
       * What the run's own stream has already been told this claim produced, as
       * `<ref>@<head>`. A key and not a flag, because `arm-only` corrects an
       * answer an earlier call has already given (`#251`).
       */
      let recordedDiff: string | null = null;
      const producedKey = (ref: string, head: string) => `${ref}@${head}`;

      const whyOf = (defect: unknown) =>
        defect instanceof Error ? defect.message : String(defect);

      /**
       * **The account of the publish, on the log rather than only in the file**
       * (`#251`). `#250` met the wall with two commits in its worktree, left
       * neither ref on origin, and was collected — $26.84 recovered from
       * unreachable git objects by luck, because four different things wrote the
       * same nothing.
       *
       * **The account never costs the thing it is an account of**: a store that
       * will not take this row is swallowed, because raising it would abort the
       * `RunProducedDiff` below, and a ref nobody will fetch is worse than a
       * missing explanation of a ref that is there.
       */
      const noteRefs = async (
        outcome:
          | "published"
          | "nothing-committed"
          | "already-published"
          | "arm-only"
          | "refused"
          | "unrecorded",
        headSha: string | null,
        detail: string | null,
      ): Promise<void> => {
        try {
          await appendNow(runId, [
            {
              type: "RunRefsPublished",
              actor: "conductor",
              data: parsePayload("RunRefsPublished", { branch, arm, headSha, outcome, detail }),
            },
          ]);
        } catch (defect) {
          const why = whyOf(defect);
          runLog.note("push", `the account of ${outcome} was not appended — ${why}`);
          log(`RunRefsPublished (${outcome}) was refused by the store: ${why}`);
        }
      };

      /**
       * The counts, against the ref that actually holds them — so the next
       * attempt's brief says how much is there rather than only that something is.
       *
       * **The ref is a parameter and not `branch`**, because `arm-only` exists.
       * **Asked for twice within one call** (`#252`): a store that drops its
       * connection on this one row is the disconnect CLAUDE.md documents, arriving
       * on the row `attemptBrief` reads and nothing else does. Twice and not until
       * it works — a finalizer that will not finish holds the worktree, and with
       * it the commits, against every later attempt.
       */
      const recordDiff = async (ref: string, head: string): Promise<void> => {
        if (recordedDiff === producedKey(ref, head)) return;
        const counted = await numstat();
        const row: ToAppend = {
          type: "RunProducedDiff",
          actor: "conductor",
          data: parsePayload("RunProducedDiff", { branch: ref, headSha: head, ...counted }),
        };
        try {
          await appendNow(runId, [row]);
        } catch (first) {
          try {
            await appendNow(runId, [row]);
          } catch (again) {
            const why = `${whyOf(first)}, and again — ${whyOf(again)}`;
            runLog.note(
              "push",
              `${ref} at ${head.slice(0, 7)} is on origin and was not recorded — ${why}`,
            );
            log(`RunProducedDiff (${ref}) was refused by the store twice: ${why}`);
            await noteRefs("unrecorded", head, `${ref} — ${why}`);
            return;
          }
        }
        // After the append and never before it (`#251`): a key set in advance
        // marks the answer given by the append that did not give it.
        recordedDiff = producedKey(ref, head);
      };

      /**
       * **What this claim leaves behind, whatever ending it had** (0062 §1).
       *
       * A worktree is cut `--force --detach` and removed when this scope closes,
       * so commits the agent made and nothing pushed go with it. `#237` made 36
       * edits, committed none and pushed nothing; this is the half the conductor
       * owns. **An ending with no commits publishes nothing** — a ref to an empty
       * branch is a worse lie than the absence.
       */
      const publishWhatIsCommitted = async (): Promise<string | null> => {
        if (worktree === null) return null;
        const tree = worktree;
        try {
          const at = await gitAsked(["rev-parse", "HEAD"]);
          if (Either.isLeft(at)) {
            runLog.note("push", `${branch} was not pushed — ${at.left.detail}`);
            await noteRefs("refused", null, at.left.detail);
            return at.left.detail;
          }
          const head = at.right;
          if (head === tree.baseSha) {
            runLog.note("push", `nothing to push — ${branch} is still at the base`);
            await noteRefs("nothing-committed", null, null);
            return null;
          }
          if (head === published) {
            await noteRefs("already-published", head, null);
            // And the record is asked for again (`#251`): a store that was down
            // for the earlier attempts may be up by the time the scope unwinds.
            await recordDiff(branch, head);
            return null;
          }
          const pushed = await gitAsked([
            "push",
            `--force-with-lease=refs/heads/${branch}:${lease ?? ""}`,
            "origin",
            `HEAD:refs/heads/${branch}`,
            `+HEAD:refs/heads/${arm}`,
          ]);
          if (Either.isLeft(pushed)) {
            // **One exit code for two refspecs, so a failure is asked which**
            // (`#251`). `git push` is not atomic: origin takes the forced arm,
            // rejects the leased `agent/<n>`, and exits non-zero with the commits
            // on origin. Forced and at the same head, this second push is a no-op
            // where the arm already went and fails again where the transport broke.
            const armAlone = await gitAsked(["push", "origin", `+HEAD:refs/heads/${arm}`]);
            if (Either.isRight(armAlone)) {
              runLog.note(
                "push",
                `${branch} was not pushed — ${pushed.left.detail}; ${arm} at ${head.slice(0, 7)} is on origin`,
              );
              await noteRefs("arm-only", head, pushed.left.detail);
              await recordDiff(arm, head);
              return pushed.left.detail;
            }
            runLog.note("push", `${branch} was not pushed — ${pushed.left.detail}`);
            await noteRefs("refused", head, pushed.left.detail);
            return pushed.left.detail;
          }
          lease = head;
          published = head;
          runLog.note("push", `${branch} and ${arm} at ${head.slice(0, 7)}`);
          await noteRefs("published", head, null);
          await recordDiff(branch, head);
          return null;
        } catch (defect) {
          const why = whyOf(defect);
          runLog.note("push", `the publish itself failed — ${why}`);
          await noteRefs("refused", null, why);
          return why;
        }
      };

      yield* Effect.addFinalizer(() =>
        didLand ? Effect.void : Effect.promise(publishWhatIsCommitted),
      );

      // ---- the ports ---------------------------------------------------------
      // Eight methods, and every one of them wraps rather than reimplements —
      // `pass-steps.ts`'s own rule, read from this side.

      /**
       * `claim` — whether this machine may take the item, and taking it.
       *
       * **Eligibility is asked, not looked up.** Nothing was appended when this
       * issue was first seen (0012), so there is no *was it discovered* to read:
       * the recipe decides against the issue as GitHub reports it right now, which
       * is also the only way a label edit takes effect without a second mechanism.
       *
       * The four answers are `Taken`'s, and the fourth is the one worth naming:
       * `claimWorkItem` answers a `ConcurrencyError` with `lost-race` and
       * **throws** every other failure, including an append that committed and
       * then lost its connection. Reported as `mayHold` rather than let escape, so
       * the pass stops with the item named and `end` resolves against the stream
       * it may be on.
       */
      const take = async (): Promise<Taken> => {
        const found = await runnableNow({ client: options.client, recipe, only: [options.issue] });
        const runnable = found.runnable.find((r) => r.ref === String(options.issue));
        if (!runnable) {
          return {
            passedOver:
              found.skipped.find((s) => s.ref === options.issue)?.reason ?? "not runnable",
          };
        }
        // The ticket, fetched once, before anything that reads it: the
        // implementer's brief and the cold reviewer both want it, and a run still
        // costs one call for it.
        const issue = await options.client.getIssue(options.issue);
        let claim;
        try {
          // The claim carries what the task is, because it is now the only place a
          // title enters the log at all.
          claim = await claimWorkItem(workItemId, {
            runId,
            store,
            title: runnable.title,
            kind: runnable.kind,
          });
        } catch (error) {
          return { mayHold: { workItemId, detail: whyOf(error) } };
        }
        if (!claim.ok) return { notClaimed: JSON.stringify(claim.refusal) };
        log(`claimed ${workItemId} as ${runId}`);
        took = {
          workItemId,
          kind: runnable.kind,
          ticket: { ref: String(issue.number), title: issue.title, body: issue.body },
        };
        // The issue says what the log says, from here on. Inline rather than
        // queued (0022): a call that does not land is written down and converged
        // later rather than retried.
        await tellGitHubAbout({
          store,
          github: options.client,
          workItemId,
          labels: labelsFor("running"),
        });
        return { taken: took };
      };

      /**
       * `admit` — cut the worktree, at the base the recipe names.
       *
       * The path is `cwd`, computed before the pass: see this file's opening. A
       * clone that did not finish is not a judgement about the change — nothing
       * has been written yet — so it is `notCut`, which the body reports as 0057's
       * class rather than as a refusal buying a round to fix a repository.
       */
      const cut = async (_claimed: Claimed): Promise<Cut> => {
        const provisioned = await Effect.runPromise(
          Effect.either(
            repo.provision({
              project,
              owner: options.client.owner,
              repo: options.client.repo,
              base,
              branch,
              runId,
              submodules: submodulesOf(recipe),
              plantAt: recipe.env.plantAt,
              env: env.values,
              token: options.token,
              home,
              remote: options.remote,
              gitEnv: options.gitEnv,
            }),
          ),
        );
        if (Either.isLeft(provisioned)) return { notCut: provisioned.left.detail };
        worktree = provisioned.right;
        lease = provisioned.right.remoteHead;
        log(`worktree ${provisioned.right.path} at ${provisioned.right.baseSha.slice(0, 7)}`);
        return { worktree: provisioned.right };
      };

      /**
       * `design` — **nothing, and `""` is the answer rather than a stub** (0058 §3).
       *
       * `KINDS_AT.design` is `[]` and `whyNoKindAt` refuses every kind there by
       * name, so a design cannot be declared in a recipe and no code writes one.
       * The step still runs and still reports, which is the point: *does this need
       * designing* is answered by the step returning an empty document, and
       * `implement` works from the issue — no conditional step, no skip. T9 is the
       * ticket that gives this port a body, and the day it does, nothing in the
       * pass changes.
       */
      const draft = async (): Promise<Drafted> => ({ document: "" });

      /**
       * `proposed` — **nothing, and `noJudge` is the truthful answer** (0061 §3).
       *
       * `judge:` is one of the five columns `KINDS_AT` carries at no step, and
       * `whyNoKindAt` refuses the cell at all ten: the recipe *schema* rejects a
       * `judge:` entry, so there is no declared judge for this to resolve. What
       * follows is what the body does with it — `BUILT_IN_FOR` answers `red` and
       * `gate-failed` mechanically and spends nothing, and a person is the floor
       * under `conflict`, `needs-input` and `findings`. So the floor `#253` set
       * holds, and no agent is paid to reach a conclusion a `switch` reaches.
       */
      const judge = async (): Promise<Judged> => ({ noJudge: true });

      /** `end` — the work item's own stream, read this late on purpose. */
      const readEnd = (stream: string) => store.read(stream);

      /**
       * `end` — what the step resolved, at the version the read gave.
       *
       * The append and nothing else. The plan is kept so the issue can be told
       * what the item recorded: `tellGitHubAbout` reads `EndActionsResolved` out of
       * what was appended rather than out of the stream, which is the same list.
       */
      const recordEnd = async (stream: string, at: number, plan: readonly ToAppend[]) => {
        await store.append(stream, at, plan);
        endResolved = plan;
      };

      // The cold reviewer's own settings, with no hook in them. `wiring`'s
      // settings and `wiring.env` are one thing and the `agent` gate had only the
      // first, so the hook refused the reviewer's opening prompt and every review
      // returned that refusal instead of findings.
      const reviewSettingsPath = yield* writeUnhookedSettingsEffect(runId, "review", home).pipe(
        Effect.orDie,
      );

      /**
       * What a declared plugin needs in order to run — the three things only a
       * caller with a machine under it can build (`PassOptions.actionsAt`).
       *
       * A reviewer, the diff's file list and an environment resolver. This is
       * `stepDeps` under its old name, unchanged: turning a declared list into a
       * runnable action is neither the sequence nor the outcome rules, so by 0058
       * §2b it is the caller's and not the pass's.
       */
      const stepDeps = {
        env: envForExtension,
        agent: {
          runtime: options.runtime,
          issue: async () => took?.ticket ?? { ref: String(options.issue), title: "", body: "" },
          diff: () => gitOrDie(["diff", `${baseShaOr("HEAD")}...HEAD`]),
          settingsPath: reviewSettingsPath,
          limits: {
            turns: limits.turns,
            wallMs: parseDuration(limits.wall),
            diffBytes: recipe.runtime.budget.diff,
          },
        },
        watch: {
          changedFiles: async () => {
            const names = await gitOrDie(changedFilesArgs(baseShaOr("HEAD")));
            return names.split("\n").filter(Boolean);
          },
        },
      };

      /**
       * **`--no-merge`, and a repair bought before `#143`, as the `human:` action
       * they always were.**
       *
       * This is not a second mechanism (#20). Both ask for the same
       * `ApprovalRequested` a declared `human:` at `merge` asks for, and the way to
       * ask for it is to be one: `runActionPipeline` emits the event for a
       * `needs-approval` verdict, `endingOf` reads it as `held`, the pass stops,
       * and `outcomeOf` says `blocked`. A recipe that declares nothing at `merge`
       * still holds under the flag; one that declares a person there holds whether
       * or not the flag was passed. And the hold is bound to `onSha` like any other
       * verdict, so a force-push invalidates it by arithmetic.
       *
       * Appended after the declared list, which is where the old loop asked: the
       * recipe's own actions run first and the flag holds what they let past.
       */
      const alsoHeldAtMerge = (): Action[] => {
        const held: Action[] = [];
        if (repairOf !== null) {
          held.push(
            createHumanAction({
              name: "repair",
              question: `A repair for ${repairOf.reason}. Merge ${branch} into ${base}?`,
            }),
          );
        }
        if (options.merge === false) {
          held.push(
            createHumanAction({
              name: "no-merge",
              question: `Merge ${branch} into ${base}? Every step passed, and this run was asked not to merge.`,
            }),
          );
        }
        return held;
      };

      const actionsAt = (step: Step, actions: readonly StepAction[]): readonly Action[] => {
        const declared = actionsFromRecipe(step, actions, stepDeps);
        return step === "merge" ? [...declared, ...alsoHeldAtMerge()] : declared;
      };

      /**
       * Every event the pipeline produces, in order, before the next action starts.
       *
       * On the run's own stream, which is where every verdict has always gone. The
       * pipeline does not touch the store and neither does the pass, for the reason
       * `PipelineOptions` gives — *an action that ran but whose verdict was never
       * recorded is the failure this design exists to remove.*
       */
      const emit = async (event: ActionEvent): Promise<void> => {
        await appendNow(runId, [
          {
            type: event.type,
            actor: "conductor",
            data: parsePayload(event.type, event.data),
          } as ToAppend,
        ]);
      };

      /**
       * `implement`, the first time — the hook, the agent, and the receipt.
       *
       * Three ways not to pass and the money is why they are three (0057 §2, 0031
       * §3): **asked** buys a decision at `proposed`; **started and left no
       * receipt** buys nothing and stands the pass down, the commit being the
       * receipt; **never started** stands the *conductor* down, because what it met
       * is about the account rather than the diff.
       *
       * **The hook is proven to fail closed before anything is dispatched.** A hook
       * that fails *open* records nothing and says nothing, which is the one failure
       * the whole hook exists to prevent. A hook that will not is reported as a
       * `did-not-finish` rather than released back to the queue: it is a fact about
       * this machine, and another pass meets it identically — so the honest answer
       * is a person, not the queue.
       */
      const firstDispatch = async (brief: Brief): Promise<Worked> => {
        const tree = brief.worktree;
        const wired = await Effect.runPromise(
          Effect.either(host.wire({ runId, hookBinary: options.hookBinary, home })),
        );
        if (Either.isLeft(wired)) return { stopped: `the hook was not wired: ${wired.left.detail}` };
        const wiring = wired.right;

        const smoke = await Effect.runPromise(
          Effect.either(host.smokeTest(options.hookBinary, runBinary)),
        );
        if (Either.isLeft(smoke)) {
          return { stopped: `the hook's smoke test did not run: ${smoke.left.detail}` };
        }
        if (!smoke.right.ok) return { stopped: `the hook did not fail closed: ${smoke.right.detail}` };

        const spend = { turns: limits.turns, wallMs: parseDuration(limits.wall) };
        const agentEnv = runnableEnv({ ...env.values, ...wiring.env });
        const spawned = options.runtime.invocation?.({
          runId,
          cwd: tree.path,
          settingsPath: wiring.settingsPath,
          env: agentEnv,
          limits: spend,
        });

        const ran = await Effect.runPromise(
          Effect.either(
            Effect.scoped(
              Effect.gen(function* () {
                const server = yield* host.serve({
                  socketPath: wiring.socketPath,
                  store,
                  onDecision: (_r, hook, verdict, call) =>
                    runLog.note(
                      call.tool === "" ? hook : call.tool,
                      `${verdict.padEnd(6)}${call.target}`,
                    ),
                  onLifecycle: (_r, hook) => runLog.note("hook", hook),
                });

                yield* Effect.promise(() =>
                  appendNow(runId, [
                    {
                      type: "RunStarted",
                      actor: "conductor",
                      data: parsePayload("RunStarted", {
                        workItemId,
                        runtime: options.runtime.capabilities.id,
                        model: "",
                        promptVersion,
                        baseSha: tree.baseSha,
                        configHash: resolved.configHash,
                        worktree: tree.path,
                        invocation: spawned
                          ? { command: spawned.command, args: [...spawned.args], tier, limits: spend }
                          : null,
                      }),
                    },
                  ]),
                );
                yield* Effect.promise(() =>
                  appendNow(runId, [
                    {
                      type: "GatesResolved",
                      actor: "conductor",
                      data: parsePayload("GatesResolved", stepsResolved(runId, resolved)),
                    },
                  ]),
                );

                yield* Effect.acquireRelease(
                  Effect.promise(async () =>
                    server.register(runId, (await store.read(runId)).length, promptVersion),
                  ),
                  () => Effect.sync(() => void server.unregister(runId)),
                );

                const abort = yield* Effect.acquireRelease(
                  Effect.sync(() => new AbortController()),
                  (controller) => Effect.sync(() => controller.abort()),
                );

                const outcome = yield* Effect.promise(() =>
                  options.runtime.run({
                    runId,
                    cwd: tree.path,
                    prompt: renderPrompt(
                      options.prompt,
                      { number: Number(brief.ticket.ref), title: brief.ticket.title, body: brief.ticket.body },
                      next.failure,
                    ),
                    settingsPath: wiring.settingsPath,
                    log: runLog,
                    env: agentEnv,
                    limits: spend,
                    signal: abort.signal,
                  }),
                );
                yield* Effect.promise(() => server.flush(runId).catch(() => {}));
                return { outcome, version: server.get(runId)?.version ?? 1 };
              }),
            ),
          ),
        );
        if (Either.isLeft(ran)) {
          return { stopped: `the hook socket was not served: ${ran.left.detail}` };
        }
        const { outcome, version } = ran.right;

        if (outcome.failure) {
          runLog.note("run", `failed — ${outcome.failure.kind}: ${outcome.failure.detail}`);
          // **Both, for a run stopped at its turns, whose receipt is its spend.**
          // A `RunFinished` there is not a contradiction: turns were taken and
          // money was spent, and the ending is what `RunFailed` says.
          const receipt: ToAppend[] =
            outcome.failure.kind === "out-of-turns"
              ? [
                  {
                    type: "RunFinished",
                    actor: "conductor",
                    data: parsePayload("RunFinished", {
                      exitCode: outcome.exitCode ?? 1,
                      turns: outcome.turns,
                      durationMs: outcome.durationMs,
                      costUsd: outcome.costUsd,
                    }),
                  },
                ]
              : [];
          await store.append(runId, version, [
            ...receipt,
            {
              type: "RunFailed",
              actor: "conductor",
              data: parsePayload("RunFailed", outcome.failure),
            },
          ]);
          if (outcome.failure.kind === "never-started") {
            return {
              neverStarted: {
                agent: options.runtime.capabilities.id,
                detail: outcome.failure.detail,
              },
            };
          }
          if (outcome.failure.kind === "out-of-turns") turnLimit = outcome.failure.detail;
          return { stopped: `${outcome.failure.kind}: ${outcome.failure.detail}` };
        }

        await store.append(runId, version, [
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
        ]);
        log(`run finished: ${outcome.turns} turns, ${outcome.costUsd ?? "unknown"} usd`);
        runLog.note("run", `finished: ${outcome.turns} turns, ${outcome.costUsd ?? "unknown"} usd`);

        const head = await gitOrDie(["rev-parse", "HEAD"]);
        // **The commit is the receipt** (0057 §2). An agent that ran and committed
        // nothing left none, and the pass stops rather than buying a round to fix
        // a diff that does not exist.
        if (head === tree.baseSha) return { stopped: "the agent produced no commits" };
        await recordDiff(branch, head);
        await appendNow(runId, [
          {
            type: "RunProposedCompletion",
            actor: "conductor",
            data: parsePayload("RunProposedCompletion", { headSha: head }),
          },
        ]);
        return { committed: head };
      };

      /**
       * `implement`, a second time — **and the round was already bought.**
       *
       * `proposed` decided this, `onOffer` had already counted, and neither
       * decision is re-made here: what arrives is `Brief.again`, which is the
       * judge's own words plus the criterion the round was bought on. `fixBrief` is
       * what turns that into a prompt, unchanged, and the three shapes it takes are
       * read off the arrival rather than off a `FixOn` somebody passed down —
       * findings on `context.recheck` (0038 §2), the lane's paths from a `merge`
       * that refused, and a command's own output for everything else.
       *
       * `FixRequested` and `FixApplied` are the events the board already reads, so
       * they are appended here, from the step that spends the round.
       */
      const fixRound = async (brief: Brief, again: NonNullable<Brief["again"]>): Promise<Worked> => {
        const tree = brief.worktree;
        const round = brief.context.round ?? 1;
        const findings = brief.context.recheck ?? [];
        const from = again.printed?.step ?? "proposed";
        const said = again.printed?.detail ?? again.asked ?? again.why;
        const refusal =
          findings.length > 0
            ? ({ on: "findings", findings } as const)
            : from === "merge"
              ? ({ on: "conflict", base, paths: said } as const)
              : ({ on: "output", output: said } as const);

        await appendNow(runId, [
          {
            type: "FixRequested",
            actor: "conductor",
            data: parsePayload("FixRequested", {
              runId,
              round,
              of: limits.rounds,
              action: from,
              onSha: brief.context.onSha,
              findings,
            }),
          },
        ]);
        log(`fixing ${from} — round ${round} of ${limits.rounds}`);
        runLog.note("fix", `round ${round} for ${from}`);

        const settings = await Effect.runPromise(
          Effect.either(writeUnhookedSettingsEffect(runId, `fix-${round}`, home)),
        );
        if (Either.isLeft(settings)) {
          return { stopped: `the fixing agent had no settings: ${settings.left.detail}` };
        }

        const underReview = await gitOrDie(["diff", `${tree.baseSha}...HEAD`]);
        const fixed = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const abort = yield* Effect.acquireRelease(
                Effect.sync(() => new AbortController()),
                (controller) => Effect.sync(() => controller.abort()),
              );
              return yield* Effect.promise(() =>
                options.runtime
                  .run({
                    runId: `${runId}:fix:${round}`,
                    cwd: tree.path,
                    prompt: fixBrief({
                      refusal,
                      round,
                      of: limits.rounds,
                      action: from,
                      diff: underReview,
                      diffBytes: recipe.runtime.budget.diff,
                    }),
                    settingsPath: settings.right,
                    log: taggedTrace(runLog, `fix:${round}`),
                    traceTools: true,
                    env: runnableEnv(env.values),
                    limits: { turns: limits.turns, wallMs: parseDuration(limits.wall) },
                    signal: abort.signal,
                  })
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
            }),
          ),
        );

        const after = await gitOrDie(["rev-parse", "HEAD"]);
        const committed = after !== brief.context.onSha;

        await appendNow(runId, [
          {
            type: "FixApplied",
            actor: "conductor",
            data: parsePayload("FixApplied", {
              runId,
              round,
              headSha: committed ? after : null,
              turns: fixed.turns,
              costUsd: fixed.costUsd,
              failure: fixed.failure ? `${fixed.failure.kind}: ${fixed.failure.detail}` : null,
            }),
          },
        ]);
        runLog.note(
          "fix",
          `round ${round}: ${committed ? after.slice(0, 7) : "no commit"}` +
            ` · ${fixed.turns} turns, ${fixed.costUsd ?? "unknown"} usd` +
            (fixed.failure ? ` · ${fixed.failure.kind}` : ""),
        );

        if (fixed.failure?.kind === "never-started") {
          return {
            neverStarted: { agent: options.runtime.capabilities.id, detail: fixed.failure.detail },
          };
        }
        if (!committed) {
          return {
            stopped: fixed.failure
              ? `the fixing agent did not finish (${fixed.failure.kind}: ${fixed.failure.detail}), ` +
                "so there is nothing new for the review to read"
              : "the fixing agent committed nothing, so there is nothing new for the review to read",
          };
        }
        await recordDiff(branch, after);
        return { committed: after };
      };

      const dispatch = (brief: Brief): Promise<Worked> =>
        brief.again === null ? firstDispatch(brief) : fixRound(brief, brief.again);

      /**
       * `merge` — the branch on the remote, then the lane.
       *
       * The push is here rather than beside the agent because this is the point at
       * which the head has been judged: the steps before it all passed on
       * `context.onSha`, and pushing it is how the lane and a person get to see the
       * thing that was judged. Every other ending publishes from the finalizer.
       *
       * **The lane reports and decides nothing.** `stepsPassed` is `true` without
       * being asked, and that is the sequence rather than an assumption: `merge` is
       * reached only where every step before it passed, so a lane told otherwise
       * would be a lane told something the pass cannot be in a position to say.
       */
      const land = async (on: Landing): Promise<Landed> => {
        const pushed = await gitAsked([
          "push",
          `--force-with-lease=refs/heads/${branch}:${lease ?? ""}`,
          "origin",
          `HEAD:refs/heads/${branch}`,
        ]);
        if (Either.isLeft(pushed)) {
          return { notMerged: { reason: "push-rejected", detail: pushed.left.detail } };
        }
        lease = on.context.onSha;
        published = on.context.onSha;

        const result = await Effect.runPromise(
          repo.integrate({
            project,
            owner: options.client.owner,
            repo: options.client.repo,
            base,
            branch,
            workItemId,
            headSha: on.context.onSha,
            stepsPassed: true,
            token: options.token,
            home,
            gitEnv: options.gitEnv,
            store,
          }),
        );
        if (result.ok) {
          mergeCommit = result.mergeCommit;
          return { merged: result.mergeCommit };
        }
        return { notMerged: { reason: result.reason, detail: result.detail } };
      };

      const ports: PassPorts = { take, cut, draft, dispatch, judge, land, readEnd, recordEnd };

      // ---- the pass ----------------------------------------------------------
      // Ten steps, and the claim is the first of them. Everything above this line
      // is refusals that cost nothing and state the pass will need; everything
      // below it is the ending, written once.
      const pass = yield* Effect.promise(() =>
        runPass({
          recipe,
          /**
           * What the walk starts from. `cwd` and `env` are the pass's throughout;
           * `onSha` is empty until `admit` has something to report, `round` starts
           * at zero and `recheck` at nothing, and the loop rebuilds all three per
           * visit (`contextFor`).
           */
          context: { runId, onSha: "", cwd, env: runnableEnv(env.values), log: runLog },
          emit,
          actionsAt,
          bodies: bodiesFor(ports),
          ceilings,
        }),
      );

      log(`pass: ${pass.steps.map((v) => `${v.step}=${v.ending.ending}`).join(" ")}`);
      for (const route of pass.routes) {
        runLog.note("route", `${route.from} → ${route.to}: ${route.why}`);
      }

      const outcome = outcomeOf(pass);
      const headSha = headReached(pass.steps);
      /**
       * **The refs go before the question, and this line is what makes that
       * true** (`#250`, 0062 §1).
       *
       * A person asked *merge this anyway?* wants the branch already on origin to
       * answer it with, and a publish that happens only while the scope unwinds
       * happens after every append below and after GitHub has been told. So the
       * publish is asked for here, on every ending but a landing — where the lane
       * has already pushed and `didLand` will delete the run log.
       *
       * The finalizer still runs and is not redundant: it is the only thing that
       * covers a crash or an interruption between here and the end of the scope,
       * and on the paths that reach this line it finds the head already published
       * and writes the `already-published` row that says *the finalizer fired* —
       * which is the fact `#250` had to infer from a `RUN_LOG_END` line.
       *
       * `null` is *nothing to say*: the refs are where this ending promised them,
       * or there was nothing committed to promise. A string is git's own words,
       * and it travels onto the card rather than being swallowed — the person is
       * still owed the question, and is told the branch is not there.
       */
      const notPushed =
        outcome === "landed" ? null : yield* Effect.promise(publishWhatIsCommitted);
      const unpushed =
        notPushed === null ? "" : ` (and ${branch} was not pushed: ${said(notPushed, 120)})`;
      const stopped = pass.stoppedAt;
      /** What the router decided last, which is what sent a pass to a person. */
      const lastRoute = pass.routes.at(-1) ?? null;
      /** Every finding the pass's plugins raised, for a card and for a restart. */
      const findings = pass.steps.flatMap((visit) =>
        visit.results.flatMap((result) => result.findings),
      );
      /** How many rounds the pass actually bought — a route back into the spine. */
      const roundsSpent = pass.routes.filter(
        (route) => route.to !== "waiting" && route.to !== "claim",
      ).length;

      /**
       * The three things a person is owed, in one place.
       *
       * `question` is what the card says, `diagnosis` is what is under it, and both
       * are read off `PassResult` rather than recomposed from a `FixOn` the pass
       * does not produce. A refused merge is the one case with a written diagnosis
       * already — `diagnoseRefusal` — and it is used rather than restated.
       */
      const blocked = () => {
        const said_ = whatIsWaitingOnYou();
        return notPushed === null
          ? said_
          : // **Git's own words reach the card, on every shape of the question.**
            // A rescue starts from knowing whether the commits reached origin, and
            // the three returns below each compose their own `what` — so the
            // sentence is appended once, here, rather than three times there.
            { ...said_, diagnosis: { ...said_.diagnosis, what: `${said_.diagnosis.what}${unpushed}` } };
      };

      const whatIsWaitingOnYou = () => {
        const at = stopped?.step ?? "proposed";
        const ending = stopped?.ending.ending ?? "routed";
        const why = stopped === null ? (lastRoute?.why ?? "the pass was held for a person") : detailOf(stopped);
        const question =
          stopped === null
            ? `${branch} into ${base} is waiting on you. ${said(why, 400)}`
            : `the \`${at}\` step ${ending}: ${said(why, 400)}`;
        if (stopped?.step === "merge" && stopped.ending.ending === "refused") {
          return {
            question: `${stopped.ending.because}: ${said(why, 400)}`,
            needs: "acknowledgement" as const,
            diagnosis: diagnoseRefusal({
              reason: stopped.ending.because,
              detail: why,
              branch,
              base,
            }),
          };
        }
        if (turnLimit !== null) {
          return {
            question: `out-of-turns: ${said(turnLimit)}`,
            needs: "acknowledgement" as const,
            diagnosis: {
              what:
                `the run reached the recipe's turn limit (${limits.turns}) and was stopped: ` +
                `${said(turnLimit)}. The limit is a scope alarm — the ticket asks for more than ` +
                "one run should do.",
              done: null,
              raw: turnLimit,
              recommendation: {
                action: "requeue" as const,
                why:
                  "narrow or split the ticket first; requeued as written, it buys another run to " +
                  "the same limit",
              },
            },
          };
        }
        return {
          question,
          // A hold and a route to a person are both *decide something*; a step that
          // reported a machine failure is *look at this*.
          needs:
            stopped === null || stopped.ending.ending === "held"
              ? ("judgement" as const)
              : ("acknowledgement" as const),
          diagnosis: {
            what:
              `${branch} is at ${headSha.slice(0, 7) || "the base"} and ` +
              (stopped === null
                ? `\`proposed\` held it for a person: ${said(why, 400)}`
                : `the \`${at}\` step ${ending}: ${said(why, 400)}`) +
              (roundsSpent > 0 ? ` ${roundsSpent} of ${limits.rounds} rounds were spent.` : ""),
            done: repairOf ? `a repair for ${repairOf.reason} produced this diff` : null,
            raw: why,
            recommendation:
              stopped === null && findings.length === 0
                ? {
                    action: "approve" as const,
                    why: "every step passed on this diff; approving merges what this run produced",
                  }
                : null,
          },
        };
      };

      // ---- landed -------------------------------------------------------------
      const merged = landedAt();
      if (outcome === "landed" && merged !== null) {
        yield* Effect.promise(() =>
          appendNow(workItemId, [
            {
              type: "WorkItemLanded",
              actor: "conductor",
              data: parsePayload("WorkItemLanded", { mergeCommit: merged, base }),
            },
          ]),
        );
        // **`end` has already resolved and recorded its effects** — the pass ran it,
        // on this outcome, before this line. What is left is telling the issue,
        // which reads the plan `recordEnd` kept rather than the stream.
        released = true;
        yield* Effect.promise(() =>
          tellGitHubAbout({
            store,
            github: options.client,
            workItemId,
            labels: labelsFor("landed"),
            appended: endResolved,
          }),
        );
        log(`landed ${merged.slice(0, 7)} on ${base}`);
        didLand = true;
        return { ok: true, workItemId, runId, mergeCommit: merged } satisfies RunOnceResult;
      }

      // ---- requeued: a second approach was bought (0040) -----------------------
      if (pass.rested === "requeued") {
        const restart = folded.restarts.length + 1;
        const reason = restartReason({
          action: lastRoute?.from ?? "review",
          rounds: roundsSpent,
          n: restart,
          of: limits.restarts,
        });
        yield* Effect.promise(() =>
          appendNow(workItemId, [
            {
              type: "PassRestarted",
              actor: "conductor",
              data: parsePayload("PassRestarted", {
                runId,
                restart,
                of: limits.restarts,
                action: lastRoute?.from ?? "review",
                rounds: roundsSpent,
                // The arm and not `agent/<n>`: this approach stays fetchable when
                // the next claim overwrites the branch (0062 §2).
                branch: arm,
                headSha,
                findings,
              }),
            },
          ]),
        );
        log(`starting over — restart ${restart} of ${limits.restarts}`);
        runLog.note("restart", reason);
        yield* release(reason);
        return { ok: false, workItemId, runId, stage: "restart", detail: reason } satisfies RunOnceResult;
      }

      // ---- blocked: a person now holds it -------------------------------------
      if (outcome === "blocked") {
        const held = stopped?.ending.ending === "held";
        const said_ = blocked();
        // A plugin that asked for a person has already had its `ApprovalRequested`
        // emitted by the pipeline; everything else that reaches a person has not.
        if (!held) {
          yield* Effect.promise(() =>
            appendNow(runId, [
              {
                type: "ApprovalRequested",
                actor: "conductor",
                data: parsePayload("ApprovalRequested", {
                  gate: stopped?.step ?? "proposed",
                  action: whatRefused(stopped) ?? "judge",
                  runId,
                  onSha: headSha,
                  question: `Merge ${branch} into ${base} anyway? ${said_.question}`,
                  artifacts: [`${branch}@${headSha}`],
                }),
              },
            ]),
          );
        }
        yield* Effect.promise(() =>
          appendNow(workItemId, [
            {
              type: "WorkItemBlocked",
              actor: "conductor",
              data: parsePayload("WorkItemBlocked", {
                question: said_.question,
                needsFrom: "human",
                runId,
                needs: said_.needs,
                diagnosis: said_.diagnosis,
              }),
            },
          ]),
        );
        released = true;
        yield* Effect.promise(() =>
          tellGitHubAbout({
            store,
            github: options.client,
            workItemId,
            question: said_.question,
            labels: labelsFor("waiting"),
            appended: endResolved,
          }),
        );
        log(`held at ${headSha.slice(0, 7) || "the base"} — ${said_.question}`);
        return {
          ok: "held",
          workItemId,
          runId,
          headSha,
          step: stopped?.step ?? "proposed",
        } satisfies RunOnceResult;
      }

      // ---- failed: the item goes back to the queue -----------------------------
      // **And one ending stops the conductor rather than the item** (0031 §3). A
      // `never-ran` met something account-wide, so every queued item would meet it
      // identically: the item is released like any other failure and nothing else
      // is taken until the pause lifts.
      if (stopped?.ending.ending === "never-ran") {
        const at = stopped.ending.at;
        yield* standDownConductor(
          // `implement` and `design` have no cell open, so a `never-ran` at either
          // is the body's own stand-down and the wall is the *run's*. At any other
          // step it is a declared plugin's agent, which 0041 §3 reuses this whole
          // mechanism for.
          stopped.step === "implement" || stopped.step === "design"
            ? { of: "run" }
            : { of: "step", step: `${stopped.step}:${at ?? "agent"}` },
          stopped.ending.detail,
        );
      }
      const reason =
        stopped === null
          ? `the pass ended without landing and without asking anybody${unpushed}`
          : `the \`${stopped.step}\` step ${stopped.ending.ending}: ${said(detailOf(stopped))}${unpushed}`;
      yield* release(reason);
      return {
        ok: false,
        workItemId,
        runId,
        stage: stopped?.step ?? "pass",
        detail: stopped === null ? reason : detailOf(stopped),
      } satisfies RunOnceResult;
    });

    return yield* Effect.scoped(claimed).pipe(
      Effect.catchAllDefect((defect) => {
        const detail = defect instanceof Error ? defect.message : String(defect);
        return release(`unexpected failure: ${detail}`).pipe(
          Effect.as({
            ok: false as const,
            workItemId,
            runId,
            stage: "unexpected",
            detail,
          }),
        );
      }),
      // A run that was interrupted still has to give the item back. `release` is
      // idempotent, so the paths above that already released are unaffected.
      Effect.ensuring(release("the run was interrupted")),
    );
  });
}
