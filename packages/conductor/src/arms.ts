/**
 * **Which of a ticket's arms are on `origin`**, asked of GitHub rather than
 * assumed (#315, [0072](../../../doc/decisions-archive/0072-an-earlier-attempt-is-a-locator-the-next-one-is-handed.md) §4).
 *
 * An arm's name is derivable from an attempt's ordinal (`armBranch`), and being
 * derivable does not make it exist: an attempt that died before it committed
 * pushed nothing. A brief that named a ref that does not resolve would send the
 * agent to spend turns on a failing `git show`, which is worse than naming
 * nothing — so the brief names only what this found.
 *
 * **GitHub and not the mirror**, because of when the brief is built. It is
 * settled before the claim (`prompt.ts`), and the mirror is fetched after it by
 * `provisionWorktree`; the previous attempt pushed its arm from its own worktree
 * straight to `origin`, so at brief time the mirror holds every arm *except* the
 * one this exists to offer. By the time the agent runs, the fetch has made it a
 * local ref.
 *
 * Its own file, importing nothing but `branches.ts`, because the board asks this
 * too — and `branches.ts` says what a stray import into its Next program costs.
 *
 * **Known limit, not handled.** An arm's name is unique within one log only.
 * After a reset (experiments 007 and 010) or a store switch (0055 §3), attempt
 * *k* can find an `agent/<n>-attempt-<k>` a previous log's attempt pushed, and
 * offer it. `matchingRefs` returns names and no heads, so nothing here can tell
 * the two apart; it needs a reset *and* arms left standing, and `refs:` at `end`
 * now sweeps a landed ticket's arms.
 */
import { armPrefix } from "./branches.ts";

/** The one call this needs of `GitHubClient`, so a test can fake it. */
export interface ArmChannel {
  matchingRefs(prefix: string): Promise<readonly string[]>;
}

/**
 * What `attemptBrief` is told about a ticket's arms.
 *
 * `branch` is `agent/<n>`; `onOrigin` holds the arm names (`agent/<n>-attempt-k`)
 * that `origin` has.
 */
export interface ArmsOnOrigin {
  branch: string;
  onOrigin: ReadonlySet<string>;
}

/**
 * The arms of `branch` that `origin` holds, or **null when it could not be
 * asked** — never an empty set in its place. `matchingRefs` answers a 200 and
 * `[]` for *no arms*, so a throw is never an absence, and null is the caller's
 * cue to say the column is missing and why.
 */
export async function armsOnOrigin(
  github: ArmChannel,
  branch: string,
): Promise<ArmsOnOrigin | null> {
  const prefix = armPrefix(branch);
  try {
    const found = await github.matchingRefs(`heads/${prefix}`);
    const onOrigin = new Set(
      found
        .map((ref) => ref.replace(/^heads\//, ""))
        .filter((name) => name.startsWith(prefix)),
    );
    return { branch, onOrigin };
  } catch {
    return null;
  }
}
