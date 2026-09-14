/**
 * `lingtai approve <project> --issue <n>` — merge what a held run actually produced.
 *
 * The counterpart to `lingtai run --once --no-merge`. Without it that flag is half a
 * feature: the only other way to finish a held run is to run it again without
 * the flag, which starts a new run with a new worktree and a new diff — so the
 * thing that merges is not the thing anyone looked at.
 *
 * There is no `--reject` (#150): it asked the same question again with a note
 * on it. Agreeing with a refusal is `lingtai requeue`, and overruling one is
 * this command with `--note`, which a live refusal requires.
 */
import { approve as approveRun, loadProject } from "@lingtai/conductor";
import { withProjector } from "./projector.ts";
import { githubApp, hasGitHubApp } from "@lingtai/env";
import { createGitHubClient } from "@lingtai/github";
import { userInfo } from "node:os";

export interface ApproveCommandOptions {
  project: string;
  issue: number;
  note?: string;
  by?: string;
}

export async function approveCommand(
  options: ApproveCommandOptions,
  log = console.log,
): Promise<number> {
  if (!hasGitHubApp()) {
    log("no GitHub App configured — see doc/decisions/0006-github-app.md and .env.example");
    return 1;
  }

  const project = await loadProject(options.project);
  if (!project?.owner) {
    log(`no project named "${options.project}" — run lingtai add <owner>/<repo> first`);
    return 1;
  }

  const client = await createGitHubClient({
    auth: githubApp(),
    owner: project.owner,
    repo: options.project,
  });

  const by = options.by ?? `human:${userInfo().username}`;

  // This is the command most likely to be run with the board open, and it moves
  // a card off the lane the board exists for. So it follows the log while it
  // works, like every other host that appends — see `withProjector`.
  return withProjector(log, async () => {
    const result = await approveRun({
      project: options.project,
      issue: options.issue,
      base: project.base ?? (await client.defaultBranch()),
      client,
      // An approval is never anonymous. The local account is a weak claim, but it
      // is a true one, and it is what a single-machine deployment has (0007).
      by,
      note: options.note,
      token: () => client.token(),
      log,
  });

  if (result.ok) {
    log(`landed ${result.mergeCommit.slice(0, 7)} — ${result.workItemId}`);
    return 0;
  }
  log(`did not merge (${result.reason}): ${result.detail}`);
  if (result.reason === "unexplained") {
    log(`lingtai approve ${options.project} --issue ${options.issue} --note <why>`);
  }
  return 1;
  });
}
