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
 *   the diff → `proposed` → `merge`         each refusal typed and recorded
 *   → integrate                             a point with actions always runs
 *
 * **Every exit appends.** A run that ends leaves either `RunFinished` or
 * `RunFailed`, and a work item that does not land is either released or blocked
 * with a question. The old loop could end in silence in at least seven places;
 * that is the thing being replaced.
 *
 * It used to say so and then keep the promise by hand: two nested `finally`
 * blocks and a `catch (err)` whose own comment admitted what it was. Since
 * [0026](../../../doc/decisions/0026-the-conversion-past-the-seam.md) the
 * promise is structural instead.
 *
 * **Three things a run acquires, and one scope each.** The worktree, the hook
 * socket and the agent process are `Effect.acquireRelease` pairs, so each is
 * released because its scope closed — on the happy path, on a typed refusal, on
 * a defect and on an interruption alike. The scopes also encode an ordering
 * that used to be a comment beside an explicit call: *the worktree is gone
 * before the integrator runs*, because the integrator is outside its scope.
 *
 * **The refusals come first, deliberately.** Everything up to the claim
 * acquires nothing, so a run that stops at an unreadable recipe or a missing
 * environment value has provisioned no worktree to release — the lesson 0024
 * recorded about where a scope *starts*, kept here as a test rather than as an
 * intention.
 */
import { type ResolvedRecipe, baseDivergence, parseDuration } from "@lingtai/recipe";
import { type Tier, parsePayload } from "@lingtai/domain";
import { type PipelineResult, gatesFromRecipe, runGatePipeline } from "@lingtai/actions";
import type { GitHubClient } from "@lingtai/github";
import { type Runtime, missingForTier } from "@lingtai/agent";
import { type EventStore, eventStore } from "@lingtai/event-store";
import { claimWorkItem, releaseWorkItem } from "./claim.ts";
import { type ToAppend, workItemStream } from "@lingtai/domain";
import { runnableNow } from "./discover.ts";
import { appendEndActions, resolveEndActions } from "./end-point.ts";
import { labelsFor } from "./labels.ts";
import { tellGitHubAbout } from "./tell.ts";

import { GATE_POINTS, type ProjectState } from "@lingtai/domain";
import { runnableEnv } from "@lingtai/agent-env";
import { stateDir } from "@lingtai/env";
import type { TokenSource } from "@lingtai/repo";
import { Data, Effect, Either } from "effect";
import { AgentHost, Repo } from "./ports.ts";
import { spawn } from "node:child_process";

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

/**
 * Fills the ticket into the prompt.
 *
 * `{{issue}}` was the only placeholder, and a number is not a ticket. The
 * others are substituted whether or not the template uses them, so a project
 * that writes its own prompt can leave any of them out.
 */
