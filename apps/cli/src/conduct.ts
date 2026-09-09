/**
 * One pass of the conductor, for the daemon to call.
 *
 * A pass is: ask GitHub what is runnable, write it into `task_view`, and take
 * **one** item. One rather than draining, because the completion event that
 * item produces is what triggers the next pass — so the loop advances by
 * itself, and an operator's pause (#45) can take effect between items instead
 * of only after a whole queue has been worked.
 *
 * This lives in the CLI and not in `@lingtai/daemon` on purpose. The daemon
 * hosts a loop and knows nothing about GitHub clients, runtimes or prompts;
 * assembling those is what this application already does for `lingtai run`, and
 * giving the daemon package those dependencies would make it the thing it is
 * supposed to be hosting.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  PortsLive,
  currentRecipe,
  foreignLabels,
  loadProjects,
  runOnce,
  runQueue,
  runnableNow,
  selectRunnable,
} from "@lingtai/conductor";
import { Effect } from "effect";
import { readControl } from "@lingtai/daemon";
import { createGitHubClient } from "@lingtai/github";
import { githubApp, hasGitHubApp, repoRoot } from "@lingtai/env";
import { createClaudeCodeRuntime } from "@lingtai/agent";

/** Lingtai's own checkout — the hook binary and the prompt template. */
const root = repoRoot();

export interface ConductOptions {
  /** False holds every item at the merge instead of landing it. */
  merge?: boolean;
  hookBinary?: string;
  promptPath?: string;
  /** How many items one pass may take. One, so completion drives the loop. */
  max?: number;
  log?: (line: string) => void;
}

export interface PassOutcome {
  /** Projects looked at. */
  projects: number;
  /** Items run across all of them. */
  ran: number;
  /** Projects that could not be looked at, and why. */
  refused: { project: string; detail: string }[];
}

/**
 * A pass, with the world provided around each item it takes.
 *
 * `runOnce` and `runQueue` ask for `Repo` and `AgentHost`
 * ([0026](../../../doc/decisions/0026-the-conversion-past-the-seam.md)), so a
 * pass is a host as much as `lingtai run` is: it provides `PortsLive` and calls
 * `runPromise` at its own edge. The projector is the daemon's, held for as long
 * as the daemon runs, which is why there is no scope of that kind here.
 */
export async function conductorPass(options: ConductOptions = {}): Promise<PassOutcome> {
  const log = options.log ?? (() => {});
  const outcome: PassOutcome = { projects: 0, ran: 0, refused: [] };

  if (!hasGitHubApp()) {
    outcome.refused.push({ project: "*", detail: "no GitHub App configured" });
    return outcome;
  }

  const hookBinary = options.hookBinary ?? resolve(root, "packages/hook/bin/lingtai-hook");
  try {
    await readFile(hookBinary);
  } catch {
    // A run that records nothing must not start. Refusing the pass rather than
    // the daemon: the projections stay current, which is what makes the reason
    // visible on the board.
    outcome.refused.push({ project: "*", detail: `no lingtai-hook binary at ${hookBinary}` });
    return outcome;
  }

  const promptPath = options.promptPath ?? resolve(root, "prompts/ticket.md");
  const prompt = await readFile(promptPath, "utf8");

  // Read once for the whole pass. A request that arrives mid-pass is answered
  // by the next one — which the append itself triggers.
  const control = await readControl();

  for (const project of await loadProjects()) {
    const name = project.project;
    if (!name || !project.owner) continue;
    outcome.projects += 1;

    try {
      const client = await createGitHubClient({
        auth: githubApp(),
        owner: project.owner,
        repo: name,
      });

      // `max: 0` means "look at the project and take nothing". Returned here
      // rather than through `runQueue({ max: 0 })` because a nominated issue
      // would otherwise still jump the queue and run.
      if (options.max === 0) continue;
      const resolved = await currentRecipe(project, client);

      const common = {
        project,
        client,
        runtime: createClaudeCodeRuntime(),
        // A function, not a snapshot: an installation token lasts an hour and a
        // run's wall limit is two.
        token: () => client.token(),
        hookBinary,
        prompt,
        promptVersion: `ticket@${prompt.length}`,
        ...(options.merge === undefined ? {} : { merge: options.merge }),
        log,
      };

      // A hand-picked issue jumps the queue.
      //
      // `lingtai now` used to append `RunRequested` and only *wake* the loop, which
      // then took whatever was at the top — so the command's name promised
      // something it did not do, and would have been wrong the moment the queue
      // held more than one item.
      //
      // A request needs no separate "consumed" event: it is satisfied when the
      // task stops being queued, which claiming it does. Filtering on that is
      // what keeps the control stream from growing a second state machine.
      // Asked, not read back: GitHub says what it is offering right now, so a
      // request for an issue that was closed or relabelled by hand since it was
      // made simply does not match.
      //
      // **`backoffMs: 0` — the command is called `now`** (0028). The backoff
      // stops *blind* retries, and a person naming an issue is not blind; every
      // other subtraction still applies, so a request for something already
      // claimed or landed still matches nothing. Until #95 this said
      // `source.backoff` like the pass below, and the two failures it produced
      // were both silent: the request matched nothing, so the daemon ran
      // whatever was at the top of the queue instead, and the request stayed
      // pending — because the only thing that consumes one is the item ceasing
      // to be queued.
      const offered = await runnableNow({ client, recipe: resolved.recipe });
      const queued = new Set(
        (
          await selectRunnable({
            project: name,
            offered: offered.runnable,
            kinds: resolved.recipe.source.kinds,
            backoffMs: 0,
          })
        ).map((t) => t.issue),
      );
      const asked = control.requested.find((r) => r.project === name && queued.has(r.issue));

      if (asked) {
        log(`${name}: taking #${asked.issue} — asked for by ${asked.by}`);
        const result = await Effect.runPromise(
          runOnce({ ...common, issue: Number(asked.issue) }).pipe(Effect.provide(PortsLive)),
        );
        outcome.ran += 1;
        if (result.ok === true) log(`landed ${result.mergeCommit.slice(0, 7)}`);
        else if (result.ok === "held") log(`held at ${result.gate}`);
        else log(`stopped at ${result.stage}: ${result.detail}`);
      } else {
        const ran = await Effect.runPromise(
          runQueue({
            ...common,
            recipe: resolved.recipe,
            max: options.max ?? 1,
          }).pipe(Effect.provide(PortsLive)),
        );
        outcome.ran += ran.ran.length;
      }
    } catch (err) {
      // One project's problem is not the pass's. A misconfigured repository
      // must not stop the others from being worked.
      outcome.refused.push({ project: name, detail: (err as Error).message });
      log(`${name}: ${(err as Error).message}`);
    }
  }

  return outcome;
}
