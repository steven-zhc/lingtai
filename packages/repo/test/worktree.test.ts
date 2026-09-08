/**
 * Worktree provisioning, against real git.
 *
 * No network and no GitHub: the "remote" is a bare repository this test builds
 * in a temp directory, which exercises the same clone/fetch/worktree/submodule
 * path the real one takes. The submodule case is here because skipping it makes
 * every test that imports one fail, and on a board that reads as *the agent
 * broke the tests*.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionWorktree, removeWorktree } from "../src/index.ts";

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
let originPath: string;
let submodulePath: string;
let home: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "lingtai-worktree-"));
  home = join(root, "home");

  // A tiny repository to be used as a submodule.
  submodulePath = join(root, "shared.git");
  const subWork = join(root, "shared");
  await exec("git", ["init", "-q", "-b", "main", subWork]);
  await writeFile(join(subWork, "shared.txt"), "shared\n");
  await git(["add", "-A"], subWork);
  await git(["commit", "-qm", "shared"], subWork);
  await exec("git", ["clone", "-q", "--bare", subWork, submodulePath]);

  // The "remote": a repository with a develop branch and that submodule.
  const work = join(root, "work");
  originPath = join(root, "origin.git");
  await exec("git", ["init", "-q", "-b", "develop", work]);
  await writeFile(join(work, "README.md"), "hello\n");
  await git(["add", "-A"], work);
  await git(["commit", "-qm", "first"], work);
  await git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", submodulePath, "packages/shared"], work);
  await git(["commit", "-qm", "add submodule"], work);
  await exec("git", ["clone", "-q", "--bare", work, originPath]);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * A local-path submodule needs `file` explicitly allowed; git has refused it by
 * default since CVE-2022-39253. The real provisioning clones over https, where
 * the restriction does not apply — so this belongs in the test's environment and
 * not in the code under test.
 */
const gitEnv = { ...process.env, GIT_ALLOW_PROTOCOL: "file" };

const base = {
  project: "esctest",
  gitEnv,
  owner: "steven-zhc",
  repo: "esctest",
  base: "develop",
  plantAt: "apps/web/.env.local",
  env: { LOCAL_DATABASE_URL: "postgresql://u:p@dev.example.com:5432/app" },
};

describe("provisionWorktree", () => {
  it("cuts a branch from origin/<base> and plants the env file", async () => {
    const wt = await provisionWorktree({
      ...base,
      branch: "agent/1",
      runId: "run-1",
      submodules: false,
      remote: originPath,
      home,
    });

    expect((await stat(join(wt.path, "README.md"))).isFile()).toBe(true);
    expect(wt.baseSha).toMatch(/^[0-9a-f]{40}$/);

    // The env file is where the recipe said, not at the repo root — Next, Prisma
    // and vitest read it from the app directory.
    expect(wt.plantedAt).toBe(join(wt.path, "apps/web/.env.local"));
    const planted = await readFile(wt.plantedAt, "utf8");
    expect(planted).toContain('LOCAL_DATABASE_URL="postgresql://u:p@dev.example.com:5432/app"');

    // Readable only by the owner: it holds real values.
    expect((await stat(wt.plantedAt)).mode & 0o077).toBe(0);

    const branch = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wt.path });
    expect(branch.stdout.trim()).toBe("agent/1");

    await removeWorktree({ project: base.project, runId: "run-1", home });
  });

  /**
   * `git worktree add` does not populate submodules. A worktree without them
   * fails every test that imports one, which reads as the agent's fault.
   */
  it("initialises submodules when the recipe asks for them", async () => {
    const wt = await provisionWorktree({
      ...base,
      branch: "agent/2",
      runId: "run-2",
      submodules: true,
      remote: originPath,
      home,
    });

    const shared = join(wt.path, "packages/shared/shared.txt");
    expect((await stat(shared)).isFile()).toBe(true);
    expect(await readFile(shared, "utf8")).toBe("shared\n");

    await removeWorktree({ project: base.project, runId: "run-2", home });
  });

  it("leaves the submodule empty when the recipe does not ask", async () => {
    const wt = await provisionWorktree({
      ...base,
      branch: "agent/3",
      runId: "run-3",
      submodules: false,
      remote: originPath,
      home,
    });

    await expect(stat(join(wt.path, "packages/shared/shared.txt"))).rejects.toThrow();
    await removeWorktree({ project: base.project, runId: "run-3", home });
  });

  it("re-provisioning the same run replaces the worktree rather than failing", async () => {
    const first = await provisionWorktree({
      ...base,
      branch: "agent/4",
      runId: "run-4",
      submodules: false,
      remote: originPath,
      home,
    });
    await writeFile(join(first.path, "scratch.txt"), "left over\n");

    const second = await provisionWorktree({
      ...base,
      branch: "agent/4",
      runId: "run-4",
      submodules: false,
      remote: originPath,
      home,
    });

    expect(second.path).toBe(first.path);
    // A crash mid-run leaves a directory, not a state to reconcile by hand.
    await expect(stat(join(second.path, "scratch.txt"))).rejects.toThrow();
    await removeWorktree({ project: base.project, runId: "run-4", home });
  });
});
