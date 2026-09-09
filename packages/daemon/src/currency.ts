/**
 * Which commit the running process was loaded from, and how far that is behind
 * the repository.
 *
 * **Up and current are different facts.** The beacon next door
 * (`control.ts`) answers the first: a row somebody is still writing to. It has
 * nothing to say about the second, and for thirty-nine minutes on 2026-09-08
 * that gap cost 52 prompts. `#88` landed on `main` at 18:01:32 and the daemon
 * had loaded `hook-socket.ts` at 17:22:53; Node caches a module at import, so
 * the fix could not run and nothing anywhere said the process was holding code
 * older than the repository. `doctor` reported `up, last beat 2s ago` — true,
 * and no answer at all to the question that mattered. The same shape as `#77`,
 * where the board said *current* and could not say *paused*.
 *
 * **[0010](../../../doc/decisions/0010-source-runs-unbuilt.md) is what makes it
 * easy to miss.** *The source runs unbuilt* removes the build step; it does not
 * remove the restart. A long-lived process is still a deployment of whatever
 * `HEAD` pointed at when it started, and a merge into `main` reaches the CLI,
 * the gates and the board — every one of which is a fresh process or hot
 * reloads — while leaving the daemon exactly where it was.
 *
 * This only ever *reports*. Whether a daemon should restart itself when `main`
 * moves is deliberately open: 0030 shut a pass down safely, and a self-restart
 * is a decision with real arguments on both sides that wants an ADR before an
 * implementation.
 *
 * **It never fetches.** Same rule as `lingtai doctor`: `origin/main` here means
 * the ref as your last fetch left it, and saying so is better than a diagnostic
 * that reaches for the network.
 */
import { git } from "@lingtai/repo";

/** What a process recorded about the code it was loaded from. */
export interface CodeVersion {
  /** The commit `HEAD` pointed at. Null when it is not a checkout at all. */
  sha: string | null;
  /** Whether that checkout had uncommitted changes when the process started. */
  dirty: boolean;
}

export interface Currency {
  /** The commit the process is running. Null when it recorded none. */
  running: string | null;
  dirty: boolean;
  /** The ref it was compared against — `origin/main` unless told otherwise. */
  base: string;
  /** Where that ref points, as the last fetch left it. */
  baseSha: string | null;
  /** Commits on the base the running code does not have, newest first. */
  behind: { sha: string; subject: string }[];
  /** Why the comparison could not be made, when it could not. */
  unknown: string | null;
}

export interface CurrencyOptions {
  /** Which checkout to read. Defaults to the one this module was loaded from. */
  cwd?: string;
  /**
   * Which ref to compare against. Defaults to the checked-out branch's
   * upstream, then to `origin/main` — so this says nothing about a branch name
   * that only happens to be right for one repository.
   */
  base?: string;
}

/** Where the branch has no upstream, or the head is detached. */
const FALLBACK_BASE = "origin/main";

/**
 * The checkout this module was loaded from.
 *
 * Preferred over `process.cwd()`: the daemon may have been started from
 * anywhere, and launchd starts it from `/`. The one directory that is certainly
 * the code *running* is the one this file was read out of.
 */
export function codeRoot(): string {
  // `import.meta.dirname` is Node's, and the board's copy of this goes through
  // Turbopack, which need not define it. Every host Lingtai has is started
  // inside the checkout, so the working directory is the honest fallback.
  const dir: string | undefined = import.meta.dirname;
  return dir ?? process.cwd();
}

/**
 * Read once, by the process, at startup — never per beat.
 *
 * Per beat would answer a different question: it would report the checkout as
 * it is now, which is precisely the thing that has moved on underneath the
 * loaded modules. The whole point is the value the process froze.
 */
export async function readCodeVersion(cwd: string = codeRoot()): Promise<CodeVersion> {
  try {
    const sha = await git(["rev-parse", "HEAD"], { cwd });
    const dirty = (await git(["status", "--porcelain"], { cwd })) !== "";
    return { sha, dirty };
  } catch {
    // Not a checkout — an installed copy, or a tarball. Nothing to compare
    // against is a state to report, not an error to throw at a caller who only
    // wanted to draw a chip.
    return { sha: null, dirty: false };
  }
}

async function baseRef(cwd: string): Promise<string> {
  try {
    return await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd });
  } catch {
    return FALLBACK_BASE;
  }
}

/** What the running code is missing. `behind` empty and `unknown` null is current. */
export async function codeCurrency(
  running: CodeVersion,
  options: CurrencyOptions = {},
): Promise<Currency> {
  const cwd = options.cwd ?? codeRoot();
  const base = options.base ?? (await baseRef(cwd));
  const blank: Currency = {
    running: running.sha,
    dirty: running.dirty,
    base,
    baseSha: null,
    behind: [],
    unknown: null,
  };
  if (!running.sha) return { ...blank, unknown: "the process recorded no commit" };

  try {
    const baseSha = await git(["rev-parse", base], { cwd });
    // `A..B` is commits reachable from the base and not from the running sha,
    // which stays the right question when the two have diverged rather than
    // one being an ancestor of the other.
    const log = await git(["log", "--format=%h\t%s", `${running.sha}..${base}`], { cwd });
    const behind = log
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const tab = line.indexOf("\t");
        return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
      });
    return { ...blank, baseSha, behind };
  } catch (err) {
    // A sha the checkout no longer holds, or a base ref that was never
    // fetched. Both are answers; neither is a reason to fail a diagnostic.
    return { ...blank, unknown: (err as Error).message };
  }
}

/**
 * One sentence, used by `lingtai doctor` and by the board's chip.
 *
 * Shared rather than written twice, for the reason the queue filters are: two
 * reports of one fact that can disagree are worse than one that is terse.
 */
export function describeCurrency(c: Currency): string {
  const at = c.running ? c.running.slice(0, 7) : "an unrecorded commit";
  const dirty = c.dirty ? ", worktree dirty when it started" : "";
  if (c.unknown) return `running ${at}${dirty} — could not compare against ${c.base}: ${c.unknown}`;
  if (c.behind.length === 0) return `running ${at}${dirty} — level with ${c.base}`;

  const named = c.behind.slice(0, 5).map((b) => `${b.sha} ${b.subject}`);
  const rest = c.behind.length > named.length ? `, and ${c.behind.length - named.length} more` : "";
  return (
    `running ${at}${dirty} — ${c.behind.length} commit(s) behind ${c.base}, ` +
    `which has not taken effect in this process: ${named.join("; ")}${rest}`
  );
}
