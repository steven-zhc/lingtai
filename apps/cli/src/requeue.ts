/**
 * `lingtai requeue <project> --issue <n> --note <why>` — hand a blocked item
 * back to the queue.
 *
 * The board has had this button since `#84`; the terminal has not. The two are
 * wanted at different moments, and the moment this one is wanted is the worst
 * possible one for the board: on 2026-09-10 five items — #123 through #127 —
 * blocked against a harness bug in the `agent` gate, so every block was about
 * the harness and none was about the diff. Unblocking them meant writing a
 * throwaway script that imported `@lingtai/conductor` and called the function
 * the button calls.
 *
 * So this is deliberately the same function and not a second path:
 * `requeue()` appends `WorkItemUnblocked` and nothing else, whichever side
 * asked. No GitHub client, because there is no GitHub call to make — the
 * event is the whole of the decision and `reconcile` converges the label an
 * earlier block left behind.
 */
import { loadProject, requeue } from "@lingtai/conductor";
import { withProjector } from "./projector.ts";
import { userInfo } from "node:os";

export interface RequeueCommandOptions {
  project: string;
  issue: number;
  /**
   * Why, on the record. Not optional, and an empty one is refused below rather
   * than filled in: a person overruling a block is not anonymous and is not
   * silent, and a note this file invented would be both.
   */
  note: string;
  by?: string;
}

export async function requeueCommand(
  options: RequeueCommandOptions,
  log = console.log,
): Promise<number> {
  // The one rule, and the reason it is here rather than in the argument
  // parsing: `--note` left off and `--note` with nothing after it are the same
  // silence, and a default invented at either layer would be a person
  // overruling a block anonymously. `requeue()` records the note verbatim, so
  // this is the last place that can refuse an empty one.
  if (!options.note.trim()) {
    log("lingtai requeue needs --note <why> — a block is overruled on the record, or not at all");
    return 2;
  }

  // Checked before the stream is read, so a mistyped project says so. Without
  // it the refusal would be `wi-lingati-130 is backlog, not blocked`, which is
  // true, unhelpful, and about the wrong mistake.
  const project = await loadProject(options.project);
  if (!project) {
    log(`no project named "${options.project}" — run lingtai add <owner>/<repo> first`);
    return 1;
  }

  // Moves a card off the lane the board exists for, so it follows the log while
  // it works — the same reason `lingtai approve` does. See `withProjector`.
  return withProjector(log, async () => {
    const outcome = await requeue({
      project: options.project,
      issue: options.issue,
      // The local account: a weak claim, but a true one, and the same one the
      // board records (0007). An unblocking that named nobody would be the
      // silent waiver this system exists to remove.
      by: options.by ?? `human:${userInfo().username}`,
      note: options.note,
    });

    log(outcome.detail);
    return outcome.ok ? 0 : 1;
  });
}
