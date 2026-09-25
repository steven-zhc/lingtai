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
import { type ProjectState, passTransition, projectStream, reduceProject } from "@lingtai/domain";
import { type EventStore, eventStore } from "@lingtai/event-store";
import { createGitHubClient } from "@lingtai/github";
import { githubApp, hasGitHubApp, repoRoot } from "@lingtai/env";
import { createClaudeCodeRuntime } from "@lingtai/agent";
import { kindsOf } from "@lingtai/recipe/settings";

/** Lingtai's own checkout — the hook binary and the prompt template. */
const root = repoRoot();

export interface ConductOptions {
  /** False holds every item at the merge instead of landing it. */
  merge?: boolean;
  hookBinary?: string;
  promptPath?: string;
  /** How many items one pass may take. One, so completion drives the loop. */
  max?: number;
  /**
   * The commit this process was loaded from, read once at its start and never
   * per pass — the checkout is exactly what moves under loaded modules. Carried
   * on a `ProjectRefused`, so the log can tell a broken recipe from a process
   * too old for a good one (#148).
   */
  codeSha?: string | null;
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

  return conductProjects({
    projects: await loadProjects(),
    codeSha: options.codeSha ?? null,
    outcome,
    log,
    work: async (project, where) => {
      const name = project.project!;
      const client = await createGitHubClient({
        auth: githubApp(),
        owner: project.owner!,
        repo: name,
      });

      // `max: 0` means "look at the project and take nothing". Returned here
      // rather than through `runQueue({ max: 0 })` because a nominated issue
      // would otherwise still jump the queue and run. Nothing was read, so it
      // says nothing about whether the project would be refused.
      if (options.max === 0) return "looked-away";
      // Asked here rather than inside `currentRecipe`, so a refusal can say
      // which branch it was reading (#148).
      where.ref = project.base ?? (await client.defaultBranch());
      const resolved = await currentRecipe(project, client, where.ref);
      // Looked at, now — not when the run below returns, which can be an hour
      // away, all of it with a refusal on record for a project being worked.
      await where.looked();

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
            kinds: kindsOf(resolved.recipe),
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
        else if (result.ok === "held") log(`held at ${result.step}`);
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
      return "looked";
    },
  });
}

/** How far a project's work got before it refused: the branch, once known. */
export interface Where {
  ref: string | null;
  /**
   * The project was looked at without refusing: records the recovery now, while
   * the rest of the work — a run, up to `runtime.limits.wall` — is still ahead.
   * Idempotent, since `passTransition` appends nothing once nothing is on record.
   */
  looked: () => Promise<void>;
}

export interface ProjectsOptions {
  projects: readonly ProjectState[];
  /**
   * One project's share of the pass. Throwing before `where.looked` is refusing
   * it; throwing after is a failure the outcome reports and the log does not
   * record as a refusal. `"looked-away"`
   * is returning before anything was read, which is neither a refusal nor a
   * recovery. Sets `where.ref` once it knows the branch, and calls `where.looked`
   * once it has read enough to know it does not refuse; `"looked"` calls it on
   * return if the work did not.
   */
  work: (project: ProjectState, where: Where) => Promise<"looked" | "looked-away">;
  codeSha: string | null;
  outcome: PassOutcome;
  log: (line: string) => void;
  store?: EventStore;
}

/**
 * Every registered project, each in isolation — and a refusal's start and end
 * on the project's stream.
 *
 * Split from `conductorPass` so the part that decides what reaches the log runs
 * without a GitHub App: that record is the claim of `#148`, and a claim about
 * the log is tested against the log.
 */
export async function conductProjects(options: ProjectsOptions): Promise<PassOutcome> {
  const { outcome, log, store = eventStore } = options;

  for (const project of options.projects) {
    const name = project.project;
    if (!name || !project.owner) continue;
    outcome.projects += 1;
    let looked = false;
    const where: Where = {
      ref: null,
      looked: () => {
        looked = true;
        return record(project, { refused: false, ref: where.ref, codeSha: options.codeSha }, { store, log });
      },
    };

    try {
      if ((await options.work(project, where)) === "looked") await where.looked();
    } catch (err) {
      // One project's problem is not the pass's. A misconfigured repository
      // must not stop the others from being worked.
      outcome.refused.push({ project: name, detail: (err as Error).message });
      log(`${name}: ${(err as Error).message}`);
      // **And on the log** (#148): this line was the whole record for hours
      // while a daemon too old for its recipe refused every sweep. Appended on
      // the transition only — `passTransition` compares with what the stream
      // already holds, so the next identical sweep appends nothing.
      //
      // **Only before the project was looked at.** A throw after `looked()` —
      // an issue listing GitHub refuses, a merge lane's 502 — comes from a
      // project that was read and worked, which is not what `ProjectRefused`
      // says. Recorded, it would follow this sweep's `ProjectRecovered` with a
      // refusal, and every later sweep would append the same pair again.
      if (looked) continue;
      await record(
        project,
        { refused: true, detail: (err as Error).message, ref: where.ref, codeSha: options.codeSha },
        { store, log },
      );
    }
  }

  return outcome;
}

/**
 * Append what `passTransition` decides, if anything. Never throws: a record that
 * could not be written must not become the refusal of every project after this
 * one, and the next pass re-reads the stream and decides again.
 */
async function record(
  project: ProjectState,
  seen: Parameters<typeof passTransition>[1],
  options: { store: EventStore; log: (line: string) => void },
): Promise<void> {
  const { store, log } = options;
  const name = project.project!;
  try {
    // Re-read rather than trusting the state the pass began with: a run can
    // last an hour, and what matters is what the stream holds now.
    const current = reduceProject(await store.read(projectStream(name)));
    const next = passTransition(current, seen);
    if (next) await store.append(projectStream(name), current.version, [next]);
  } catch (err) {
    log(`${name}: could not record the pass on the log — ${(err as Error).message}`);
  }
}
