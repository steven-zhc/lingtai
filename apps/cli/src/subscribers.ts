/**
 * The recipes' `subscribers:`, made runnable for the daemon.
 *
 * Here rather than in the loop for the reason the gates' `deps.env` is a
 * callback: only this layer can read a recipe, and only it can read
 * [0021](../../../doc/decisions/0021-the-recipe-decides-the-environment.md)'s
 * layers off this machine. `work-loop.ts` takes a name, a `wants` and a
 * `consider` and knows nothing else about them.
 *
 * ## Every credential, and no more
 *
 * The environment handed to a subscriber's process is
 * `runnableEnv(extensionEnv(merged, declared))` — the six a process needs to be
 * a process, plus the names the recipe declared beside *that* subscriber
 * ([0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §1). Not
 * the daemon's environment, which is the whole point: `LINGTAI_DATABASE_URL` is
 * this system's own log, it is in the daemon's process, and it reaches no
 * extension — it cannot even be declared, because a name beginning `LINGTAI_`
 * is refused by the recipe (`#63`).
 *
 * The same call `runOnce` makes for a `run:` action, deliberately. Two ways of
 * resolving an extension's environment would be two things to keep in step, and
 * the first one to drift would be the one nobody was running.
 *
 * ## Read once, at startup
 *
 * A recipe is fetched when the daemon starts and held for its life, which is
 * the same currency the rest of a running daemon has: it holds the code it
 * started with, and `lingtai doctor`'s `daemon: currency` is what says how far
 * behind that is. So adding a subscriber to a recipe takes effect at the next
 * restart, exactly as changing the daemon's own source does — said in the log
 * line below rather than left to be discovered.
 */
import { tmpdir } from "node:os";
import { type EventSubscriber, subscribersFromRecipe } from "@lingtai/actions";
import { extensionEnv, resolveAgentEnv, runnableEnv } from "@lingtai/agent-env";
import type { ProjectFilter } from "@lingtai/conductor";

export interface ResolvedSubscribers {
  subscribers: EventSubscriber[];
  /** One line per project that declared any, and per project that could not. */
  lines: string[];
}

/**
 * Builds one subscriber per `subscribers:` entry across every project whose
 * recipe resolved.
 *
 * A project whose recipe would not parse is skipped in silence *here* — it has
 * already been reported, loudly, by `describeFilters`, and saying it twice
 * would make the second one noise. A project whose *environment* will not
 * resolve is reported here and only here, because nothing else asks for it at
 * startup: it means the subscriber will not run, and a notifier that is not
 * running must say so at the only moment anybody is reading.
 */
export async function resolveSubscribers(
  filters: readonly ProjectFilter[],
): Promise<ResolvedSubscribers> {
  const subscribers: EventSubscriber[] = [];
  const lines: string[] = [];

  for (const filter of filters) {
    if (!filter.ok || filter.recipe.subscribers.length === 0) continue;
    const declared = filter.recipe.subscribers;

    try {
      // `refusal` is not consulted, and that is deliberate: it is about the
      // names the *agent* requires, and a project that cannot run an agent can
      // still be one whose landings are worth a message. What a subscriber
      // itself is missing is `extensionEnv(...).missing`, which `lingtai
      // doctor` reports before a run and the extension says on the way out.
      const { merged } = await resolveAgentEnv({
        project: filter.project,
        required: filter.recipe.env.required,
        allow: filter.recipe.env.allow,
        deny: filter.recipe.env.deny,
      });

      subscribers.push(
        ...subscribersFromRecipe(filter.project, declared, {
          env: (names) => runnableEnv(extensionEnv(merged, names).values),
          // A subscriber judges no diff and has no worktree, so it runs
          // nowhere in particular. `tmpdir()` rather than the daemon's own
          // directory, which is a checkout of this repository and none of an
          // extension's business.
          cwd: tmpdir(),
        }),
      );
      lines.push(
        `${filter.project}: ${declared.map((s) => `${s.name} on ${s.on.length} event(s)`).join(", ")}` +
          " — from the recipe read at startup, so a change to it lands on restart",
      );
    } catch (err) {
      // A production-looking value is the only thing either call throws, and
      // it refuses rather than hands the value over — an extension is no more
      // trusted with one than an agent is. Said, and then this project's
      // subscribers are not built: running them with a half-resolved
      // environment is how a token silently stops arriving.
      lines.push(`${filter.project}: no subscriber will run — ${(err as Error).message}`);
    }
  }

  return { subscribers, lines };
}
