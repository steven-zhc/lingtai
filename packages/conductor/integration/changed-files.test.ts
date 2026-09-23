/**
 * What a `watch:` action is shown, against real git — a fake answering
 * `--name-only` would only say back what the test believed git prints, and
 * what git prints for a rename is the thing that was wrong (#31).
 *
 * A temp repository and nothing else, so it belongs with the tests that need no
 * database.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { changedFilesArgs } from "../src/run-once.ts";

const exec = promisify(execFile);
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

let dir = "";
const git = async (...args: string[]) => (await exec("git", args, { cwd: dir, env })).stdout;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("the files a watch is shown", () => {
  it("names where a moved file came from, not only where it went", async () => {
    dir = await mkdtemp(join(tmpdir(), "lingtai-changed-"));
    await git("init", "-q", "-b", "main");
    // Rename detection on, and said so: a user's `diff.renames` must not decide it.
    await git("config", "diff.renames", "true");
    await mkdir(join(dir, "packages/actions/unit"), { recursive: true });
    await writeFile(
      join(dir, "packages/actions/unit/tamper-watch.test.ts"),
      Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"),
    );
    await git("add", ".");
    await git("commit", "-qm", "base");
    const base = (await git("rev-parse", "HEAD")).trim();

    await git("checkout", "-qb", "agent/31");
    await mkdir(join(dir, "doc"), { recursive: true });
    await git("mv", "packages/actions/unit/tamper-watch.test.ts", "doc/tamper-watch.md");
    await git("commit", "-qm", "move it");

    // The shape the finding reproduced, so the test is not passing on a git
    // that never detected the rename in the first place.
    expect((await git("diff", "--name-only", `${base}...HEAD`)).split("\n").filter(Boolean)).toEqual([
      "doc/tamper-watch.md",
    ]);

    const names = (await git(...changedFilesArgs(base))).split("\n").filter(Boolean);

    expect(names).toContain("packages/actions/unit/tamper-watch.test.ts");
    expect(names).toContain("doc/tamper-watch.md");
  });
});
