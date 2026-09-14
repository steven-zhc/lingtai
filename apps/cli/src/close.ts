/**
 * `lingtai close <project> --issue <n> "<reason>"` — a ticket nobody is going
 * to do, ended on the log (#151).
 *
 * A wrapper over `close()` in `@lingtai/conductor` and nothing more, for the
 * reason `ask` gives: one decision, one function, whichever side asks.
 *
 * **It holds a projector**, for `withProjector`'s rule — this moves a card the
 * board is showing, out of every lane and into the archive.
 *
 * **It brings a client, so the `end` point can run** (0044). What the issue
 * itself ends up as is the recipe's call — a `close: true` action at `end` with
 * `when: closed` or `when: any` closes it — and Lingtai's own labels come off
 * either way. Without the client this would append a terminal and leave a
 * configured point unresolved, which is the silence the point exists to stop;
 * it is also the manual step that made `lingtai close` half a command, since
 * somebody still had to run `gh issue close` afterwards.
 *
 * No GitHub App configured is a refusal here rather than a quiet half-close,
 * for the same reason `lingtai approve` refuses.
 */
import { close, loadProject } from "@lingtai/conductor";
import { githubApp, hasGitHubApp } from "@lingtai/env";
import { createGitHubClient } from "@lingtai/github";
import { userInfo } from "node:os";
import { withProjector } from "./projector.ts";

export interface CloseCommandOptions {
  project: string;
  issue: number;
  /** Why. Refused when blank — this decision is the one nothing reverses. */
  reason: string;
  by?: string;
}

export function closeCommand(options: CloseCommandOptions, log = console.log): Promise<number> {
  return (async () => {
    if (!options.reason.trim()) {
      log(`lingtai close <project> --issue <n> "<reason>" — nothing lifts a close, so say why`);
      return 2;
    }

    const project = await loadProject(options.project);
    if (!project?.owner) {
      log(`no project named "${options.project}" — run lingtai add <owner>/<repo> first`);
      return 1;
    }
    if (!hasGitHubApp()) {
      log("no GitHub App configured — see doc/decisions/0006-github-app.md and .env.example");
      return 1;
    }

    const client = await createGitHubClient({
      auth: githubApp(),
      owner: project.owner,
      repo: options.project,
    });

    return withProjector(log, async () => {
      // The local account, as `requeue`, `ask` and the board record it (0007).
      const by = options.by ?? `human:${userInfo().username}`;
      const outcome = await close({
        project: options.project,
        issue: options.issue,
        reason: options.reason,
        by,
        state: project,
        client,
      });
      log(outcome.detail);
      return outcome.ok ? 0 : 1;
    });
  })();
}
