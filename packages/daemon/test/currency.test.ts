/**
 * A daemon started at commit A reports itself behind when `main` is at B.
 *
 * The assertion `#98` is about, against real git rather than a stub: a bare
 * repository stands in for `origin`, a clone stands in for the checkout a
 * daemon was started from, and the sha it froze at startup is compared against
 * `origin/main` after the remote has moved. No network and no GitHub.
 *
 * The fetch is done by the test, never by `codeCurrency` — the same rule
 * `lingtai doctor` keeps. `origin/main` means the ref as the last fetch left
 * it, and a diagnostic that reached for the network to improve on that would
 * be a diagnostic that hangs.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeCurrency, describeCurrency, readCodeVersion } from "../src/currency.ts";

const exec = promisify(execFile);
const git = (args: string[], cwd: string) =>
  exec("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });

let root: string;
/** The checkout a daemon would have been started from. */
let work: string;
/** The commit that checkout was at when the process started. */
let commitA: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "lingtai-currency-"));

  const origin = join(root, "origin.git");
  await exec("git", ["init", "-q", "--bare", "-b", "main", origin]);

  work = join(root, "work");
  await exec("git", ["init", "-q", "-b", "main", work]);
  await writeFile(join(work, "hook-socket.ts"), "the prompt's length\n");
  await git(["add", "-A"], work);
  await git(["commit", "-qm", "A"], work);
  await git(["remote", "add", "origin", origin], work);
  await git(["push", "-q", "-u", "origin", "main"], work);

  commitA = (await git(["rev-parse", "HEAD"], work)).stdout.trim();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("what code a process is running", () => {
  it("reads the commit HEAD points at, and whether the worktree is dirty", async () => {
    const clean = await readCodeVersion(work);
    expect(clean.sha).toBe(commitA);
    expect(clean.dirty).toBe(false);

    await writeFile(join(work, "scratch.txt"), "uncommitted\n");
    const dirty = await readCodeVersion(work);
    expect(dirty.sha).toBe(commitA);
    expect(dirty.dirty).toBe(true);

    await rm(join(work, "scratch.txt"));
  });

  it("says nothing rather than throwing when there is no checkout to read", async () => {
    const outside = await mkdtemp(join(tmpdir(), "lingtai-nocheckout-"));
    try {
      expect(await readCodeVersion(outside)).toEqual({ sha: null, dirty: false });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("a daemon started at A, with main at B", () => {
  /**
   * The shape of the incident: `#88` landed on `main` thirty-nine minutes
   * after the daemon started, and no beacon, board or doctor could say so.
   */
  it("reports itself behind, and names the commit it has not taken", async () => {
    // `main` moves after the daemon started. A second clone pushes it, so the
    // daemon's own checkout learns of it only through a fetch — which is
    // exactly the operator's situation.
    const other = join(root, "other");
    await exec("git", ["clone", "-q", join(root, "origin.git"), other]);
    await writeFile(join(other, "hook-socket.ts"), "the prompt itself\n");
    await git(["commit", "-qam", "fix(hook): the prompt is recorded, not its length"], other);
    await git(["push", "-q", "origin", "main"], other);
    const commitB = (await git(["rev-parse", "HEAD"], other)).stdout.trim();

    // The daemon's checkout is still at A — the process froze that at startup.
    await git(["fetch", "-q", "origin"], work);
    expect((await git(["rev-parse", "HEAD"], work)).stdout.trim()).toBe(commitA);

    const currency = await codeCurrency({ sha: commitA, dirty: false }, { cwd: work, base: "origin/main" });

    expect(currency.unknown).toBeNull();
    expect(currency.running).toBe(commitA);
    expect(currency.baseSha).toBe(commitB);
    expect(currency.behind).toHaveLength(1);
    expect(currency.behind[0]?.subject).toBe("fix(hook): the prompt is recorded, not its length");
    expect(commitB.startsWith(currency.behind[0]!.sha)).toBe(true);

    // The sentence doctor and the board both print, so the two cannot disagree.
    const said = describeCurrency(currency);
    expect(said).toContain("1 commit(s) behind origin/main");
    expect(said).toContain("fix(hook): the prompt is recorded, not its length");
  });

  it("is level once the daemon is restarted at B", async () => {
    const restarted = await codeCurrency(
      { sha: (await git(["rev-parse", "origin/main"], work)).stdout.trim(), dirty: false },
      { cwd: work, base: "origin/main" },
    );

    expect(restarted.behind).toEqual([]);
    expect(describeCurrency(restarted)).toContain("level with origin/main");
  });

  it("says it could not compare, rather than claiming level, when the base is unknown", async () => {
    const currency = await codeCurrency(
      { sha: commitA, dirty: false },
      { cwd: work, base: "origin/no-such-branch" },
    );

    expect(currency.unknown).not.toBeNull();
    expect(currency.behind).toEqual([]);
    expect(describeCurrency(currency)).toContain("could not compare");
  });

  it("reports a process that recorded no commit as unknown, not as current", async () => {
    const currency = await codeCurrency({ sha: null, dirty: false }, { cwd: work, base: "origin/main" });

    expect(currency.unknown).toBe("the process recorded no commit");
    expect(describeCurrency(currency)).toContain("an unrecorded commit");
  });
});
