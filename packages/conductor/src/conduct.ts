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
 * It replaces the engine `#256` deleted, which ran five gate points around the
 * same wiring in 3479 lines. That file is **the old engine** wherever the
 * comments below need it: named, never cited, because it is not there to read. Nothing about the *stored* vocabulary changed in that swap:
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
 * Seven closures, and every one of them **wraps rather than reimplements**, which
 * is the `#226` rule `pass-steps.ts` is held to from the other side. Four are
 * `PassPorts` methods; `take`, `cut` and `land` are a plugin's deps, reached
 * through `stepDeps` rather than through the pass (`#269`, `#268`, `#270`):
 *
 * ```
 * take      runnableNow + claimWorkItem      a `queue:` action's, at `claim`
 * cut       repo.provision                   a `worktree:` action's, at `admit`
 * dispatch  the hook, the agent, the receipt  and a fix round, when a round was bought
 * judge     judgeDeclaredAt                  the recipe's own `proposed:` judges
 * land      repo.integrate                    a `merge:` action's, at `merge`
 * readEnd   store.read                        the item's own stream
 * recordEnd held for the ending's append       what `end` resolved, never alone
 * ```
 *
 * Beside those, `item` and `onStream` — two `PassPorts` methods that read what
 * `take` left in this closure rather than doing anything, for `cutTree`'s reason:
 * the closure that holds a fact is the one that can hand it back (`#269`).
 *
 * **`draft` was one of them and is gone** (`#265`). It answered *nothing is
 * declared* — `""`, dispatching nothing — because no plugin served `design`, and
 * that was the truthful answer rather than a stub while it was true.
 * `agentPlugin` declares the step now, so a design is an `agent:` action a recipe
 * writes and the port that stood in for one would be the second place it could
 * happen. What is unchanged is what an unconfigured `design` does: `defaultsAt`
 * has no row for it, nothing runs, and `implement` is briefed with `""`.
 * **`judge` stopped being the second of those in `#274`**: a
 * recipe declares its judges at `proposed:`, one per `when:`, and this port is
 * where the entry matching the direction is looked up. Where it declares none the
 * answer is still `noJudge`, and what that costs is `BUILT_IN_FOR`'s: `red` and
 * `verify-failed` are mechanical and spend nothing, and a person is the floor under
 * the other three.
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
  queueOf,
  submodulesOf,
  type QueueSettings,
  type ResolvedRecipe,
  type StepAction,
} from "@lingtai/recipe";
import { currentRecipe } from "./projects.ts";
import { type Tier, parsePayload, retiredRepairPending } from "@lingtai/domain";
import {
  NEEDS_INPUT,
  NO_DESIGN,
  type Action,
  type ActionContext,
  type ActionEvent,
  type CutAnswer,
  type KeptAnswer,
  type LandAnswer,
  type MergeStrategy,
  type TakeAnswer,
  actionsFromRecipe,
  createHumanAction,
  createMergeAction,
  createQueueAction,
  createWorkAction,
  createWorktreeAction,
} from "@lingtai/actions";
import type { GitHubClient } from "@lingtai/github";
import {
  NO_RUN_LOG,
  type RunLog,
  type Runtime,
  missingForTier,
  taggedTrace,
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
import type { TerminalOutcome } from "./end-step.ts";
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
  type Judged,
  type Judging,
  type PassPorts,
  type Worked,
  bodiesFor,
} from "./pass-steps.ts";
import { isBuiltInJudge } from "@lingtai/recipe";
import { judgeDeclaredAt } from "./judge.ts";
import { chosenIn, judgePrompt } from "./judge-agent.ts";

