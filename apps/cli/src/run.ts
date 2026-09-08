/**
 * `lingtai run --once <project> --issue <n>` — Phase 1's whole shape.
 *
 * One nominated issue, discovery through merge, with a person watching. It is
 * deliberately not "take the queue": `agent-loop.sh` is still working the same
 * repository on an hourly cycle, and the two must never both claim a ticket.
 * Nominating by number is the safety rule, not a limitation of the plumbing.
 */
import { currentRecipe, loadProject, runOnce, runQueue, tallyPass } from "@lingtai/conductor";
import { githubApp, hasGitHubApp } from "@lingtai/env";
import { createGitHubClient } from "@lingtai/github";
import { createClaudeCodeRuntime } from "@lingtai/agent";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentHost, Repo, PortsLive } from "@lingtai/conductor";
import { Data, Effect } from "effect";
import { Projector, ProjectorLive } from "./projector.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface RunOptions {
  project: string;
  /**
   * One nominated issue. Undefined takes the queue instead, which is what
   * "consecutive" in Phase 2's exit criterion means: the conductor picked the
   * next one up, not a person typing another number.
   */
  issue?: number;
  /** Stop after this many. `--max 2` is the exit criterion. */
  max?: number;
  /** False for `--no-merge`: stop after the gates and ask before writing. */
  merge?: boolean;
  /** Defaults to the compiled hook in `packages/hook/bin`. */
  hookBinary?: string;
  promptPath?: string;
}

/**
 * A refusal, in the error channel rather than as a `return 1` and a log line.
 *
 * [0023](../../../doc/decisions/0023-effect-at-the-boundary.md). There are five
 * of these and each used to be `log(…); return 1` — which works, and which the
 * type system cannot see. As a `Data.TaggedError` the compiler knows this
 * function can refuse and knows the ways, and `Effect.catchTag` below turns
 * each back into the same line and the same exit code, in one place.
 *
 * The gain is not the message. It is that a refusal raised **before** the
 * projector was ever read still closes it, because release is the scope's job
 * and not this function's.
 */
class Refused extends Data.TaggedError("Refused")<{ readonly detail: string }> {}

const refuse = (detail: string) => new Refused({ detail });

