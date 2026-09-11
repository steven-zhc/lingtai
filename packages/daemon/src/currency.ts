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
 * **Two directions, and only one of them acts.** `codeCurrency` looks backwards
 * at a process that is already running and only ever *reports* — a warn on
 * `lingtai doctor`, a chip on the board, and nothing restarted.
 * `codeIdentity` below looks forward, at the commit a process is *about* to
 * freeze, and `lingtai restart` refuses on its answer
 * ([0038](../../../doc/decisions/0038-the-restart-is-a-command.md)). The
 * asymmetry is deliberate: a commit already loaded cannot be unloaded by a
 * diagnostic, whereas the moment before a start is the one moment the choice is
 * still open.
 *
 * Whether a daemon should restart *itself* when `main` moves is still open. 0038
 * made the restart a command somebody types; a reflex is a different decision
 * with real arguments on both sides, and it wants its own ADR.
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

// ------------------------------------------------------------- identity ----

/**
 * Whether the commit a process is about to freeze can be named afterwards.
 *
 * The forward-looking half of this module, and the one `lingtai restart` acts
 * on. `codeCurrency` above asks *is the running code behind*; this asks the
 * question that has to be answered before a process exists at all: **will
 * anybody be able to say what it is running, tomorrow?**
 *
 * On 2026-09-09 the answer was no. A daemon started from `582a0f8`, a local
 * commit that had not been pushed; a `git pull --rebase` twenty minutes later
 * rewrote it to `2926f2d`, and `lingtai doctor` then reported `running 582a0f8
 * — 5 commit(s) behind origin/main` against a commit that is not reachable from
 * `origin/main` at all. The process held that code for the rest of its life and
 * nothing could reconstruct what that code was.
 *
 * That is 0010 biting from a direction nobody had written down. *The source
 * runs unbuilt* is read as "a merge takes effect immediately"; what it also
 * means is that a process keeps whatever was on disk **at import**, including
 * code that was never pushed and has since been rewritten out of existence.
 */
export interface Identity {
  /** The commit `HEAD` points at, or null where there is no checkout. */
  sha: string | null;
  dirty: boolean;
  /** The ref it was compared against — the upstream, then `origin/main`. */
  base: string;
  /**
   * `sha` is reachable from `base`. Null when it could not be decided.
   *
   * Reachability and not equality: a checkout a few commits *behind* the base
   * is running code anybody can fetch and read, which is all this asks. Being
   * behind is `codeCurrency`'s question and is not a reason to refuse a start.
   */
  pushed: boolean | null;
  /** Why it could not be decided, when it could not. */
  unknown: string | null;
}

/**
 * Read from the checkout this module was loaded from, exactly as the beacon is.
 *
 * **It never fetches**, for the reason the rest of this file does not: reaching
 * for the network turns a refusal into something that can hang. `origin/main`
 * means the ref as your last fetch left it, and a start refused because the
 * fetch is old is a refusal a `git fetch` answers.
 */
export async function codeIdentity(options: CurrencyOptions = {}): Promise<Identity> {
  const cwd = options.cwd ?? codeRoot();
  const base = options.base ?? (await baseRef(cwd));
  const version = await readCodeVersion(cwd);
  const blank: Identity = { ...version, base, pushed: null, unknown: null };
  if (!version.sha) return { ...blank, unknown: "there is no checkout here to read a commit from" };

  try {
    // `base..sha` is what the head has and the base does not, so empty is
    // "reachable from the base" — the same shape `codeCurrency` uses for the
    // opposite direction, and one that stays right when the two have diverged.
    const ahead = await git(["rev-list", "--count", `${base}..${version.sha}`], { cwd });
    return { ...blank, pushed: ahead.trim() === "0" };
  } catch (err) {
    // A base ref that was never fetched, most often. An answer, not a throw —
    // the caller decides what an unknown is worth, and `lingtai restart` treats
    // it as a refusal because "we cannot tell" and "it is fine" are not the
    // same sentence.
    return { ...blank, unknown: (err as Error).message };
  }
}

/**
 * Why a process started from here could not be accounted for later. Empty is a go.
 *
 * A list rather than a first failure, because both facts are worth one reading:
 * a HEAD that was never pushed and a worktree with uncommitted changes are the
 * same defect twice, and being told about one of them at a time is how the
 * second gets discovered by a restart that was supposed to be the last one.
 *
 * Shared rather than written at the call site, for the reason
 * `describeCurrency` is: two reports of one fact that can disagree are worse
 * than one that is terse.
 */
export function identityRefusals(id: Identity): string[] {
  const at = id.sha ? id.sha.slice(0, 7) : "an unrecorded commit";
  const out: string[] = [];

  if (id.unknown !== null) {
    out.push(
      `the commit a daemon would start from could not be established against ${id.base} — ${id.unknown}. ` +
        `Nothing fetches on your behalf here, so a stale ref is answered by git fetch`,
    );
  } else if (id.pushed === false) {
    out.push(
      `${at} is not reachable from ${id.base} — it has not been pushed. A process holds the code it ` +
        `started with for hours, and a commit that only exists on this disk cannot be reasoned about ` +
        `afterwards: a rebase rewrites it and there is then nothing anywhere that says what ran. ` +
        `Push it, or start from ${id.base}`,
    );
  }

  if (id.dirty) {
    out.push(
      `the worktree has uncommitted changes — a daemon started from it runs code that no commit names, ` +
        `and the beacon would record ${at} for something that is not ${at}`,
    );
  }

  return out;
}
