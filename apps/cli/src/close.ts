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
 * It does not touch the GitHub issue. Closing the issue is a separate act by a
 * person or by the `end` point's actions; this says what *Lingtai* now believes,
 * which is the half that was missing — `gh issue close` appends nothing, and the
 * fold went on calling the item `backlog` for as long as anybody left it there.
 */
import { close, loadProject } from "@lingtai/conductor";
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
    if (!project) {
      log(`no project named "${options.project}" — run lingtai add <owner>/<repo> first`);
      return 1;
    }

    return withProjector(log, async () => {
      // The local account, as `requeue`, `ask` and the board record it (0007).
      const by = options.by ?? `human:${userInfo().username}`;
      const outcome = await close({ project: options.project, issue: options.issue, reason: options.reason, by });
      log(outcome.detail);
      return outcome.ok ? 0 : 1;
    });
  })();
}