export function renderPrompt(
  template: string,
  ticket: { number: number; title: string; body: string },
): string {
  return template
    .replaceAll("{{issue}}", String(ticket.number))
    .replaceAll("{{title}}", ticket.title)
    .replaceAll("{{body}}", ticket.body);
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
    const promptVersion = options.promptVersion ?? "ticket@1";

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

    const claimed = Effect.gen(function* () {
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
              gates: gatesFromRecipe(recipe.gates.prepared),
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
                  onLifecycle: (_r, hook) => {
                    if (hook === "Stop") proposedSha = "pending";
                  },
                })
                .pipe(failing("hook"));

              // ---- 8. RunStarted, then the agent --------------------------
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
                    prompt: renderPrompt(options.prompt, ticket),
                    settingsPath: wiring.settingsPath,
                    env: runnableEnv({ ...env.values, ...wiring.env }),
                    limits: {
                      turns: recipe.runtime.limits.turns,
                      wallMs: parseDuration(recipe.runtime.limits.wall),
                    },
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
            return yield* new Stopped({
              stage: "run",
              detail: outcome.failure.detail,
              release: `run failed: ${outcome.failure.kind}`,
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

          // ---- 9. the diff the `proposed` gates will be about ----------------
          const headSha = yield* gitInWorktree(["rev-parse", "HEAD"]).pipe(failing("diff"));
          const stat = yield* gitInWorktree([
            "diff",
            "--numstat",
            `${worktree.baseSha}..HEAD`,
          ]).pipe(failing("diff"));
          const rows = stat.split("\n").filter(Boolean).map((l) => l.split("\t"));
          const insertions = rows.reduce((n, r) => n + (Number(r[0]) || 0), 0);
          const deletions = rows.reduce((n, r) => n + (Number(r[1]) || 0), 0);

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
                files: rows.length,
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
            agent: {
              runtime: options.runtime,
              issue: async () => ({
                ref: String(ticket.number),
                title: ticket.title,
                body: ticket.body,
              }),
              diff: () => gitForGates(["diff", `${worktree.baseSha}...HEAD`]),
              settingsPath: wiring.settingsPath,
              limits: {
                turns: recipe.runtime.limits.turns,
                wallMs: parseDuration(recipe.runtime.limits.wall),
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
          const gates = gatesFromRecipe(recipe.gates.proposed, gateDeps);
          const pipeline = yield* Effect.promise(() =>
            runGatePipeline({
              point: "proposed",
              gates,
              context: { runId, onSha: headSha, cwd: worktree.path, env: runnableEnv(env.values) },
              emit: async (event) => {
                const at = (await store.read(runId)).length;
                await store.append(runId, at, [
                  { type: event.type, actor: "conductor", data: event.data },
                ]);
              },
            }),
          );
          log(`gates: ${pipeline.results.map((r) => `${r.gate}=${r.verdict}`).join(" ")}`);

          // The agent's branch has to exist on the remote for the integrator to
          // merge it; it works in a worktree, not on origin.
          yield* gitInWorktree([
            "push",
            "--force-with-lease",
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
                  onSha: headSha,
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

          return { headSha, pipeline, atMerge };
        }),
      );

      // And the worktree has done its job: the scope above closed and took it
      // down. Everything below runs without one.
      const { headSha, pipeline, atMerge } = decided;

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
      if (pipeline.heldAt !== null || atMerge.heldAt !== null || options.merge === false) {
        // `heldAt` is an *action* name; the point is the pipeline it came from.
        // The operator's `--no-merge` is a hold at the `merge` point that names
        // itself as the action, so a card tells it from a configured one.
        const gate = pipeline.heldAt !== null ? "proposed" : "merge";
        const action = pipeline.heldAt ?? atMerge.heldAt ?? "no-merge";

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
                  pipeline.ok && atMerge.ok
                    ? `Merge ${branch} into ${base}? Every gate passed.`
                    : `Merge ${branch} into ${base} anyway? The ${pipeline.failedAt ?? atMerge.failedAt} gate refused.`,
                artifacts: [`${branch}@${headSha}`],
              }),
            },
          ]);
        }
        // Blocked rather than released, the same as a refusal — a question for
        // a person belongs in "Waiting on you", not back in the queue where
        // another run could claim it and throw the question away. It also stops
        // the claim's lease from quietly expiring while someone thinks.
        const question = `held at the ${gate} gate: ${branch} into ${base}`;
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
              data: parsePayload("WorkItemBlocked", { question, needsFrom: "human", runId }),
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
        // Blocked rather than released: a refusal is a question for a person,
        // and the board's "Waiting on you" column is where it goes.
        const question = `${merged.reason}: ${merged.detail.slice(0, 500)}`;
        const ended = yield* Effect.promise(async () => {
          const blocked = await store.read(workItemId);
          const resolvedEnd = resolveEndActions(blocked, recipe.gates.end, "blocked");
          await store.append(workItemId, blocked.length, [
            {
              type: "WorkItemBlocked",
              actor: "conductor",
              data: parsePayload("WorkItemBlocked", { question, needsFrom: "human", runId }),
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
      return { ok: true, workItemId, runId, mergeCommit: merged.mergeCommit } satisfies RunOnceResult;
    });

    return yield* claimed.pipe(
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
