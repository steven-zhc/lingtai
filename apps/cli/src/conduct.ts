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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { currentRecipe, foreignLabels, loadProjects, readRunnable, refreshQueue, runOnce, runQueue } from "@lingtai/conductor";
import { readControl } from "@lingtai/daemon";
import { createGitHubClient } from "@lingtai/github";
import { githubApp, hasGitHubApp } from "@lingtai/env";
import { createClaudeCodeRuntime } from "@lingtai/runtime";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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

      // Ask GitHub first. Without this the queue is whatever the last pass saw,
      // and a task closed by hand would still be taken.
      await refreshQueue({ project: name, client, recipe: resolved.recipe });

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
      const queued = new Set(
        (await readRunnable({ project: name, kinds: resolved.recipe.source.kinds })).map((t) => t.issue),
      );
      const asked = control.requested.find((r) => r.project === name && queued.has(r.issue));

      if (asked) {
        log(`${name}: taking #${asked.issue} — asked for by ${asked.by}`);
        const result = await runOnce({ ...common, issue: Number(asked.issue) });
        outcome.ran += 1;
        if (result.ok === true) log(`landed ${result.mergeCommit.slice(0, 7)}`);
        else if (result.ok === "held") log(`held at ${result.gate}`);
        else log(`stopped at ${result.stage}: ${result.detail}`);
      } else {
        const ran = await runQueue({
          ...common,
          kinds: resolved.recipe.source.kinds,
          max: options.max ?? 1,
        });
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
