/**
 * Which subscribers an event is due, and what it costs to ask.
 *
 * The daemon follows the log and holds the boundary; this is the half that
 * knows what a recipe is. It lives in the CLI for the reason `conduct.ts` does:
 * `@lingtai/daemon` hosts a loop and has no GitHub client, and giving it one so
 * that it could read `.lingtai/config.yaml` would make it the thing it is
 * supposed to be hosting.
 *
 * ## Three costs, and each is bought once
 *
 * A subscriber is declared per project
 * ([0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §3), and
 * the daemon is handed every append for every project — so a naive dispatcher
 * would read a recipe over the network for each of the hundreds of events one
 * run appends. Three things stop that:
 *
 * **The union first.** Every declared type across every project is one set, and
 * an event whose type is not in it costs a hash lookup and nothing else. That
 * is the overwhelming majority: `RunTouchedFile`, `GateStarted`, every
 * heartbeat of a working agent.
 *
 * **One snapshot for every project, on a TTL.** Not per event and not per
 * project: the projects are read together and their recipes with them, so a
 * burst of events costs one refresh between them. A minute is short enough that
 * a merged `subscribers:` block takes effect without a restart — which is the
 * one thing 0010's *the source runs unbuilt* does **not** give a running daemon
 * for code (`#98`), and is worth having for configuration.
 *
 * **A run's ticket, remembered as it goes past.** `run-<uuid>` carries neither
 * a project nor an issue, so the map from run to work item is built out of the
 * `RunStarted` this dispatcher is handed anyway, and only a daemon that
 * restarted mid-run pays a read for it.
 *
 * ## An event that belongs to no repository has no subscribers
 *
 * A pause, a shutdown, a question on the control stream: there is no recipe to
 * declare anything about them, so nothing is dispatched and that is not a
 * failure. It is a real narrowing from the notifier this replaces, which
 * subscribed with `project: "*"` and therefore also fired on events it could
 * name no task for — a notification reading "IntegrationRefused" with no
 * reference and no link. The ones that mattered are kept, because
 * `IntegrationRefused` on `int-<project>-<base>` and `RunAwaitingInput` on
 * `run-<uuid>` both resolve to a project here.
 */
import {
  type Envelope,
  type ProjectState,
  streamProject,
  PROJECT_STREAM_PREFIX,
} from "@lingtai/domain";
import { runSubscriber, subscriberPayload } from "@lingtai/actions";
import { extensionEnv } from "@lingtai/agent-env";
import { currentRecipe, loadProjects } from "@lingtai/conductor";
import { type SubscriberDelivery } from "@lingtai/daemon";
import { type Subscriber } from "@lingtai/recipe";
import { type EventStore, eventStore } from "@lingtai/event-store";
import { createGitHubClient } from "@lingtai/github";
import { githubApp, optional, stateDir } from "@lingtai/env";

/** Where the board is, for the link an extension is handed rather than builds. */
export const DEFAULT_BOARD_URL = "http://localhost:3200";

/** How long a project's `subscribers:` block is believed. See the header. */
export const SNAPSHOT_TTL_MS = 60_000;

/** Run streams remembered at once, before the oldest is forgotten. */
const RUNS_REMEMBERED = 500;

export interface DispatchOptions {
  boardUrl?: string;
  /**
   * Where a subscriber's command runs.
   *
   * `~/.lingtai`, and never a worktree: a subscriber holds no verdict about a
   * commit and there is no checkout of the project on this machine that is
   * anybody's to run in. A command that needs a file of its own knows where it
   * put it; one that needs the repository is a gate action, not a subscriber.
   */
  cwd?: string;
  ttlMs?: number;
  store?: EventStore;
  /** Injected by tests, which have neither a log nor a GitHub App. */
  projects?: () => Promise<ProjectState[]>;
  subscribersOf?: (project: ProjectState) => Promise<readonly Subscriber[]>;
  run?: (spec: Subscriber, project: string, payload: unknown) => Promise<void>;
  log?: (line: string) => void;
}

