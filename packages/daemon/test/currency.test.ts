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
import {
  codeCurrency,
  codeIdentity,
  describeCurrency,
  identityRefusals,
  readCodeVersion,
} from "../src/currency.ts";

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

/**
 * The other direction: not *is the running code behind* but **will anybody be
 * able to say what this process is running, tomorrow?**
 *
 * Its own repositories rather than the ones above, because the assertion is
 * about a commit that was never pushed — and the clone above exists to have
 * pushed everything it has.
 *
 * The shape is the evening of 2026-09-09: a daemon started from `582a0f8`, a
 * `git pull --rebase` twenty minutes later rewrote it, and nothing anywhere
 * could then say what that process was running.
 */
describe("whether a start could be accounted for afterwards", () => {
  let here: string;
  let local: string;

  beforeAll(async () => {
    here = await mkdtemp(join(tmpdir(), "lingtai-identity-"));

    const origin = join(here, "origin.git");
    await exec("git", ["init", "-q", "--bare", "-b", "main", origin]);

    local = join(here, "local");
    await exec("git", ["init", "-q", "-b", "main", local]);
    await writeFile(join(local, "a.ts"), "pushed\n");
    await git(["add", "-A"], local);
    await git(["commit", "-qm", "on the remote"], local);
    await git(["remote", "add", "origin", origin], local);
    await git(["push", "-q", "-u", "origin", "main"], local);
  });

  afterAll(async () => {
    await rm(here, { recursive: true, force: true });
  });

  it("lets a commit the remote has through, and says nothing about it", async () => {
    const id = await codeIdentity({ cwd: local, base: "origin/main" });

    expect(id.pushed).toBe(true);
    expect(id.dirty).toBe(false);
    expect(id.unknown).toBeNull();
    expect(identityRefusals(id)).toEqual([]);
  });

  it("refuses a commit that was never pushed, and names it", async () => {
    await writeFile(join(local, "a.ts"), "only on this disk\n");
    await git(["commit", "-qam", "local only"], local);
    const head = (await git(["rev-parse", "HEAD"], local)).stdout.trim();

    const id = await codeIdentity({ cwd: local, base: "origin/main" });
    expect(id.pushed).toBe(false);

    const [said] = identityRefusals(id);
    expect(said).toContain(head.slice(0, 7));
    expect(said).toContain("not reachable from origin/main");
    // The remedy, because the refusal is worth nothing without it.
    expect(said).toContain("Push it");
  });

  /**
   * Being *behind* is a different question and not a refusal: code the remote
   * already has is code anybody can fetch and read, which is the whole of what
   * this check asks. `codeCurrency` is what reports on being behind.
   */
  it("lets a commit that is behind the remote through", async () => {
    await git(["reset", "-q", "--hard", "origin/main"], local);
    await writeFile(join(local, "a.ts"), "the remote moved on\n");
    await git(["commit", "-qam", "ahead on the remote"], local);
    await git(["push", "-q", "origin", "main"], local);
    await git(["reset", "-q", "--hard", "HEAD~1"], local);

    const id = await codeIdentity({ cwd: local, base: "origin/main" });
    expect(id.pushed).toBe(true);
    expect(identityRefusals(id)).toEqual([]);
  });

  it("names a dirty worktree beside whatever else is wrong, in one refusal", async () => {
    await writeFile(join(local, "scratch.txt"), "uncommitted\n");
    try {
      const clean = await codeIdentity({ cwd: local, base: "origin/main" });
      expect(clean.dirty).toBe(true);
      expect(identityRefusals(clean)).toHaveLength(1);
      expect(identityRefusals(clean)[0]).toContain("uncommitted changes");

      // Both at once is one refusal with two lines, not two commands.
      await git(["add", "-A"], local);
      await git(["commit", "-qm", "unpushed too"], local);
      await writeFile(join(local, "scratch.txt"), "and dirty again\n");

      const both = await codeIdentity({ cwd: local, base: "origin/main" });
      expect(identityRefusals(both)).toHaveLength(2);
    } finally {
      await git(["reset", "-q", "--hard", "origin/main"], local);
      await rm(join(local, "scratch.txt"), { force: true });
    }
  });

  /**
   * "We cannot tell" and "it is fine" are not the same sentence. A base ref
   * nobody has fetched is the ordinary way to reach this, and nothing here
   * fetches on your behalf — so the refusal says so.
   */
  it("refuses when it could not be established, rather than assuming it was fine", async () => {
    const id = await codeIdentity({ cwd: local, base: "origin/no-such-branch" });

    expect(id.unknown).not.toBeNull();
    expect(id.pushed).toBeNull();
    expect(identityRefusals(id)[0]).toContain("git fetch");
  });
});
