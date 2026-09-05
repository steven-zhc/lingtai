/**
 * `lingtai end replay` — run the `end` point for what landed without it.
 *
 * The repair half of the doctor check next to it. `end` fires on every terminal
 * outcome, but for a while it only fired on the path where `runOnce` merged the
 * branch itself, so everything that landed through an approval merged, said
 * `WorkItemLanded`, and stopped: the issue was never closed and nothing on
 * GitHub showed that Lingtai had touched it.
 *
 * The code no longer does that. This is for the items it already did it to.
 *
 * **A replay, not a rewrite.** Nothing in the log is edited — an
 * `EndActionsResolved` is appended now, saying what the point resolved to, and
 * `tellGitHubAbout` carries it out exactly as it would have carried out one
 * written at the time. That is the whole reason the plan is an event rather
 * than something derived on the fly: it can be supplied late and everything
 * downstream is unchanged.
 *
 * The recipe comes from `origin/<base>` as it is *today*, which is the one
 * honest option: the recipe that was in force at the merge is not recoverable
 * from the log, and reading the current one is the same rule every other read
 * of a recipe follows (0005).
 */
import {
  appendEndActions,
  currentRecipe,
  landedWithoutEndActions,
  loadProject,
} from "@lingtai/conductor";
import { tellGitHubAbout } from "@lingtai/conductor";
import { githubApp, hasGitHubApp } from "@lingtai/env";
import { createGitHubClient, type GitHubClient } from "@lingtai/github";
import { eventStore } from "@lingtai/store";
import { withProjector } from "./projector.ts";

export interface EndReplayOptions {
  /** Narrows to one project; every affected one otherwise. */
  project?: string;
  /** Narrows to one issue. Only meaningful with a project. */
  issue?: number;
}

export async function endReplay(
  options: EndReplayOptions = {},
  log = console.log,
): Promise<number> {
  const found = (await landedWithoutEndActions()).filter(
    (f) =>
      (options.project === undefined || f.project === options.project) &&
      (options.issue === undefined || f.issue === options.issue),
  );

  if (found.length === 0) {
    log("nothing to replay — every landed item with end actions has resolved them");
    return 0;
  }
  if (!hasGitHubApp()) {
    log("no GitHub App configured — see doc/decisions/0006-github-app.md and .env.example");
    return 1;
  }

  // Held for the appending, not applied after it. This command writes end
  // actions and the board reads a projection of them, so it follows the log
  // while it works — the same rule the daemon and `lingtai run` obey.
  return withProjector(log, async () => {
    // One client per project. An installation token is scoped to one repository,
    // and minting one per item would be a lookup per item.
    const clients = new Map<string, GitHubClient>();
    let replayed = 0;

    for (const item of found) {
      const project = await loadProject(item.project);
      if (!project?.owner) {
        log(`${item.workItemId}: no project named "${item.project}" is onboarded — skipped`);
        continue;
      }
      try {
        let client = clients.get(item.project);
        if (!client) {
          client = await createGitHubClient({
            auth: githubApp(),
            owner: project.owner,
            repo: item.project,
          });
          clients.set(item.project, client);
        }
        const resolved = await currentRecipe(project, client);
        const ended = await appendEndActions(eventStore, item.workItemId, resolved.recipe.gates.end, "landed");
        // Resolved and then carried out, in that order and in this process. The
        // outbox used to stand between them; there is nothing to wait for now.
        await tellGitHubAbout({ store: eventStore, github: client, workItemId: item.workItemId, appended: ended });
        replayed += 1;
        log(`${item.project}#${item.issue}: end resolved from the recipe at ${resolved.ref}`);
      } catch (err) {
        // Named and carried on. One unreadable recipe must not strand the other
        // items, and the log is intact either way.
        log(`${item.project}#${item.issue}: not replayed — ${(err as Error).message}`);
      }
    }

    log(`${replayed} replayed`);
    return 0;
  });
}