interface Snapshot {
  at: number;
  /** Every type any project subscribes to. The cheap first question. */
  types: Set<string>;
  /** Registered project names, longest first — see `originOf`. */
  names: string[];
  byProject: Map<string, readonly Subscriber[]>;
}

/**
 * The subscribers a project declares, read from `origin/<base>` like every
 * other part of its recipe (0005).
 */
async function subscribersFromGitHub(project: ProjectState): Promise<readonly Subscriber[]> {
  const { owner, project: repo } = project;
  // Guarded rather than defaulted: a client built with an empty owner asks
  // GitHub about `/repos//name` and comes back with a 404, which reads as a
  // repository that has been deleted rather than as a project that was never
  // finished being registered.
  if (!owner || !repo) throw new Error("registered without an owner and a repository");
  const client = await createGitHubClient({ auth: githubApp(), owner, repo });
  const resolved = await currentRecipe(project, client);
  return resolved.recipe.subscribers;
}

export function createSubscriberDispatch(
  options: DispatchOptions = {},
): (event: Envelope) => Promise<readonly SubscriberDelivery[]> {
  const log = options.log ?? (() => {});
  const boardUrl = options.boardUrl ?? optional("LINGTAI_BOARD_URL") ?? DEFAULT_BOARD_URL;
  const cwd = options.cwd ?? stateDir();
  const ttlMs = options.ttlMs ?? SNAPSHOT_TTL_MS;
  const store = options.store ?? eventStore;
  const readProjects = options.projects ?? (() => loadProjects());
  const readSubscribers = options.subscribersOf ?? subscribersFromGitHub;

  let snapshot: Snapshot | null = null;
  /** In flight, so a burst of events buys one refresh rather than one each. */
  let refreshing: Promise<Snapshot> | null = null;
  /**
   * `run-<uuid>` → the work item it is a run of, learned from `RunStarted`.
   *
   * The work item and not the project, because it answers both questions: a
   * project is one parse away from it, and it is also what gives a question
   * from a running agent a ticket number and a board link. Nothing else on a
   * run stream carries either.
   */
  const runWorkItem = new Map<string, string>();

  async function refresh(): Promise<Snapshot> {
    const projects = await readProjects();
    const byProject = new Map<string, readonly Subscriber[]>();
    const types = new Set<string>();
    for (const project of projects) {
      const name = project.project;
      if (!name) continue;
      let declared: readonly Subscriber[];
      try {
        declared = await readSubscribers(project);
      } catch (err) {
        // One project's unreadable recipe is not the others'. Said once per
        // refresh rather than once per event, which is the difference between a
        // line a minute and a line per append while GitHub is down.
        //
        // **What it last said, not nothing.** A minute of GitHub being
        // unreachable must not be a minute in which a blocked ticket quietly
        // notifies nobody — that is the failure a notifier must not have, bought
        // by an outage instead of a bug. The subscribers only stop when a recipe
        // that *was* read says so.
        declared = snapshot?.byProject.get(name) ?? [];
        log(
          `${name}: subscribers not read — ${(err as Error).message}` +
            (declared.length > 0 ? `; keeping the ${declared.length} last read` : ""),
        );
      }
      byProject.set(name, declared);
      for (const s of declared) for (const t of s.on) types.add(t);
    }
    return {
      at: Date.now(),
      types,
      // Longest first: `acme` and `acme-web` are both projects, and
      // `int-acme-web-main` belongs to the second one.
      names: [...byProject.keys()].sort((a, b) => b.length - a.length),
      byProject,
    };
  }

  async function current(): Promise<Snapshot> {
    if (snapshot && Date.now() - snapshot.at < ttlMs) return snapshot;
    refreshing ??= refresh()
      .then((next) => {
        snapshot = next;
        return next;
      })
      .finally(() => {
        refreshing = null;
      });
    // A refresh that throws must not leave every later event answering from
    // nothing: the stale snapshot is better than none, and a first failure
    // simply has none to fall back to.
    return refreshing.catch((err: unknown) => {
      log(`subscribers not refreshed: ${String(err instanceof Error ? err.message : err)}`);
      return snapshot ?? { at: 0, types: new Set<string>(), names: [], byProject: new Map() };
    });
  }

  /**
   * What an event is about: a repository, and a ticket when there is one.
   *
   * `wi-` answers itself. `prj-` and `int-` carry the name but not where it
   * ends — a project name may contain `-` and so may a base branch — so they are
   * matched against the names that are actually registered. `run-` carries
   * nothing at all and is looked up.
   */
  async function originOf(
    event: Envelope,
    snap: Snapshot,
  ): Promise<{ project: string; workItem: string | null } | null> {
    const id = event.streamId;
    const own = streamProject(id);
    if (own !== null) return { project: own, workItem: id };

    if (id.startsWith("run-")) {
      const workItem = runWorkItem.get(id) ?? (await readWorkItemOf(id));
      const project = workItem === null ? null : streamProject(workItem);
      return project === null || workItem === null ? null : { project, workItem };
    }

    const body = id.startsWith(PROJECT_STREAM_PREFIX)
      ? id.slice(PROJECT_STREAM_PREFIX.length)
      : id.startsWith("int-")
        ? id.slice(4)
        : null;
    if (body === null) return null;
    const project = snap.names.find((n) => body === n || body.startsWith(`${n}-`));
    return project === undefined ? null : { project, workItem: null };
  }

  /**
   * The run's work item, for a run that began before this daemon did.
   *
   * One read of one stream, and remembered afterwards. It happens only when a
   * subscribed type arrives on a run stream nothing has seen start — a daemon
   * restarted mid-run — because everything else has already been learned in
   * passing.
   */
  async function readWorkItemOf(runId: string): Promise<string | null> {
    const events = await store.read(runId).catch(() => []);
    const started = events.find((e) => e.type === "RunStarted");
    const workItem = (started?.data as { workItemId?: string } | undefined)?.workItemId ?? null;
    if (workItem !== null) remember(runId, workItem);
    return workItem;
  }

  function remember(runId: string, workItem: string): void {
    runWorkItem.set(runId, workItem);
    if (runWorkItem.size > RUNS_REMEMBERED) {
      const oldest = runWorkItem.keys().next().value;
      if (oldest !== undefined) runWorkItem.delete(oldest);
    }
  }

  return async function subscribersFor(event: Envelope) {
    // Learned in passing, before anything else: a `RunStarted` is the only
    // place a run stream says which work item it is a run of, and the events
    // that need to know come after it.
    if (event.type === "RunStarted") {
      const workItemId = (event.data as { workItemId?: string }).workItemId;
      if (workItemId) remember(event.streamId, workItemId);
    }

    const snap = await current();
    if (!snap.types.has(event.type)) return [];

    const origin = await originOf(event, snap);
    if (origin === null) return [];
    const declared = (snap.byProject.get(origin.project) ?? []).filter((s) =>
      s.on.includes(event.type),
    );
    if (declared.length === 0) return [];

    const payload = subscriberPayload(event, {
      boardUrl,
      project: origin.project,
      workItem: origin.workItem,
    });
    return declared.map((spec) => ({
      name: spec.name,
      deliver: async () => {
        if (options.run) return options.run(spec, origin.project, payload);
        const env = await extensionEnv({ project: origin.project, names: spec.env });
        if (env.missing.length > 0) {
          // Refused before it is started, for the reason `env.required` refuses
          // a project before anything is claimed (0021): a Telegram extension
          // started without its token is an HTTP 401 several minutes later,
          // about a variable nobody thought was missing. The throw is a
          // `PluginFailed` by the time anyone reads it.
          throw new Error(
            `declares ${env.missing.join(", ")}, which neither env file supplies — ` +
              `lingtai env set ${origin.project} ${env.missing[0]}`,
          );
        }
        await runSubscriber(spec, { cwd, env: env.values, payload });
      },
    }));
  };
}