import type { ProjectState } from "@lingtai/domain";
import { extensionEnv, productionPatterns, runnableEnv } from "@lingtai/agent-env";
import { stateDir } from "@lingtai/env";
import { worktreePath, type TokenSource, type Worktree } from "@lingtai/repo";
import { Data, Effect, Either } from "effect";
import { AgentHost, Repo } from "./ports.ts";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  /**
   * **Which key on that line names the runtime** (`#277`).
   *
   * `agent:` and a runtime `judge:` are the same fact — a second runtime named
   * at a step — and they are refused by the same sentence; the remedy has to
   * name the key, because *Name `agent:` …* sends an operator to edit a key the
   * line does not have. The file is the same either way, which is what `at`
   * carries and why this is a field beside it rather than a third value of it.
   */
  key: "agent" | "judge";
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
 *
 * **A runtime `judge:` is the same fact and is refused the same way** (`#277`).
 * Since that ticket a `judge:` entry may name a runtime, and a judge is
 * dispatched on `options.runtime` exactly as a cold reviewer is — so a
 * `judge: codex` here would have its judgement bought from Claude Code with
 * nothing anywhere saying the named runtime was not used. A built-in `judge:` is
 * not a runtime and is passed over: `isBuiltInJudge` is the whole of that test,
 * so a second built-in is on the free side the day it is added.
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
      key: "agent",
      sentence: `runtime.agent is ${named}${from ? ` (${from})` : ""}, and this conductor runs ${dispatched}`,
    };
  }
  for (const [step, actions] of Object.entries(resolved.recipe.steps)) {
    for (const action of actions) {
      // A built-in judge names no runtime — it is a function — so it is not a
      // second dispatch and nothing about it can disagree with this one.
      const second: { key: AgentRefusal["key"]; wants: string } | null =
        "agent" in action
          ? { key: "agent", wants: action.agent }
          : "judge" in action && !isBuiltInJudge(action.judge)
            ? { key: "judge", wants: action.judge }
            : null;
      if (second === null || second.wants === dispatched) continue;
      return {
        at: "step",
        key: second.key,
        sentence:
          `steps.${step}'s "${action.name}" action names ${second.key} ${second.wants}, ` +
          `and this conductor runs ${dispatched}`,
      };
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

/** A defect's own words. Wanted by the publish and by the release above it. */
function whyOf(defect: unknown): string {
  return defect instanceof Error ? defect.message : String(defect);
}

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
     * An append at whatever version the stream is at, and nothing else.
     *
     * A promise rather than an `Effect`, because the ports below are plain
     * promises (`pass-steps.ts`'s *Why plain promises*) and this is what they
     * append with. **For the callers that answer a refused append themselves**
     * — the account of the publish, the diff's counts, the release's record of
     * what `end` resolved — each of which has already decided that losing its
     * row costs less than losing the ending it is about. Everything else uses
     * `appendNow`.
     */
    const appendAt = async (stream: string, events: readonly ToAppend[]): Promise<void> => {
      const at = (await store.read(stream)).length;
      await store.append(stream, at, events);
    };

    /**
     * The same append, **remembered when the store refuses it**.
     *
     * A store that will not append is a defect and not a refusal this function
     * can make on anyone's behalf: the handler at the bottom is where defects
     * are answered for. That was true of every append while the old engine made
     * them, and the swap to `pass.ts` quietly made it false for the ones made
     * from inside the walk — `emit`'s verdicts, `dispatch`'s `RunStarted`, a
     * round's `FixRequested`. `runStep` catches whatever a step throws and
     * reports it as that step having *did-not-finish: threw* (`pass.ts`), so a
     * dropped Postgres connection — the disconnect CLAUDE.md documents against
     * `#157` — came back as `blocked` with `needs: "acknowledgement"` and a
     * diagnosis naming the step, parking the item on *Waiting on you* over a
     * database blip and losing the verdict it was recording. Before the swap
     * the same rejection reached the defect handler, released the item, and the
     * queue took it again after the backoff with nobody involved.
     *
     * So the throw still travels — the step must not carry on as though its
     * verdict were recorded — and the defect is kept here, where the ending is
     * written: the pass is re-raised into the defect channel the moment it
     * returns (see `unappended`), rather than having its report believed.
     */
    let unappended: unknown = null;
    const appendNow = async (stream: string, events: readonly ToAppend[]): Promise<void> => {
      try {
        await appendAt(stream, events);
      } catch (defect) {
        unappended ??= defect;
        throw defect;
      }
    };

    /**
     * The same, at a version the caller already holds rather than one read here.
     *
     * The receipts, and only those: the hook server wrote to the run's stream
     * while the agent worked, so `server.get(runId).version` is where it got to
     * and a read of our own would race it. Remembered like `appendNow` and for
     * its reason — the dispatch is inside the walk, so a store that refuses one
     * of these arrives as *the `implement` step threw* unless this says
     * otherwise.
     */
    const appendFrom = async (
      stream: string,
      version: number,
      events: readonly ToAppend[],
    ): Promise<void> => {
      try {
        await store.append(stream, version, events);
      } catch (defect) {
        unappended ??= defect;
        throw defect;
      }
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
     * **The stream `end` resolves onto**, or null where this pass is about no item
     * (`#269`).
     *
     * Beside `took` in meaning and beside `released` in scope, and both placements
     * are load-bearing. It is not read off `took` because the two are not the same
     * question: a claim whose append *may* have committed gives the pass a stream
     * and no ticket, and `end` needs only the first of those. And it is **out here
     * rather than inside the scope, because `release` is out here too** —
     * `endResolved` is here for that reason and this is the same one: *did this run
     * ever hold the item* is what the release is gated on, and a local of the scope
     * is a question the release cannot ask.
     */
    let onStream: string | null = null;
    /**
     * What `end` resolved, so the issue is told what the item recorded.
     *
     * **Out here rather than inside the scope, because `release` is out here
     * too.** `recordEnd` sets it; all three endings read it. It used to be a
     * local of the scope below, which `release` cannot see — so the `failed` and
     * restart endings passed `labels` to `tellGitHubAbout` and no `appended`,
     * and `tellGitHubAbout` carries out an `EndActionsResolved` **only** from
     * `appended` (`tell.ts`). A recipe's `end: [{ when: failed, close: true }]`
     * was therefore resolved onto the log and never carried out: no
     * `closeIssue`, no `IssueUpdateFailed` for `converge.ts` to retry, and
     * `resolveEndActions`'s once-per-outcome rule makes every later pass resolve
     * nothing — so `endedWithoutEndActions` finds the row and reports nothing
     * wrong. The landed and blocked endings always passed it; this is the path
     * that dropped it.
     *
     * **What actually reached the stream, never what was going to.** Each ending
     * sets it after its own append has returned — see `endPlan`.
     */
    let endResolved: readonly ToAppend[] = [];
    /**
     * **What `end` resolved, held until the append that makes its outcome true.**
     *
     * `recordEnd` sets this and appends nothing, which is `PassPorts.recordEnd`
     * read the way it states itself — *batching is the caller's because the
     * ending is the caller's*. It used to append on the spot, and that put the
     * resolution on the item's stream **before** the `WorkItemLanded` or
     * `WorkItemBlocked` it is about: the exact split `resolveEndActions` says is
     * impossible — *one transaction, so the outcome and its resolution cannot
     * come apart* (`end-step.ts`).
     *
     * The window was not theoretical and it was the expensive kind. A dropped
     * connection on the next append — the disconnect CLAUDE.md documents against
     * `#157` — left `EndActionsResolved{landed}` over a commit that is on the
     * base branch with no landing recorded: `reduceWorkItem` reads `backlog`,
     * the issue is relabelled `lingtai:queued`, the next queue pass buys a whole
     * agent to re-implement merged work, and because the point resolves **once
     * per outcome** the real landing can never resolve it again —
     * `endedWithoutEndActions` finds the matching row and reports nothing wrong.
     * The same window on the blocked ending recorded a `when: blocked` action as
     * carried out for a block that was never recorded.
     *
     * So it is held here and appended *by* the ending, in one transaction with
     * it. Where the ending is a release the two cannot be one transaction —
     * `releaseWorkItem` owns its own read and version — and there the order is
     * what carries the rule: the release first, the resolution after it.
     */
    let endPlan: readonly ToAppend[] = [];
    /**
     * Which of the four endings the pass reached, or null while it is walking.
     *
     * Read by `release`, for the rule above: a plan may only be appended beside
     * the event that makes its outcome true, and a release makes `failed` true
     * and nothing else. So a `landed` plan whose own append died must not be
     * carried in on the release that follows it — that is the orphan row again,
     * arriving by the defect handler instead of by the window.
     */
    let endedAs: TerminalOutcome | null = null;
    /**
     * How a run that did not land gives the item back.
     *
     * **One way, and `#143` is what made it one.** The item returns to the queue
     * and the backoff decides when it is seen again. The `end` step has already
     * *resolved* its declared effects by the time this runs — the pass ran it, on
     * every ending — so nothing here resolves them again; what is left is
     * recording that resolution and carrying it out.
     *
     * **The release goes first, and this is the one ending where the two are two
     * appends.** `releaseWorkItem` owns its own read and version, which is
     * `appendEndActions`'s *the one caller that cannot batch* arriving from the
     * other side. The direction is what stands in for the transaction: losing the
     * second append leaves effects unrecorded, where losing the first would leave
     * them recorded for an ending the log does not carry (`endPlan`).
     *
     * **So the first append's failure is read, and that is the whole of what
     * makes the direction mean anything.** It is not raised — the reasons below
     * stand — but a release that never reached the log must not be followed by
     * the row that says what that release resolved: `.catch(() => {})` on its
     * own made the two indistinguishable, and `EndActionsResolved{failed}` went
     * on next regardless. That is the orphan this ordering exists to prevent,
     * arriving by the tolerant catch rather than by the window, and it costs
     * exactly what the window costs — the point resolves once per outcome, so
     * the pass that does release the item can never resolve `failed` again, and
     * `endedWithoutEndActions` finds the row and reports nothing wrong.
     *
     * **And only a plan about `failed`**, because that is the outcome a release
     * makes true. A `landed` plan reaching here means the landing's own append
     * died, and appending it would be the orphan row this ordering exists to
     * prevent; a `blocked` plan reaching here is the `claim-unconfirmed` decline,
     * where the item goes back to the queue and nothing was blocked. Neither is
     * recorded, so a later pass resolves whichever ending it actually reaches.
     */
    const release = (reason: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (released) return Effect.void;
        /**
         * **A run that took nothing releases nothing** (`#269`).
         *
         * `releaseWorkItem` appends whoever holds it (`claim.ts`), so a release
         * from a run that never claimed writes `WorkItemReleased` over **another
         * conductor's live item** and `lingtai:queued` over its `lingtai:working`
         * while its agent is still working. The `claim` branch at the bottom
         * guards the declines the pass *reports*; what reaches the defect handler
         * with `released` still false is a throw from before the claim, and
         * `claim`'s own step has appended to the run's stream since its work
         * became a `queue:` action — `emit`'s `StepRequested` for the take, which
         * a dropped connection turns into exactly that defect.
         *
         * `onStream` and not `took`, because the one decline that may be holding
         * the item has a stream and no ticket: `claim-unconfirmed` must still give
         * back something this run may hold, which is the whole reason `Taken` had
         * a fourth case.
         */
        if (onStream === null) {
          log(`nothing to release: ${reason}`);
          released = true;
          return Effect.void;
        }
        released = true;
        return Effect.tryPromise({
          try: async () => {
            /** Whether the release reached the log — the gate on the append after it. */
            let backInTheQueue = true;
            await releaseWorkItem(workItemId, runId, reason, store).catch((err: unknown) => {
              backInTheQueue = false;
              log(`the item was not released: ${whyOf(err)}`);
            });
            if (backInTheQueue && endedAs === "failed" && endPlan.length > 0) {
              try {
                await appendAt(workItemId, endPlan);
                endResolved = endPlan;
              } catch (defect) {
                // Said rather than raised: the run has already ended and the item
                // is already back, and a throw here would replace the reason it
                // ended with the reason the bookkeeping did.
                log(`end actions not recorded: ${whyOf(defect)}`);
              }
            }
            await tellGitHubAbout({
              store,
              github: options.client,
              workItemId,
              labels: labelsFor("queued"),
              appended: endResolved,
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
            : what.of === "step" || what.of === "draft"
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
      /** The tree, once `admit`'s `worktree:` action has cut it. */
      let worktree: Worktree | null = null;
      /**
       * That tree, for the step that briefs an agent on it — or a throw naming
       * what did not run.
       *
       * **It is this file's fact rather than the pass's since `#268`.** The cut
       * is the `worktree:` plugin's now (0065 §2), `cut` below is the dep it
       * runs, and this closure is what that dep fills — so `Brief` no longer
       * carries a copy of a path only the conductor can have made. `implement`
       * is reached only after `admit` passed and `admit` passes only on a cut,
       * so null here is the pass's own bookkeeping gone wrong and not something
       * that happened to a diff: `runStep` catches the throw and reports the
       * visit as its own `did-not-finish`, which is what `madeBy` in
       * `pass-steps.ts` does for the two facts that still travel in its closure.
       */
      const cutTree = (): Worktree => {
        if (worktree === null) {
          throw new Error(
            "the `implement` step has no worktree — `admit`'s `worktree:` action did not cut one, " +
              "and the spine says it did. This is the pass's own bookkeeping and not a judgement " +
              "about the change.",
          );
        }
        return worktree;
      };
      /** The item, once `claim`'s `queue:` action has taken it. */
      let took: Claimed | null = null;
      /**
       * The settings file every declared `agent:` runs under, once `admit`'s port
       * has written it.
       *
       * Empty until then, and nothing reads it until then — **and since `#265` the
       * earliest reader is one step later rather than three.** `agentPlugin.at`
       * opens at `design`, `review`, `proposed` and `merge`, and `design` is the
       * step straight after `admit`: a drafting agent declared there is dispatched
       * with this path, so the write cannot move any later than `cut` without
       * leaving it `""`. Named for the reviewer because that is the action it was
       * written for and still the only one that reads a diff; what it *is* is one
       * unhooked settings file per pass. See `cut` for why it is written there
       * rather than above the pass.
       */
      let reviewSettingsPath = "";
      /**
       * **How many judgements this pass has bought**, and it is in the session id
       * (`#277`).
       *
       * A runtime's session id has to differ per dispatch, and the direction is
       * not enough to make it: one pass reaches `proposed` with a `findings`
       * every round it buys, so `<runId>:judge:findings` would be the same string
       * twice. Claude Code refuses a session id it has already been given —
       * *Session ID … is already in use* — which is `#195` exactly: one second,
       * no receipt, the round spent, the question never read. **The crash was the
       * lucky outcome there**; a runtime that resumed instead would answer the
       * second arrival with the first one's context, which is a judge asked
       * whether it still agrees with itself.
       *
       * A count rather than the head `sessionIdFor` keys on: a judge is asked at
       * arrivals that may share a commit — a `needs-input` and the `findings`
       * after it — so the commit is not the thing that differs, and the number of
       * times this pass has paid for a judgement is.
       */
      let judgements = 0;
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
       * **Which agent met the account-wide wall, where `implement` reports one.**
       *
       * The pass has one `implement` step and this file dispatches two different
       * agents at it — the implementer on the way through, and the agent a round
       * bought on the way back — and `StepNeverRan` carries the runtime's id, not
       * which of the two it was. Left unrecorded, a fix round that met the wall
       * was reported to `standDown` as `{of: "run"}`, whose sentence is *a run
       * ended without ever starting — no turns taken, nothing spent*: written
       * into `ConductorPaused.reason`, which is what the board's pause chip and
       * `lingtai doctor` print, about a pass whose implementer ran, took its turns
       * and was paid. That is the false sentence `#133` is against and `0041` §3
       * gave `NeverStarted` a third case for — `{of: "fix"}`, which nothing
       * constructed.
       *
       * Null until a round's agent is the one refused, so the first dispatch's
       * wall is still `{of: "run"}` and says so.
       */
      let fixWall: { action: string; round: number } | null = null;
      /**
       * Read through a call and not off the variable, for `landedAt`'s reason:
       * `fixRound` is a port and the compiler cannot see that it ran, so
       * narrowing the `let` at the read below would make it `never`.
       */
      const wallMetBy = (): { action: string; round: number } | null => fixWall;

      /**
       * The run's log, and the keep-or-delete that ends it.
       *
       * **Landed → delete. Did not land → keep.** The diff is on the branch and
       * the events are on the log, so what an agent was thinking during a run
       * that worked has the least marginal value of anything here. A log that
       * could not be opened is `NO_RUN_LOG` rather than a refusal: the
       * observability of a run is not worth failing it for.
       *
       * **And it is opened by the claim, not before it** — which is 0034 §4's
       * *what is kept is exactly the investigable set* read as a rule about when
       * the file is created rather than only about its fate. Under the old engine
       * discovery and the claim both ran above the scope that opened this, so a
       * candidate that was never taken left nothing behind. Since `#256` the
       * claim is the pass's first step, and an eager open put a file on disk for
       * every `passed-over` and every lost race — kept, because `didLand` is
       * false, with a closing line calling itself *the only account of why* a run
       * that never started did not land. One pair per pass, for ever, and the
       * rule 0034 rests on to need no sweeper is exactly that nothing
       * uninvestigable is written.
       *
       * So the handle is deferred and `runLog` is what everything holds — and
       * **a note written before the open is held rather than dropped** (`#269`).
       * There used to be none, which is what this said; since the take is a
       * `queue:` action, `runActionPipeline` writes its `started` line before
       * calling it (`action.ts`) and the open happens *inside* the call, on the
       * line the claim commits. Dropping it left every log opening with a
       * `claim:… passed` whose `started` was nowhere — an action end that never
       * began, to somebody following `lingtai attach <runId>` from the beginning,
       * which is how that command is always read (0034).
       *
       * Held and not eagerly opened, because the file is the thing 0034 is about:
       * a pass that is passed over or loses the race still writes nothing at all,
       * and what it buffered goes with the closure.
       */
      let opened: RunLog | null = null;
      /** Notes taken before there was a file, in the order they were written. */
      let beforeTheOpen: { label: string; detail: string | undefined }[] = [];
      const runLog: RunLog = {
        get path() {
          return opened?.path ?? "";
        },
        note: (label, detail) => {
          if (opened === null) beforeTheOpen.push({ label, detail });
          else opened.note(label, detail);
        },
        close: async (fate) => {
          await opened?.close(fate);
        },
      };
      /** Called by `claim`'s `queue:` action, and only once it holds the item. */
      const openTheRunLog = async (): Promise<void> => {
        opened = await Effect.runPromise(
          host.runLog({ path: runLogPath(home, project, runId) }).pipe(
            Effect.catchAll((err) =>
              Effect.sync(() => {
                log(`no run log: ${err.detail}`);
                return NO_RUN_LOG satisfies RunLog;
              }),
            ),
          ),
        );
        // The sentence that says which run this is, first — then what was written
        // while there was nowhere to write it, in the order it was written.
        runLog.note("run", `${runId} · ${workItemId} · ${branch} → ${base}`);
        const held = beforeTheOpen;
        beforeTheOpen = [];
        for (const { label, detail } of held) runLog.note(label, detail);
      };
      /**
       * Released last, because it is registered first — the same ordering the
       * `acquireRelease` this replaces gave, and for the same reason: the fate
       * turns on `didLand`, which is only a fact once the worktree's finalizer
       * and the publish's have run. A log that was never opened has nothing to
       * close and nothing to say.
       */
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          if (opened === null) return;
          // The sentence, and the label a reader recognises it by: `#110`
          // follows this from another process and has nothing else to tell *the
          // writer has finished* from *the writer is thinking*.
          runLog.note(RUN_LOG_END, runLogEnd(didLand));
          await runLog.close(didLand ? "delete" : "keep");
        }),
      );

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
       * The head **`arm` itself is on origin at**, or null while it is on none.
       *
       * Apart from `published`, because the two refs do not always go together
       * and both directions happen: `arm-only` is origin taking the forced arm
       * and rejecting the leased `agent/<n>`, which leaves `published` where it
       * was and the arm up; `land` is the other way round — it pushes the
       * branch alone, so a merge the lane then refuses leaves `published` at
       * this head with no arm anywhere, which is what the end-of-pass publish
       * asks about before it decides it has nothing to do.
       *
       * It exists because `PassRestarted` makes a claim about this ref and
       * nothing else could check it. That event names `arm` as where the
       * abandoned approach is fetchable, `attempts.ts` tells the next agent to
       * `git fetch origin <arm>`, and appending it consumes one of
       * `ceilings.restartsLeft` — so a restart recorded over a publish that was
       * refused spends a restart, points the next attempt at a ref that has
       * never existed, and loses the commits with the worktree. The old engine
       * pushed strictly *before* the append for exactly this reason: *a push
       * that is refused must leave no arm on the log.*
       */
      let armPublished: string | null = null;
      /**
       * What the run's own stream has already been told this claim produced, as
       * `<ref>@<head>`. A key and not a flag, because `arm-only` corrects an
       * answer an earlier call has already given (`#251`).
       */
      let recordedDiff: string | null = null;
      const producedKey = (ref: string, head: string) => `${ref}@${head}`;

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
          await appendAt(runId, [
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
          await appendAt(runId, [row]);
        } catch (first) {
          try {
            await appendAt(runId, [row]);
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
          /**
           * **Both refs, because the row says both and a restart names the
           * second** (0062 §2, `#251`).
           *
           * `published` alone was the condition, and `land` sets it without the
           * arm: it pushes `HEAD:refs/heads/<branch>` on its own, because the
           * lane is about to merge that ref and an arm written for a landing is
           * one 0062 §4's sweep would take straight back off. So on every
           * ending that reached the merge lane and was refused there —
           * `conflict`, `no-commits`, `pending-migration`, `dirty-base` — this
           * short-circuited as `already-published`, pushed nothing, and wrote a
           * row naming an `arm` that is on no remote. The person requeues, the
           * next attempt's `--force-with-lease` matches and overwrites
           * `agent/<n>` from a fresh base, and the commits the live
           * `ApprovalRequested` named are unreachable — which is the loss the
           * arm ref exists to prevent, under a log row asserting it was
           * prevented.
           *
           * Asking for both means the push below runs on that ending: the
           * branch's refspec is a no-op at a head origin already has, and the
           * forced arm is the whole point of the second trip.
           */
          if (head === published && head === armPublished) {
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
              // The arm is up even though the command exited non-zero, which is
              // the whole point of asking it separately.
              armPublished = head;
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
          armPublished = head;
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
      const take = async (queue: QueueSettings): Promise<TakeAnswer> => {
        // **Before the answer, not after it** — the three ways this can decline
        // set no item, and it was exactly those that would let `end` resolve onto
        // the item the pass before had landed. It is here rather than in `claim`'s
        // body because the action runs *before* the body: a reset written there
        // would wipe what this had just taken (`pass-steps.ts`).
        took = null;
        onStream = null;
        // The four values off the action and never off `recipe` here, so that the
        // ticket this takes is the one the reading of the recipe says it took
        // (`queueOf`, and `defaultsAt` below where a recipe declares nothing).
        const found = await runnableNow({ client: options.client, queue, only: [options.issue] });
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
          // The one decline that leaves a stream behind, and `end` resolves
          // against it: the append may have committed, so the item may be held by
          // this run and somebody has to be told about it.
          onStream = workItemId;
          return { mayHold: { workItemId, detail: whyOf(error) } };
        }
        if (!claim.ok) return { notClaimed: JSON.stringify(claim.refusal) };
        // **Set on the line the append committed, and before anything that can
        // fail** (`#269`). It is the whole of *this run may hold the item*, which
        // is what `release` below is gated on — so a throw between here and the
        // return must not be able to leave the item claimed with nothing willing
        // to give it back.
        onStream = workItemId;
        log(`claimed ${workItemId} as ${runId}`);
        // **The run's account starts here**, because until this line there is no
        // run to account for: see `runLog`. A `passedOver` or a lost race above
        // returns having opened nothing.
        await openTheRunLog();
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
        return { taken: { workItemId, kind: runnable.kind } };
      };

      /**
       * `admit` — cut the worktree, at the base **the action names**.
       *
       * **The dep of a plugin rather than a port of a step, since `#268`.**
       * `worktreePlugin` declares `admit` (0065 §4), so what calls this is
       * `createWorktreeAction` in `@lingtai/actions`, over the `base` and
       * `submodules` the action carries — which is `worktree:`'s at `admit` where
       * a recipe declares one and `defaultsAt`'s off `repo:` where it does not.
       * Read off the argument and never off `recipe` here, so that the tree this
       * cuts is the one the reading of the recipe says it cut.
       *
       * The path is `cwd`, computed before the pass: see this file's opening. A
       * clone that did not finish is not a judgement about the change — nothing
       * has been written yet — so it is `notCut`, which the action reports as
       * 0057's class rather than as a refusal buying a round to fix a repository.
       */
      const cut = async (spec: {
        readonly base: string;
        readonly submodules: boolean;
      }): Promise<CutAnswer> => {
        /**
         * The cold reviewer's own settings, with no hook in them. `wiring`'s
         * settings and `wiring.env` are one thing and the `agent` gate had only
         * the first, so the hook refused the reviewer's opening prompt and every
         * review returned that refusal instead of findings.
         *
         * Through the port and not `writeUnhookedSettings` itself: it writes a
         * file under `~/.lingtai`, and a conductor that wrote it here would put a
         * disk under every test of a decision that reaches `review` (0060 §1,
         * `AgentHostPort.unhookedSettings`).
         *
         * **Here, and not above the pass, because above the pass is before the
         * claim.** It used to be `….pipe(Effect.orDie)` in this file's own scope,
         * which is two faults in one line. A file under `~/.lingtai/runs/<runId>/`
         * was written for every candidate the `claim` step then passed over or
         * lost the race for, one per pass and never removed (`runLog`). And a
         * write that failed — ENOSPC, `~/.lingtai` not writable after a
         * permissions change — became a **defect**, which the handler at the
         * bottom of `runOnce` answers with `release(…)`: `releaseWorkItem`
         * appends whoever holds it (`claim.ts`), so a failure here appended
         * `WorkItemReleased` to another conductor's live item and wrote
         * `lingtai:queued` over its `lingtai:working` while its agent was still
         * working. The `claim` branch guards declines the pass reports; a defect
         * raised before the `claim` step reaches the handler with `released`
         * still false.
         *
         * So it is asked for at the step that gets this pass's disk ready, on an
         * item this run holds, and **before** the worktree: a failure is `notCut`
         * with nothing cut, which is true, and the item is then blocked or
         * released by the ending like any other machine fact.
         */
        const settings = await Effect.runPromise(
          Effect.either(host.unhookedSettings({ runId, label: "review", home })),
        );
        if (Either.isLeft(settings)) {
          return { notCut: `the cold reviewer had no settings: ${settings.left.detail}` };
        }
        reviewSettingsPath = settings.right;

        const provisioned = await Effect.runPromise(
          Effect.either(
            repo.provision({
              project,
              owner: options.client.owner,
              repo: options.client.repo,
              base: spec.base,
              branch,
              runId,
              submodules: spec.submodules,
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
        // `head` is the whole of what moves `onSha`, and the action puts it on
        // its result for the pass to read (`ActionResult.head`). The `Worktree`
        // itself stays here, where the finalizer that removes it already is.
        return { head: provisioned.right.baseSha, where: provisioned.right.path };
      };

      /**
       * **An agent, paid for a judgement** — the dispatch a `judge: claude-code`
       * is (`#277`, [the-plugin-body.md](../../../doc/design/the-plugin-body.md) §5).
       *
       * This is the seam that was missing while `JudgeName` took no runtime: a
       * built-in is a function the router applies and could live anywhere, and a
       * runtime needs a `Runtime`, a settings file and a prompt, none of which
       * exists on the router's side of the call. So it is here, beside the other
       * two dispatches, and it is the same four moves they make — settings, run,
       * read the answer, say what it cost.
       *
       * **Three ways it does not come back with a choice, and they are not all
       * the same thing.** None of the three judged anything, exactly as a reviewer
       * whose answer will not parse has not reviewed (`agent-action.ts`), and none
       * of them is **retried** — an agent that could not answer once costs the
       * same again and terminates no sooner. What differs is *whose* condition it
       * was:
       *
       * - a run that did not finish, and an answer that will not read as a
       *   destination, are about this pass, so they are **a person's** — the pass
       *   stops at `proposed` and the runtime's own words go on the card;
       * - a run that **never started** is a quota wall, which is account-wide, so
       *   it stands the conductor down exactly as an implementing agent's does
       *   (0031 §3). This paragraph said the opposite until the cold reviewer on
       *   `#277` read it against the ADR, and the argument it made — *the pass
       *   stops at `proposed` for a person either way* — was true about this pass
       *   and beside the point: the decision is about whether the conductor keeps
       *   taking work into a wall every queued item would meet, which is what §3
       *   is for, and about §5's resume happening without anybody watching.
       *
       * **Nothing is dispatched for a set of one.** `waiting` is on every offer
       * and is the whole of a refusal at `admit` or `prepared`, where no agent
       * has run — paying a model to pick the only item on a list is the purchase
       * `stepsOnOffer`'s criterion rule exists to refuse, one step further on.
       *
       * **What it cost is in the sentence** rather than on an event of its own.
       * `PassRouted.why` is what a person reads beside the arriving step's
       * detail, and a judgement with no price on it is the reading `#98` is
       * about; there is no `JudgeAsked` to fold and the route is already the
       * record of what was decided.
       */
      const askTheAgent = async (named: string, on: Judging): Promise<Judged> => {
        const held = (why: string): Judged => ({ next: "waiting", named, why });
        if (on.offering.length < 2) {
          return held(
            `the "${named}" judge was not asked about this "${on.when}": \`${on.offering[0]}\` was ` +
              "the only step on offer, and an agent paid to pick the only item on a list has " +
              "judged nothing",
          );
        }

        // **Which runtime the entry named is not read here**, and that is not it
        // being dropped: one conductor dispatches one runtime, `options.runtime`
        // is it, and a step naming the other is refused by `agentRefusal` before
        // the claim — so by the time a judge is asked the two agree. That is
        // `from-recipe.ts`'s rule for `agent:`, one plugin over.
        const runtime = options.runtime.capabilities.id;
        const settings = await Effect.runPromise(
          Effect.either(host.unhookedSettings({ runId, label: "judge", home })),
        );
        if (Either.isLeft(settings)) {
          return held(`the "${named}" judge had no settings: ${settings.left.detail}`);
        }
        judgements += 1;
        log(`judging a "${on.when}" with ${runtime} — ${named}`);
        runLog.note("judge", `${on.when}: asking ${runtime}`);

        const outcome = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const abort = yield* Effect.acquireRelease(
                Effect.sync(() => new AbortController()),
                (controller) => Effect.sync(() => controller.abort()),
              );
              return yield* Effect.promise(() =>
                options.runtime
                  .run({
                    // The count is in it, so two arrivals on one pass are two
                    // sessions: a judge asked whether it still agrees with itself
                    // is the warm-review failure `sessionIdFor` exists to avoid,
                    // and a session id reused is the refusal `#195` cost a run.
                    // See `judgements`.
                    runId: `${runId}:judge:${on.when}:${judgements}`,
                    // The worktree where there is one, and the conductor's own
                    // directory where `admit` never cut one. Nothing is read from
                    // either — the prompt says so — but a process still needs a
                    // directory that exists to start in.
                    cwd: worktree?.path ?? home,
                    prompt: judgePrompt(on),
                    settingsPath: settings.right,
                    log: taggedTrace(runLog, `judge:${on.when}`),
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

        const spent = `${outcome.turns} turns${outcome.costUsd === null ? "" : `, $${outcome.costUsd.toFixed(2)}`}`;
        runLog.note("judge", `${on.when}: ${outcome.failure?.kind ?? "answered"} · ${spent}`);
        /**
         * **A quota wall is the account's, so it stops the conductor rather than
         * this item** (0031 §3) — the third depth that wall is met at, after the
         * step's own agent and the agent a refusal bought.
         *
         * `never-started` is the adapter's classification and is not re-derived
         * here (0031 §1). Everything else — a crash, a timeout, a turn budget
         * spent without an answer — did start, is about this pass, and is a
         * person's: that is the `held` below.
         */
        if (outcome.failure?.kind === "never-started") {
          return {
            neverStarted: {
              agent: options.runtime.capabilities.id,
              // The runtime's own words, whole: `standDown` reads a reset time out
              // of them (0031 §4) and the pause chip shows them as what they are.
              detail: outcome.failure.detail,
            },
          };
        }
        if (outcome.failure) {
          return held(
            `the "${named}" judge did not answer (${outcome.failure.kind}): ` +
              `${outcome.failure.detail} — so the pass is held for a person (${spent})`,
          );
        }
        const chose = chosenIn(outcome.text);
        if (chose === null) {
          return held(
            `the "${named}" judge's answer was not readable as one of the steps it was offered ` +
              `(${spent}):\n${(outcome.text ?? "").slice(0, 2_000)}`,
          );
        }
        // Held to the offer by `judged` in `pass-steps.ts` and never here — a
        // destination the set did not contain is refused by name there, with the
        // ceiling that took it away, which is the one place that knows both.
        return { next: chose.next, named, why: `the "${named}" judge: ${chose.why} (${spent})` };
      };

      /**
       * `proposed` — **the judge the recipe declared for this direction** (`#274`,
       * `#277`, 0061 §3).
       *
       * `judgePlugin.at` carries `proposed`, `recipe.steps.proposed` is what
       * resolved there, and `judgeDeclaredAt` takes the entry whose `when:` matches
       * the reason the last step gave. **What it answers is one of two kinds of
       * decider**: a built-in is a *name* the pass applies, where nothing is
       * dispatched and `bodiesFor`'s `judged` records what the rule chose against
       * the offer; a runtime is an agent, and `askTheAgent` above is what that
       * costs.
       *
       * **`noJudge` where the recipe said nothing, which is still the ordinary
       * answer.** `BUILT_IN_FOR` then answers `red` and `verify-failed` mechanically
       * and spends nothing, and a person is the floor under `conflict`,
       * `needs-input` and `findings`. So a recipe with an empty `proposed:` behaves
       * exactly as it did before this existed (0064 §5: absent is not empty), and
       * the floor `#253` set holds either way.
       *
       * **What a declared judge buys is the round the ceilings already paid for.**
       * `#267` and `#263` each refused at `review` and parked at `waiting` with
       * `rounds: 3` unspent — $14.19 between them — because there was no judge to
       * ask which way to go. A runtime judge spends one of those rounds by
       * *choosing* `implement`; it cannot spend a second, because the offer it was
       * handed is what the counting already left.
       */
      const judge = async (on: Judging): Promise<Judged> => {
        const declared = judgeDeclaredAt(recipe.steps.proposed, on.when);
        if (declared === null) return { noJudge: true };
        return "built" in declared ? declared : askTheAgent(declared.named, on);
      };

      /** `end` — the work item's own stream, read this late on purpose. */
      const readEnd = (stream: string) => store.read(stream);

      /**
       * `end` — what the step resolved, held for the append that makes its
       * outcome true.
       *
       * **Not an append of its own, and that is the contract rather than a
       * shortcut.** `resolveEndActions`'s own doc is *one transaction, so the
       * outcome and its resolution cannot come apart*, and `PassPorts.recordEnd`
       * says whose transaction it is: *batching is the caller's because the ending
       * is the caller's*. The pass runs `end` before this file writes
       * `WorkItemLanded` or `WorkItemBlocked`, so an append here is the resolution
       * landing first and a dropped connection leaving it there alone. See
       * `endPlan` for what that cost.
       *
       * The version the read gave is therefore not used: the append that carries
       * this reads the stream for itself, which is the same optimistic check one
       * step further on.
       */
      const recordEnd = async (_stream: string, _at: number, plan: readonly ToAppend[]) => {
        endPlan = plan;
      };

      /**
       * `merge` — the branch on the remote, then the lane.
       *
       * **The dep of a plugin rather than a port of a step, since `#270`.**
       * `mergePlugin` declares `merge` (0065 §2), so what calls this is
       * `createMergeAction` in `@lingtai/actions`, over the `strategy` the action
       * carries and the `onSha` the pass is on — which is `merge:`'s at `merge`
       * where a recipe declares one and `defaultsAt`'s where it does not.
       *
       * The push is here rather than beside the agent because this is the point at
       * which the head has been judged: the steps before it all passed on `onSha`,
       * and pushing it is how the lane and a person get to see the thing that was
       * judged. Every other ending publishes from the finalizer.
       *
       * **`strategy` is carried and not branched on, because there is one value.**
       * `integrate` offers `git merge --no-edit` and a fast-forward push, which is
       * `merge-commit`. What keeps a second value from resolving is `mergePlugin`'s
       * own `z.enum` in `packages/recipe/src/recipe.ts` — not a check here, and
       * this signature has none: it carries the field so the lane is told what it
       * was asked for. Widening that enum without giving `integrate` the second
       * behaviour is `#61` — a value that resolves, is drawn, and lands the first
       * behaviour under the second's name — so the enum and `integrate` grow in
       * one diff, and this is where the branch on it would go.
       *
       * **The lane reports and decides nothing.** `stepsPassed` is `true` without
       * being asked, and that is the sequence rather than an assumption: `merge` is
       * reached only where every step before it passed, so a lane told otherwise
       * would be a lane told something the pass cannot be in a position to say.
       */
      const land = async (on: {
        readonly strategy: MergeStrategy;
        readonly onSha: string;
      }): Promise<LandAnswer> => {
        const pushed = await gitAsked([
          "push",
          `--force-with-lease=refs/heads/${branch}:${lease ?? ""}`,
          "origin",
          `HEAD:refs/heads/${branch}`,
        ]);
        if (Either.isLeft(pushed)) {
          return { notMerged: { reason: "push-rejected", detail: pushed.left.detail } };
        }
        lease = on.onSha;
        // The branch and not the arm: the lane is about to merge this ref, and
        // an arm written for a landing is one 0062 §4's sweep takes back off.
        // A lane that refuses leaves the arm to the end-of-pass publish, which
        // asks about `armPublished` and not only about this
        // (`publishWhatIsCommitted`).
        published = on.onSha;

        const result = await Effect.runPromise(
          repo.integrate({
            project,
            owner: options.client.owner,
            repo: options.client.repo,
            base,
            branch,
            workItemId,
            headSha: on.onSha,
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

      /**
       * `design` — the document into the worktree, and onto the branch (0066 §5,
       * `#300`).
       *
       * **Both, always.** The finalizer below removes the worktree on every
       * ending, and the only thing that gets out past it is what
       * `publishWhatIsCommitted` pushed — so a note that was written and not
       * committed is gone when the pass ends, together with everything the
       * locator points at. `filePlugin` is where that is argued and why there is
       * no field for the other answer.
       *
       * **The dep of a plugin and never a step's own work.** `design`'s default is
       * nothing (0065 §4), so there is no `defaultsAt` row for this and a recipe
       * that declares no `file:` never reaches it — which is what lets a
       * destination be turned on one machine at a time.
       *
       * Under `cwd`, which is the worktree and the only place a pass writes: the
       * path has already been refused by `whyThePathEscapes` when the recipe
       * resolved, so what is left here is `join` and the directories above it.
       * A trailing newline is added where the document has none, because a file in
       * a repository is read by `git diff` and by editors that both complain about
       * one that has not got one.
       *
       * **`notKept` and never a throw.** `design` may not refuse (0058 §3), and an
       * exception out of a plugin is a step that did not finish with no words on
       * it; this way the sentence a person reads is the write's own.
       *
       * **A commit that had nothing to commit is still kept, and it is asked
       * rather than inferred from the exit code.** Running the same ticket twice
       * writes the same bytes, and `git commit` exits non-zero on an empty index —
       * so *the file is already there* and *the commit was refused* arrive the same
       * way, and an unconditional `rev-parse` after both would report the base as
       * though the note had landed on it. `git diff --cached --quiet` separates
       * them first: nothing staged is kept at the head there already, and a commit
       * that then failed is `notKept`, because the evidence says *committed to the
       * branch* and that has to be true where it says it.
       */
      const keep = async (spec: {
        readonly path: string;
        readonly document: string;
      }): Promise<KeptAnswer> => {
        const at = join(cwd, spec.path);
        try {
          await mkdir(dirname(at), { recursive: true });
          await writeFile(at, spec.document.endsWith("\n") ? spec.document : `${spec.document}\n`, "utf8");
        } catch (error) {
          return { notKept: (error as Error).message };
        }

        // `-f`, so a project whose own `.gitignore` covers the path it asked for
        // is told by `git add` rather than by a note that silently never landed:
        // a plain `git add --` answers *the following paths are ignored* and
        // exits 0, and this keep would then report a commit it did not make.
        // Narrow by construction — the argument is the one path just written,
        // and `--only` below keeps the commit to it too.
        const added = await gitAsked(["add", "-f", "--", spec.path]);
        if (Either.isLeft(added)) return { notKept: `git add refused it: ${added.left.detail}` };
        // `--quiet` implies `--exit-code`, so a *right* here is *nothing staged*
        // and a left is a difference to commit — the one place in this file where
        // the failing branch is the ordinary one.
        const staged = await gitAsked(["diff", "--cached", "--quiet", "--", spec.path]);
        if (Either.isLeft(staged)) {
          // `--only`, so a commit at `design` cannot pick up anything else the
          // worktree happens to be holding: what this action is answering for is
          // the one path it wrote.
          const committed = await gitAsked([
            "commit",
            "-m",
            `docs(design): the shape for #${options.issue}`,
            "--only",
            "--",
            spec.path,
          ]);
          if (Either.isLeft(committed)) {
            return { notKept: `git commit refused it: ${committed.left.detail}` };
          }
        }
        const head = await gitAsked(["rev-parse", "HEAD"]);
        return Either.isLeft(head) ? { at: spec.path } : { at: spec.path, head: head.right };
      };

      /**
       * What a declared plugin needs in order to run — the things only a caller
       * with a machine under it can build (`PassOptions.actionsAt`).
       *
       * A reviewer, the diff's file list, an environment resolver, the cut and the
       * lane. This is `stepDeps` under its old name: turning a declared list into a
       * runnable action is neither the sequence nor the outcome rules, so by 0058
       * §2b it is the caller's and not the pass's.
       */
      const stepDeps = {
        env: envForExtension,
        agent: {
          runtime: options.runtime,
          issue: async () => took?.ticket ?? { ref: String(options.issue), title: "", body: "" },
          diff: () => gitOrDie(["diff", `${baseShaOr("HEAD")}...HEAD`]),
          // A getter, because `admit` is what writes it: `createAgentAction` and
          // `createDraftAction` read `deps.settingsPath` when the action *runs*,
          // which is at `design`, `review`, `proposed` or `merge` — so always
          // after `cut`, and since `#265` the first of those is the very next step.
          get settingsPath() {
            return reviewSettingsPath;
          },
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
        // The fourth, and the one that makes rather than judges: `admit`'s
        // `worktree:` action cuts through this (0065 §2, `#268`).
        worktree: { cut },
        // The fifth, and the only one that changes the base branch: `merge`'s
        // `merge:` action lands through this (0065 §2, `#270`).
        merge: { land },
        // The sixth, and the other one that makes rather than judges: `claim`'s
        // `queue:` action takes the ticket through this (0065 §2, `#269`).
        queue: { take },
        // The seventh, and the one that writes the change: `implement`'s `agent:`
        // action dispatches through this (0065 §1, `#266`). Its own row rather
        // than a field on `agent` above, because the two share only the key a
        // recipe writes — a cold reviewer wants a runtime and a diff, and this
        // wants the hook wired, the socket served and the receipt measured.
        //
        // An arrow rather than `{ work: dispatch }`: `dispatch` is declared six
        // hundred lines down, and this object literal is evaluated here.
        work: {
          work: (
            spec: { readonly prompt: string; readonly model?: string },
            context: ActionContext,
          ) => dispatch(spec, context),
        },
        // The eighth, and the one that neither makes nor judges: `design`'s
        // `file:` action keeps the document through this (0066 §5, `#300`). It has
        // no `defaultsAt` row, because `design`'s default is nothing — so nothing
        // reaches it unless a recipe declared a destination, which is what lets a
        // destination be turned on one machine at a time.
        file: { keep },
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
       * Placed after the declared checks and before whatever lands, which is where
       * the old loop asked: the recipe's own actions run first and the flag holds
       * what they let past. `heldBeforeTheLane` is that placement.
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

      /**
       * **What runs at a step the recipe says nothing about** — that step's
       * *default plugin*, and nothing else
       * ([0065](../../../doc/decisions/0065-the-default-is-a-plugin.md) §2–3).
       *
       * The default is an entry in the plugin system rather than a code path
       * beside it: the workflow guarantees the ten steps turn and no step has a
       * built-in implementation, so the behaviour a recipe gets for free arrives
       * here by name and is replaceable by writing one line in the file.
       *
       * **`admit` is the first row, and `#268` is what put it here.** `admit`
       * used to cut the worktree in its body, from `repo.base` and
       * `repo.submodules`, where no recipe could see, name or replace it. Now the
       * body is empty and this is what an unconfigured `admit` runs — the same
       * action a declared `worktree:` builds, over the same values, because
       * `baseOf` and `submodulesOf` are the one place that knows which spelling a
       * file used. So *the default cut* and *a pasted block that says what the
       * default did* are the same pass, which is what makes the block safe to
       * paste.
       *
       * **`merge` is the second row, and `#270` is what put it here.** It landed
       * the branch in its body, from `repo.base`, where no recipe could see, name
       * or replace it. Now the body is empty and this is what an unconfigured
       * `merge` runs — the same `integrate` call a declared `merge:` builds, over
       * the same base, because `land` above is handed the base by the pass rather
       * than reading one off the action (0061 §4). So *the default merge* and *a
       * pasted block that says what the default did* are the same landing.
       *
       * **`claim` is the third row to arrive and the first in the list, and `#269`
       * is what put it here.** The three paragraphs above are in the order the
       * tickets opened their keys; the branches below are in **step order**, which
       * is the order a reader of a pass meets them, and the two disagree only
       * because `claim` moved last. It took the item in its body, from `source:`
       * and `runtime.assignee`, where no recipe could see, name or replace it. Now
       * the body is empty and this is what an unconfigured `claim` runs — the same
       * action a declared `queue:` builds, over the same four values, because
       * `queueOf` is the one place that knows which spelling a file used. So *the
       * default take* and *a pasted block that says what the default did* select
       * over one list of kinds, which is what makes the block safe to paste.
       *
       * **`design` opened a key here and took no row, and that is the decision
       * rather than an omission** (`#265`). 0065 §4's table names *an `agent:`
       * that drafts* as its default, and what this step actually did was
       * `ports.draft` answering `{ document: "" }` — a port that dispatched
       * nothing, because no plugin served `design`. So the default *is* nothing,
       * and writing a drafting agent in here instead would not be moving the work
       * out of the body: it would buy an agent on every pass of every project
       * whose recipe never mentioned `design`, which is §7's footgun and not §2's
       * decision. A recipe that wants one writes it, and that is the capability
       * the key is for; the three rows below stay the three things that *did*
       * happen in a body.
       *
       * **And it is the one row that cannot be wrong loudly** (`#269`). A replaced
       * `admit` starts nothing and a replaced `merge` lands nothing, and each of
       * those shows on the card as a step that ran and a thing that did not happen.
       * A replaced `claim` cannot fail that way — `queue:` is the only kind legal
       * at this step and a second one is refused by name (`step-matrix.test.ts`),
       * so the substitution here is never *nothing takes the ticket*: it is **a
       * different four values taking a different ticket**, which looks like an
       * ordinary pass about an issue somebody did not expect, or like a machine
       * with nothing to do. There is no verdict that tells those apart, which is
       * why the accessors are the seam: a pasted block and an unpasted one reach
       * `runnableNow` through `queueOf`, and `lingtai add` reads the file back.
       *
       * **`[]` and an omitted key are the same thing here, and 0065 §2's *`[]`
       * runs nothing* is not built.** `StepMap` resolves both to `[]` (0061 §5:
       * *the file may omit a step; the resolved recipe may not*), so by the time a
       * list reaches this seam the difference is gone — the refusal that would
       * keep them apart belongs at resolve, on the file's own bytes, and 0065 §6
       * is where it is written down. Until it lands, an `admit: []` cuts and a
       * `merge: []` merges.
       *
       * **That is the safe direction and it is deliberate**, because the other
       * reading is 0065 §6's silent failure with this repository's own recipe as
       * the subject: `admit: []` and `merge: []` mean *skipped* in every recipe on
       * the machine today, and a diff that made the first mean *cut nothing* would
       * stop every pass at the first step that needs a tree, while the second
       * would stop merging in a daemon nobody had told to expect it. So the blocks
       * `#270` prints are safe to paste and safe not to paste, and the day `[]`
       * starts meaning nothing is a version bump and a refusal rather than a
       * change of behaviour under an unchanged file.
       *
       * **And a recipe that declares something *else* at `merge` no longer
       * lands**, which is the substitution rule doing exactly what it says (0065
       * §2) rather than a hole: the default is replaced, nothing in the list
       * merges, `landedAt()` stays null and the pass falls through to the
       * requeued or failed ending rather than reporting a landing it did not
       * make. A recipe that wants checks *and* the merge declares both, which is
       * what the printed block is for.
       */
      const defaultsAt = (step: Step): readonly Action[] => {
        if (step === "claim") {
          return [
            createQueueAction({ name: "take the ticket", ...queueOf(recipe) }, { take }),
          ];
        }
        if (step === "admit") {
          return [
            createWorktreeAction(
              { name: "cut the branch", base, submodules: submodulesOf(recipe) },
              { cut },
            ),
          ];
        }
        if (step === "implement") {
          /**
           * **The agent that writes the change, where the recipe names none**
           * (0065 §1, `#266`).
           *
           * Unlike `design`, this row is not optional: the port it replaced
           * dispatched on every pass, so *behaves exactly as it does today* means
           * an unconfigured `implement` still buys the one agent — on
           * `runtime.agent`, which is what `dispatch` runs and what a recipe's own
           * `agent:` is held to by `agentRefusal` before the claim.
           *
           * `prompt: ""` because the implementer's brief is `options.prompt`,
           * rendered with the ticket and the design. A recipe's `prompt:` is
           * appended to that and never substituted for it — the rule the cold
           * reviewer follows — so the default adding nothing is the default
           * changing nothing.
           */
          return [createWorkAction({ name: "write the change", prompt: "" }, { work: dispatch })];
        }
        if (step === "merge") {
          // The strategy `mergePlugin`'s schema defaults to, because `integrate`
          // offers one — and no base, for the reason that plugin declares none:
          // the base is one value that flows, and `land` above already has it, so
          // *the default merge* and *a pasted block that says what the default
          // did* cannot land onto different branches (0061 §4).
          return [createMergeAction({ name: "land the branch", strategy: "merge-commit" }, { land })];
        }
        return [];
      };

      const actionsAt = (step: Step, actions: readonly StepAction[]): readonly Action[] => {
        const declared = actionsFromRecipe(step, actions, stepDeps);
        // **A default replaces what would have run; a hold composes with it**
        // (0065 §3). That is why `alsoHeldAtMerge` stays outside the substitution
        // and composes either way: `--no-merge` holds a recipe that declares
        // nothing at `merge` exactly as it holds one that declares a person.
        const running = declared.length > 0 ? declared : defaultsAt(step);
        return step === "merge" ? heldBeforeTheLane(running) : running;
      };

      /**
       * **Where a hold at `merge` goes once the lane is in the list** (`#270`).
       *
       * It was `[...running, ...alsoHeldAtMerge()]`, and that was right while the
       * landing happened in `merge`'s *body* — after the whole pipeline, so an
       * appended hold stopped it. Since `mergePlugin` serves `merge` the landing is
       * an action in this list, and appending after it is `#58` again: the
       * pipeline would merge the branch and then ask a person whether to.
       *
       * So the hold goes **after everything that checks and before the thing that
       * lands**, which is the same sentence the old order was saying. `--no-merge`
       * is what catches getting it backwards, and it does: with nothing declared
       * the list is the hold and then the lane, and the integrator is never
       * reached (`conduct-a-whole-pass.test.ts`).
       *
       * Found by `kind` rather than by position, because a recipe may declare its
       * own `merge:` with checks written **before** the lane — and a `--no-merge`
       * that was a no-op for such a recipe would be a flag that silently stopped
       * meaning anything. Before, and not either side: `actionsAt` refuses anything
       * written after the lane (0065 §8), so the list this searches is checks and
       * then the lane, and the index it finds is the last entry or nothing.
       */
      const heldBeforeTheLane = (running: readonly Action[]): readonly Action[] => {
        const held = alsoHeldAtMerge();
        if (held.length === 0) return running;
        const lands = running.findIndex((action) => action.kind === "merge");
        return lands === -1
          ? [...running, ...held]
          : [...running.slice(0, lands), ...held, ...running.slice(lands)];
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
       *
       * **And the receipt is measured from where the tree stands now, not from
       * where it was cut** (`#265`). See `startedAt` below.
       */
      /**
       * **A recipe's `prompt:` at `implement`, appended and never substituted**
       * (`#266`) — the rule `buildDesignPrompt` and `createAgentAction` already
       * follow, and the same heading, so an agent meets one convention.
       *
       * A project can add what it cares about; it cannot remove the ticket, the
       * design, or the refusal a round was bought on. `""` — which is what
       * `defaultsAt` writes — adds nothing at all, so a recipe that declares
       * nothing gets the prompt it got before this key existed, byte for byte.
       */
      const alsoSays = (prompt: string, extra: string): string =>
        extra === "" ? prompt : `${prompt}\n\n## Also for this project\n\n${extra}\n`;

      const firstDispatch = async (
        brief: Brief,
        spec: { readonly prompt: string; readonly model?: string },
      ): Promise<Worked> => {
        const tree = cutTree();
        /**
         * **Where this agent found the tree** — and the whole of what the receipt
         * below is measured against (`#265`).
         *
         * It was `tree.baseSha`, which is the same commit for as long as `implement`
         * is the first step that may write one. `design` may since `agentPlugin`
         * declared it: a recipe's drafting agent runs in *this* worktree, unhooked
         * and writable, and a document it committed there would move `HEAD` past the
         * base before this is called. `tree.baseSha` then reads *something was
         * committed* for a run that committed nothing, which is 0057 §2's one guard
         * answering about the wrong agent — and the pass would go to `build` and
         * `review` on a branch holding a design note and no implementation, with
         * `RunProposedCompletion` naming the drafting agent's commit as this run's.
         *
         * So it is asked rather than assumed, which is what `fixRound` already does
         * one function down: it compares against `brief.context.onSha`, *the head
         * this round is about*, for this reason a round earlier. The prompt telling a
         * design agent not to commit stays where it is and is not what makes this
         * true: prose in a prompt is not a guard, and the agent that ignores it is
         * exactly the one the guard is for.
         */
        const startedAt = await gitOrDie(["rev-parse", "HEAD"]);
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
                        // The recipe's `model:` where it named one, and the
                        // runtime's own default where it did not (0063 §2) —
                        // which is what the empty string has always meant here.
                        model: spec.model ?? "",
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
                      type: "StepsResolved",
                      actor: "conductor",
                      data: parsePayload("StepsResolved", stepsResolved(runId, resolved)),
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
                    prompt: alsoSays(
                      renderPrompt(
                        options.prompt,
                        { number: Number(brief.ticket.ref), title: brief.ticket.title, body: brief.ticket.body },
                        next.failure,
                        // **What `design` produced, and this is the one reader of
                        // it** (`#265`). `Brief.design` has been on this object since
                        // the brief existed and nothing here read it, which cost
                        // nothing while the port that filled it answered `""` on every
                        // pass. `agentPlugin` serves the step now: a recipe declaring
                        // an `agent:` there buys a document, and a document nothing
                        // hands on is an agent run bought by a line in the recipe whose
                        // answer no reader ever sees. `""` renders as it always did.
                        //
                        // **The document and not the locator** (`#297`). The built-in
                        // dispatch is a file-reading plugin's opposite: it fetches
                        // nothing, so it renders the copy the pass is already holding
                        // and never learns what kind of string `TheDesign.locator` is
                        // (0066 §4). A plugin at `implement` that wants the location
                        // reads it off `context.design` itself.
                        brief.design.document,
                      ),
                      // The recipe's own words at `implement`, appended (`#266`).
                      spec.prompt,
                    ),
                    ...(spec.model === undefined ? {} : { model: spec.model }),
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
          await appendFrom(runId, version, [
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

        await appendFrom(runId, version, [
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
        // **The commit is the receipt** (0057 §2), and it is *this* agent's commit:
        // `startedAt` and not `tree.baseSha`, so a step before this one that left a
        // commit of its own cannot stand in for one. An agent that ran and committed
        // nothing left no receipt, and the pass stops rather than buying a round to
        // fix a diff that does not exist.
        if (head === startedAt) return { stopped: "the agent produced no commits" };
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
      const fixRound = async (
        brief: Brief,
        again: NonNullable<Brief["again"]>,
        spec: { readonly prompt: string; readonly model?: string },
      ): Promise<Worked> => {
        const tree = cutTree();
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
          Effect.either(host.unhookedSettings({ runId, label: `fix-${round}`, home })),
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
                    prompt: alsoSays(
                      fixBrief({
                        refusal,
                        round,
                        of: limits.rounds,
                        action: from,
                        diff: underReview,
                        diffBytes: recipe.runtime.budget.diff,
                      }),
                      spec.prompt,
                    ),
                    ...(spec.model === undefined ? {} : { model: spec.model }),
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
          // Whose wall it was, for the sentence the pause carries (`fixWall`).
          fixWall = { action: from, round };
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

      /**
       * **What the `agent:` at `implement` wraps** (`#266`) — and the brief is
       * built here now rather than by the step's body.
       *
       * The three things a brief is made of reach it three ways, and all three
       * are already facts somebody else made: the ticket is what `claim`'s
       * `queue:` action took and this closure is holding, and the design and the
       * *why again* are folds over the visit list that `runStep` puts on the
       * context (`designOn`, `sentBackTo` in `pass.ts`). Nothing is remembered
       * twice.
       *
       * **`again` is still what decides which of the two dispatches runs**, and
       * that has not moved: a first visit renders the implementer's prompt, and a
       * round the judge bought renders `fixBrief` against what the refusal said.
       *
       * The throw is `madeBy`'s, which is the shape this replaces: a pass reaches
       * `implement` only after `claim` passed, and `claim` passes only on a take,
       * so no item here is the pass's own bookkeeping gone wrong. The pipeline
       * turns it into this action's verdict and the pass still reaches `end`.
       */
      const dispatch = async (
        spec: { readonly prompt: string; readonly model?: string },
        context: ActionContext,
      ): Promise<Worked> => {
        if (took === null) {
          throw new Error(
            "the `implement` step has no item — the step that makes it did not run, " +
              "and the spine says it did. This is the pass's own bookkeeping and not a " +
              "judgement about the change.",
          );
        }
        const brief: Brief = {
          ticket: took.ticket,
          design: context.design ?? NO_DESIGN,
          again: context.again ?? null,
          context,
        };
        return brief.again === null
          ? firstDispatch(brief, spec)
          : fixRound(brief, brief.again, spec);
      };


      // **Six, and none of `cut`, `take`, `land` or `draft` is one of them**:
      // `admit`'s work is a `worktree:` action (`#268`), `claim`'s is a `queue:`
      // one (`#269`), `merge`'s is a `merge:` one (`#270`) and `design`'s is an
      // `agent:` one (`#265`), all four reached through `stepDeps` like every
      // other plugin's. `draft` is the one of the four that left no dep behind:
      // the drafting agent is built from `stepDeps.agent`, which the cold
      // reviewer already needed.
      //
      // `item` and `onStream` are what the `take` row left behind, and they ask
      // rather than do: the fact is this closure's, made by the dep above and read
      // back by the bodies that need it, exactly as `cutTree` is (`#268`). Both are
      // synchronous, because there is nothing to await — the pass's own `claim`
      // step has already run the action that filled them.
      const ports: PassPorts = {
        onStream: () => onStream,
        judge,
        readEnd,
        recordEnd,
      };

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

      /**
       * **A store that refused an append is not a step's verdict about the
       * change, however the walk reported it.**
       *
       * `runStep` catches whatever a step throws and reports *did-not-finish:
       * threw* (`pass.ts`), which is right for a body that failed and wrong for
       * the store underneath it: the ending below would read that as `blocked`,
       * park the item on *Waiting on you* over a dropped connection and ask a
       * person to acknowledge a diagnosis naming a step that did its work. So
       * the defect is raised here instead, before a word of the ending is
       * written, and the handler at the bottom answers it as it answered every
       * append the old engine made — the item is released, the pass ends
       * `unexpected`, and the queue takes it again after the backoff.
       *
       * Only the appends nothing else answers for: the tolerant three call
       * `appendAt`, having already decided their row costs less than the ending
       * it is about (`appendNow`).
       */
      if (unappended !== null) {
        log(`the store refused an append during the pass: ${whyOf(unappended)}`);
        return yield* Effect.die(unappended);
      }

      log(`pass: ${pass.steps.map((v) => `${v.step}=${v.ending.ending}`).join(" ")}`);
      /**
       * **Every decision the router made, on the log** (`#271`).
       *
       * The note below is what `lingtai attach` and the task page's run log show
       * while a pass is in flight, and it stays: a trace is what answers *what is
       * it doing now*. What it cannot answer is *why did that pass buy a round*,
       * because the file is deleted on the ending where the change landed (0034),
       * so until this append existed the one decision the whole loop turns on was
       * the one thing no ending recorded.
       *
       * One append rather than one per route: they were all decided by the walk
       * that has just returned, and a reader asking what a pass did wants them
       * whole or not at all. An empty list appends nothing — a pass that sailed
       * through decided nothing, and `pass.steps` already says it got through.
       *
       * **`appendAt` and a swallowed refusal, which is `noteRefs`' rule and not a
       * laxness**: *the account never costs the thing it is an account of.* This
       * is the only store write between the walk returning and the landing's own
       * `appendNow(workItemId, [WorkItemLanded, ...endPlan])`, because
       * `publishWhatIsCommitted` is skipped on a landing — so a strict append
       * here would let a dropped connection on a purely informational row reach
       * the defect handler, release an item whose branch is already on `main`,
       * leave `end`'s plan unresolved and hand the ticket to a second pass that
       * reworks a merged change. A route nobody can read back is worth less than
       * that by any measure, so it is said and not raised. `appendAt` is what
       * this class of caller is for (`appendNow`'s own doc).
       */
      for (const route of pass.routes) {
        runLog.note("route", `${route.from} → ${route.to}: ${route.why}`);
      }
      if (pass.routes.length > 0) {
        yield* Effect.promise(async () => {
          try {
            await appendAt(
              runId,
              pass.routes.map((route) => ({
                type: "PassRouted" as const,
                actor: "conductor",
                data: parsePayload("PassRouted", {
                  from: route.from,
                  chose: route.chose,
                  to: route.to,
                  why: route.why,
                  ceiling: route.ceiling,
                }),
              })),
            );
          } catch (defect) {
            const why = whyOf(defect);
            runLog.note("route", `the ${pass.routes.length} route(s) were not appended — ${why}`);
            log(`PassRouted was refused by the store: ${why}`);
          }
        });
      }

      const outcome = outcomeOf(pass);
      // For `release`, which is declared above this scope and has to know which
      // outcome the plan it is holding is about (`endedAs`).
      endedAs = outcome;
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
      /**
       * **What a person can be asked to merge: the head this pass put on origin
       * for `branch`, or null where it put none there.**
       *
       * `headSha` cannot answer that, and the gap is not small. `headReached` is
       * the last `head` a *visit* reported and `admit` reports the base sha so that
       * the head the pass is judged against always has a value (`pass-steps.ts`),
       * so it is the commit the worktree was **cut** at on every ending whose step
       * moved the tree without reporting it. Binding a request to that asks a
       * person to merge `agent/<n>@<base>` while origin holds this pass's actual
       * commits at another sha: `approve()` compares the two, refuses every one as
       * `stale`, and until somebody clicks it the board draws the item
       * `awaitingApproval` at a sha nothing is at (`#92`, and `#84`'s *a card
       * offers the move that is left, never a control that refuses*). The endings
       * that stop at `implement` are the widest such gap and no longer ask at all
       * — nothing judged them, see `judged` below — so what this now carries is the
       * other half: a push origin refused.
       *
       * `published` is set by the publish a few lines above — the one ending that
       * skips it is a landing, which does not reach here — so it is exactly *what
       * is fetchable under `branch` right now*: null where nothing was committed,
       * null where origin refused the leased ref (`arm-only`, a broken transport),
       * and the head itself where the push went. Where it is null there is nothing
       * to approve and the block below is the whole of what a person is told, which
       * is what the old engine did on both endings that reach a person without a
       * commit.
       */
      const onOrigin = published;
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
          /**
           * A hold and a route to a person are both *decide something*; a step that
           * reported a machine failure is *look at this*.
           *
           * **And a step that stopped to ask is *decide something* too** (`#294`,
           * the fix round). The line above was written while every
           * `did-not-finish` reaching a person was a crash or a turn limit, which
           * is what *acknowledge* is the right word for. `design` asking a question
           * it cannot design without is the arrival that made it false: a card
           * reading *a failure needs acknowledging* over a question asks the
           * operator to tick off something that did not fail, and the thing the
           * pass is actually waiting for — an answer — is a judgement.
           * **`asked` is the ending rather than a token on one** (`#296`): this
           * read was `did-not-finish` plus `because === NEEDS_INPUT` and is now
           * the same fact the router branches on, so the card and the router
           * cannot disagree about which arrivals held a question.
           *
           * No recommendation goes with it, and that is right rather than
           * missing: `BlockRecommendation` is `approve`, `reject` or `requeue` —
           * *a recommendation the board cannot carry out would be a sentence* —
           * and none of the three answers a question.
           */
          needs:
            stopped === null ||
            stopped.ending.ending === "held" ||
            stopped.ending.ending === "asked"
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
            /**
             * **Approve is recommended exactly where every step passed** — and
             * since `#256` a hold at `merge` is one of those.
             *
             * `stopped === null` alone is not the good hold any more. `--no-merge`
             * and a pre-`#143` repair are `human:` actions injected after
             * `merge`'s declared list (#20), so the ordinary self-hosted ending —
             * green run, operator asked it not to merge — now ends `held` at
             * `merge` with `stoppedAt` set, and the card lost the one
             * recommendation #83 calls the good hold: `standing.tsx` drew no
             * recommended move and `page.tsx` passed `recommended={null}`.
             *
             * **`merge` and not any held step**, because the walk is what makes
             * the sentence true: a step only holds once every step before it has
             * passed, and `merge` is the last of the nine before `end` — so
             * *every step passed on this diff* is arithmetic there and a false
             * claim at `build`, where `review` and `proposed` never ran.
             *
             * Findings still veto it. A `review` may pass carrying them (0058
             * §3b), and approving over a live finding is the one judgement
             * nothing but a person should make.
             */
            recommendation:
              findings.length === 0 &&
              (stopped === null ||
                (stopped.step === "merge" && stopped.ending.ending === "held"))
                ? {
                    action: "approve" as const,
                    why: "every step passed on this diff; approving merges what this run produced",
                  }
                : null,
          },
        };
      };

      /**
       * **`claim` took nothing, so there is no item here to write on** — and
       * this is the one ending that must reach none of the three below.
       *
       * `claim` cannot refuse (0058 §2, `pass-steps.ts`): its three declines are
       * `did-not-finish` with `passed-over`, `not-claimed` or `claim-unconfirmed`,
       * and `ARRIVE_AT_THE_ROUTER` does not include the step — so `stoppedAt` is
       * `{step: "claim"}` and `outcomeOf` reads any non-`never-ran` stop as
       * `blocked`. Left to fall through, the blocked branch appends
       * `ApprovalRequested` to a run stream with no `RunStarted`, appends
       * `WorkItemBlocked` to `workItemId`, comments **Lingtai is waiting on you**
       * and sets `lingtai:waiting` — for an item this pass never claimed.
       *
       * Both declines are worse than noise. `passedOver` is `runnableNow` saying
       * GitHub is not offering it — `agent:hold`, a blocker, an assignee — and a
       * block there takes the ticket out of `queued`, which is the state
       * `selectRunnable` requires (`queue.ts`), so removing the label no longer
       * makes it runnable. `notClaimed: held` is **another conductor's live
       * item**: the block replaces that item's lifecycle and relabels its issue
       * while its agent is still working. The old engine returned `discover`/
       * `claim` here and wrote nothing at all.
       *
       * So: nothing is appended and nothing is told. `released` is set because
       * the `ensuring` at the bottom would otherwise append `WorkItemReleased`
       * and write `lingtai:queued` over exactly those two items —
       * `releaseWorkItem` appends whoever holds it.
       *
       * **`claim-unconfirmed` is the exception, and it is the reason `Taken` has
       * four cases.** The append may have committed and then lost its
       * connection, so the item may be held *by this run* — and giving back
       * something this run may hold is the one honest move. `end` has already
       * resolved against that stream (`onStream` is set for this decline alone),
       * and the release does **not** record that resolution: the outcome the pass
       * computed for a stop at `claim` is `blocked`, and what the release makes
       * true is that the item is back in the queue. Nothing is recorded and
       * nothing is carried out, so the pass that does reach an ending resolves it
       * (`endPlan`, `release`).
       */
      if (stopped?.step === "claim") {
        const why = detailOf(stopped);
        const mayHold =
          stopped.ending.ending === "did-not-finish" &&
          stopped.ending.because === "claim-unconfirmed";
        if (mayHold) yield* release(`the claim was not confirmed: ${said(why)}`);
        released = true;
        log(`nothing claimed: ${said(why)}`);
        return {
          ok: false,
          workItemId,
          runId,
          stage: "claim",
          detail: why,
        } satisfies RunOnceResult;
      }

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
            // **In the same append as the landing, so the two cannot come apart**
            // (`end-step.ts`, `endPlan`). The pass resolved this against `landed`
            // before this line and appended nothing; one transaction is what makes
            // an `EndActionsResolved{landed}` over an unrecorded landing
            // unreachable rather than merely unlikely.
            ...endPlan,
          ]),
        );
        endResolved = endPlan;
        // What is left is telling the issue, which reads the plan that was just
        // appended rather than the stream.
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
      /**
       * **The arm is on origin before anything names it, or no restart is
       * recorded at all** (0040, 0062 §2).
       *
       * `publishWhatIsCommitted` above is deliberately tolerant — a
       * `--force-with-lease` a sibling claim invalidated, or a dropped network,
       * returns git's words and pushes nothing — and every other ending is right
       * to go on regardless: a person is still owed the question, and is told the
       * branch is not there. **A restart is the one ending that cannot.** It
       * spends one of `limits.restarts`, and the event it appends promises the
       * next agent a ref to `git fetch` (`attempts.ts`). Recorded over a refused
       * publish it spends the ceiling, names a ref that never existed, and the
       * worktree holding the commits is deleted by the finalizer a moment later.
       *
       * The old engine pushed strictly before the append and said why in as many
       * words: *a push that is refused must leave no arm on the log.* This is
       * that rule, asked of the publish that already ran rather than of a second
       * push — which also keeps the `arm-only` case a restart, because there the
       * command exited non-zero and the arm **is** up.
       *
       * Where it is not, the pass falls through to the `failed` ending below: no
       * restart is consumed, the reason there already carries `unpushed`, and the
       * item comes back through the backoff with its ceiling intact.
       */
      const armIsUp = armPublished !== null && armPublished === headSha;
      if (pass.rested === "requeued" && !armIsUp) {
        runLog.note(
          "restart",
          `no restart was recorded — ${arm} is not on origin at ${headSha.slice(0, 7) || "the base"}`,
        );
        log(`not starting over — ${arm} was not published, so no restart is spent`);
      }
      if (pass.rested === "requeued" && armIsUp) {
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
        /**
         * **Something judged this diff and said no** — the second half of when a
         * person may be offered *merge it anyway*, and the half `onOrigin` cannot
         * answer.
         *
         * Two shapes, and they are the two the old engine asked on. `stopped ===
         * null` is the router having sent the pass to a person: `proposed` weighed
         * an arriving refusal, or a `review` that passed carrying findings, and
         * spent what it had — `unfixed` and `disagreement` under the old engine.
         * A `refused` ending is a step's own declared actions refusing, which is
         * the `build` gone red and the lane that would not take it.
         *
         * **Every other blocked ending judged nothing, and must not offer the
         * control.** `did-not-finish` at `implement` is the `#237`/`#249` shape —
         * an agent stopped at `runtime.limits.turns` having committed twice — and
         * `admit`'s is a clone that did not finish. Asked there, `ApprovalRequested`
         * sets `task_view.awaitingSha`, `standing.tsx` draws **Approve**, and
         * `refusingOn` (`approve.ts`) finds nothing to be refusing — the pass stopped
         * at `implement`, so `build` and `review` never ran and left no row — so one
         * click merges a half-finished diff the build and the cold reviewer never
         * read, with no `note`, no `StepWaived` and nothing on the log saying
         * anything was skipped. On a card whose own diagnosis reads *the limit is a
         * scope alarm … requeue*. The old engine appended no request on that ending
         * and Requeue was the only move offered; this is that, as a predicate
         * rather than as a list of endings.
         *
         * A plugin that asked for a person has already had its own request emitted
         * by the pipeline, which is what `held` excludes — and the request is only
         * worth making where origin is holding something to merge (`onOrigin`).
         */
        const judged = stopped === null || stopped.ending.ending === "refused";
        if (!held && judged && onOrigin !== null) {
          /**
           * **The request is named for itself, never for the action that
           * refused** — and naming it after that action destroys the thing it
           * exists to report.
           *
           * `task-view.ts` folds `StepFailed` and `ApprovalRequested` through one
           * `setStep`, keyed `${runId}:${gate}:${action}`, with
           * `VERDICT.ApprovalRequested = "pending"`. So a `build` refused by a
           * `run:` action called `test` writes `verdicts[<run>:build:test] =
           * "failed"`, and a request carrying that same pair overwrites it with
           * `pending`: the card's `failed` count drops to zero and the board
           * shows a change that was refused as merely waiting — on every
           * projection and every rebuild. The old engine named its request
           * `unfixed` for exactly this reason, and wrote the collision out at
           * the append.
           *
           * The pointer travels in the question instead, which is what a person
           * reads.
           */
          const refusedBy = whatRefused(stopped);
          yield* Effect.promise(() =>
            appendNow(runId, [
              {
                type: "ApprovalRequested",
                actor: "conductor",
                data: parsePayload("ApprovalRequested", {
                  step: stopped?.step ?? "proposed",
                  action: stopped === null ? "judge" : "unfixed",
                  runId,
                  // What is on origin, never what the walk last reported: see
                  // `onOrigin`. The two are the same sha wherever a declared
                  // action refused, which since `judged` is the only ending that
                  // reaches here — and this stays the field that says so, because
                  // that is a fact about the push and not about the walk.
                  onSha: onOrigin,
                  question:
                    `Merge ${branch} into ${base} anyway? ${said_.question}` +
                    (refusedBy === null ? "" : ` (\`${refusedBy}\`)`),
                  artifacts: [`${branch}@${onOrigin}`],
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
            // In the same append as the block, for the landing's reason: a
            // `when: blocked` action recorded as carried out for a block the log
            // does not carry is the same orphan one ending along (`endPlan`).
            ...endPlan,
          ]),
        );
        endResolved = endPlan;
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
        const round = wallMetBy();
        yield* standDownConductor(
          // A `never-ran` at `implement` is the *run's* wall — **unless the agent
          // there was a round's rather than the implementer's**, which is the one
          // thing `StepNeverRan` cannot say and `fixWall` is recorded for. At any
          // other step it is a declared plugin's agent, which 0041 §3 reuses this
          // whole mechanism for.
          //
          // **The cell is open since `#266` and the sentence did not change.** It
          // used to read *`implement` has no cell open, so this is the body's own
          // stand-down*; the stand-down is `createWorkAction`'s now, and it is the
          // same wall met by the same runtime on the same brief — so `{of: "run"}`
          // is still what a person is owed, and `at` is the action's name rather
          // than the runtime's, which this branch has never read.
          //
          // **`design` was beside `implement` on the `{of: "run"}` line until
          // `#265`, on the premise this comment stated: that it had no cell open.**
          // `agentPlugin` declares the step now, so a `never-ran` there can only be
          // a declared action's — the body dispatches nothing and `defaultsAt` has
          // no row — and the pause has to name it. Its own variant rather than
          // `{of: "step"}`'s, because that sentence ends *nothing judged the diff*
          // and there is no diff one step before `implement`.
          round !== null && stopped.step === "implement"
            ? { of: "fix", action: round.action, round: round.round }
            : stopped.step === "implement"
              ? { of: "run" }
              : stopped.step === "design"
                ? { of: "draft", step: `design:${at ?? "agent"}` }
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
