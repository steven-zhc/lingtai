/**
 * Reading code out of the mirror, without a worktree.
 *
 * The mirror is bare — there is no working tree in it — so the only way to see
 * a file is `git show <ref>:<path>`, and that is a command **Lingtai** runs.
 * That distinction is the whole of
 * [0033](../../../doc/decisions/0033-the-third-kind-of-agent.md) §1: an agent
 * that only reads needs no worktree, no hook and no gates, and giving it a
 * shell so it could read for itself would not extend that shape, it would make
 * it the run agent under a different name.
 *
 * Nothing here writes, fetches or checks anything out. The mirror is Lingtai's
 * own copy and the conductor is what keeps it current; a reader that fetched
 * would be changing the thing it was asked to describe.
 *
 * **Absence is an answer, never an error.** A branch that was never pushed, a
 * path that does not exist at that ref, a project with no mirror yet — each of
 * them is a fact the caller has to state out loud, and a throw would make them
 * all read as "something went wrong". `worktree.ts` resets an attempt's branch
 * with `-B` on every run, so an attempt that committed nothing never had one;
 * that case is `#89`'s second attempt and reading `main` silently instead is
 * what killed the repair.
 */
import { stateDir } from "@lingtai/env";
import { join } from "node:path";
import { git } from "./git.ts";

/** `<home>/repos/<project>.git`. The bare clone the conductor cuts worktrees from. */
export function mirrorPathFor(project: string, home = stateDir()): string {
  return join(home, "repos", `${project}.git`);
}

export interface MirrorOptions {
  project: string;
  home?: string;
}

/** The commit a ref points at, or null when the mirror has no such ref. */
export async function refSha(options: MirrorOptions & { ref: string }): Promise<string | null> {
  return git(["rev-parse", "--verify", `${options.ref}^{commit}`], {
    cwd: mirrorPathFor(options.project, options.home),
  }).catch(() => null);
}

/**
 * One file at one ref, or null.
 *
 * Bounded, because a caller is putting this in a prompt and a minified bundle
 * or a lockfile would spend the whole context on one file. Truncation is said
 * in the returned text rather than left for the reader to notice.
 */
export async function readAt(
  options: MirrorOptions & { ref: string; path: string; limitBytes?: number },
): Promise<string | null> {
  const limit = options.limitBytes ?? 64_000;
  const text = await git(["show", `${options.ref}:${options.path}`], {
    cwd: mirrorPathFor(options.project, options.home),
  }).catch(() => null);
  if (text === null) return null;
  return text.length > limit
    ? `${text.slice(0, limit)}\n\n[truncated at ${limit} bytes; the file is ${text.length}]`
    : text;
}

/**
 * Every path at a ref, so a reader can name one.
 *
 * A file list rather than a search: this is the index a reader picks from, and
 * a repository large enough for that to be unreasonable is one where the list
 * is cut and said to be cut. Lingtai's own tree is about 200 files.
 */
export async function listAt(
  options: MirrorOptions & { ref: string; limit?: number },
): Promise<{ paths: string[]; truncated: boolean }> {
  const limit = options.limit ?? 1_500;
  const out = await git(["ls-tree", "-r", "--name-only", options.ref], {
    cwd: mirrorPathFor(options.project, options.home),
  }).catch(() => null);
  if (out === null) return { paths: [], truncated: false };
  const paths = out.split("\n").filter((p) => p !== "");
  return { paths: paths.slice(0, limit), truncated: paths.length > limit };
}