export async function run(options: RunOptions, log = console.log): Promise<number> {
  const program = Effect.gen(function* () {
    if (!hasGitHubApp()) {
      return yield* refuse("no GitHub App configured — see doc/decisions/0006-github-app.md and .env.example");
    }

    const project = yield* Effect.promise(() => loadProject(options.project));
    if (!project) {
      return yield* refuse(`no project named "${options.project}" — run lingtai add <owner>/<repo> first`);
    }
    if (!project.owner) {
      return yield* refuse(`${options.project} has no owner recorded — re-run lingtai add to record it`);
    }
    // Bound now: a property narrowing does not survive into the closure below.
    const owner = project.owner;

    const hookBinary = options.hookBinary ?? resolve(root, "packages/hook/bin/lingtai-hook");
    yield* Effect.tryPromise({
      try: () => readFile(hookBinary),
      // The hook is a compiled artefact and is not committed. It refuses nothing
      // now (ADR 0016 §6) but carries every event a run produces, so a run
      // without it is a run that records nothing — which must not start. There is
      // no flag to skip this any more: there is nothing left to skip.
      catch: () => refuse(`no lingtai-hook binary at ${hookBinary} — run: pnpm --filter @lingtai/hook build`),
    });

    const promptPath = options.promptPath ?? resolve(root, "prompts/ticket.md");
    const prompt = yield* Effect.tryPromise({
      try: () => readFile(promptPath, "utf8"),
      catch: () => refuse(`no prompt at ${promptPath}`),
    });

    const client = yield* Effect.promise(() =>
      createGitHubClient({ auth: githubApp(), owner, repo: options.project }),
    );

    /**
     * The work, with the world provided **around it and not around the
     * refusals above**.
     *
     * A `Layer` is built when it is provided, so providing the projector to the
     * whole program would acquire it before the first refusal could be raised —
     * and `lingtai run no-such-project` would open a Postgres connection to say
     * a project does not exist. It did, briefly, while this was being written.
     * `Scope` guarantees release, not that acquisition was wanted; where the
     * scope *starts* is still a decision, and this is it.
     */
    const work = Effect.gen(function* () {
      // Asked for, not threaded through — and the release is the scope's, which
      // is the whole of why `run()` no longer has to remember it on four paths.
      yield* Projector;
      const ports = { repo: yield* Repo, agent: yield* AgentHost };

      return yield* Effect.promise(async () => {
      const common = {
        project,
        client,
        runtime: createClaudeCodeRuntime(),
        // Both managed repositories are private. Without this every git command in
        // the run is an anonymous one, and the clone fails before anything else
        // gets a chance to. Passed as the client's token *function*, not a string:
        // an installation token lasts an hour and a run's wall limit is two.
        token: () => client.token(),
        // What the tags held, handed on. `runOnce` still takes ports as a
        // parameter — it is a function, not a host — and this is the one place
        // that turns "provided" back into "passed".
        ports,
        merge: options.merge,
        hookBinary,
        promptVersion: `ticket@${prompt.length}`,
        log,
      };

      // ---- the queue -----------------------------------------------------------
      if (options.issue === undefined) {
        // The project's *state*, not its name — the recipe is resolved from the
        // base recorded at `lingtai add`.
        const resolved = await currentRecipe(project, client).catch(() => null);
        if (!resolved) {
          log(`could not read ${options.project}'s recipe — run lingtai doctor`);
          return 1;
        }

        const outcome = await runQueue({
          ...common,
          prompt,
          // Asked rather than stored: a project that reorders its kinds, or adds
          // an exclusion, must not need a projection rebuild.
          recipe: resolved.recipe,
          ...(options.max === undefined ? {} : { max: options.max }),
      });

      // Read back, not counted up. An item this pass held and somebody approved
      // while the pass carried on has landed, and the log says so — see
      // `tallyPass`. Counting the merges this process performed printed
      // `0 landed` over a merge that had happened, and exited 1 on the count.
      const { landed, held, stopped } = await tallyPass(outcome.ran);
      log(`${outcome.ran.length} run(s): ${landed} landed, ${held} held, ${stopped} stopped (${outcome.stopped})`);
      // Exit 0 unless something actually went wrong. An empty queue is not a
      // failure, neither is a bounded run reaching its bound, and neither is an
      // item waiting on a person.
      return stopped > 0 ? 1 : 0;
    }

    // ---- one nominated issue -------------------------------------------------
    const result = await runOnce({
      ...common,
      issue: options.issue,
      // The raw template. `runOnce` fetches the ticket and fills it in — it is
      // the only place that has the title and the body.
      prompt,
  });

  if (result.ok === true) {
    log(`landed ${result.mergeCommit.slice(0, 7)} — ${result.workItemId}`);
    return 0;
  }
  if (result.ok === "held") {
    // Exit 0: holding is what was asked for, and a non-zero code here would
    // teach a person to ignore it.
    log(`held at ${result.headSha.slice(0, 7)} — ${result.workItemId} is waiting on you`);
    log(`nothing was merged. Re-run without --no-merge to merge it.`);
    return 0;
  }
  // Every stage that can refuse names itself, so "why did nothing happen" has
  // an answer at the shell as well as on the board.
  log(`stopped at ${result.stage}: ${result.detail}`);
  return 1;
      });
    });

    return yield* work.pipe(Effect.provide(ProjectorLive(log)), Effect.provide(PortsLive));
  });

  // The edge, once. Everything above is a description; this is where it runs,
  // and where a `Refused` becomes the line and the exit code it always was.
  return Effect.runPromise(
    program.pipe(
      Effect.catchTag("Refused", (r) =>
        Effect.sync(() => {
          log(r.detail);
          return 1;
        }),
      ),
    ),
  );
}
