import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  artifactName,
  compareVersions,
  installCommand,
  installPaths,
  platformName,
  pointShim,
  releaseCheck,
  runningFrom,
  unpackRelease,
  type Drained,
  type World,
} from "../src/install.ts";

/**
 * `lingtai upgrade`, `rollback` and `uninstall` (#184), against a release
 * server on localhost and tarballs whose `lingtai` is a shell script that says
 * its version — the layout is what is under test, not the bundle, which
 * `apps/release/test/build.test.ts` installs for real.
 */
const work = mkdtempSync(join(tmpdir(), "lingtai-install-"));
const platform = platformName() as string;
let server: Server;
let base = "";
/** What `/releases/latest` names, and whether the artifact is served corrupted. */
let latest = "1.0.1";
let corrupt = false;

function tarball(version: string): Buffer {
  const stage = join(work, "stage", version);
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "lingtai"), `#!/bin/sh\necho "lingtai ${version}"\n`);
  chmodSync(join(stage, "lingtai"), 0o755);
  writeFileSync(join(stage, "package.json"), JSON.stringify({ name: "lingtai", version }));
  const out = join(work, "stage", `${version}.tar.gz`);
  const tar = spawnSync("tar", ["-czf", out, "-C", stage, "lingtai", "package.json"]);
  expect(tar.status).toBe(0);
  return readFileSync(out);
}

beforeAll(async () => {
  const artifacts = new Map<string, Buffer>();
  for (const v of ["1.0.0", "1.0.1"]) artifacts.set(v, tarball(v));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/releases/latest") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          tag_name: `v${latest}`,
          assets: [
            { name: artifactName(latest, platform), browser_download_url: `${base}/download/${latest}/artifact` },
            { name: "SHA256SUMS", browser_download_url: `${base}/download/${latest}/sums` },
          ],
        }),
      );
      return;
    }
    const m = url.match(/^\/download\/([^/]+)\/(artifact|sums)$/);
    const bytes = m ? artifacts.get(m[1]!) : undefined;
    if (!m || !bytes) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (m[2] === "sums") {
      res.end(`${createHash("sha256").update(bytes).digest("hex")}  ${artifactName(m[1]!, platform)}\n`);
    } else {
      res.end(corrupt ? Buffer.concat([bytes, Buffer.from("x")]) : bytes);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  server.close();
  rmSync(work, { recursive: true, force: true });
});

let home = "";
let lines: string[] = [];
let calls: string[] = [];

function world(overrides: Partial<World> = {}): World {
  const env = { HOME: home, LINGTAI_RELEASES_API: `${base}/releases` };
  return {
    env,
    self: join(installPaths(env).versions, "1.0.0", "lingtai"),
    fetch,
    log: (line) => lines.push(line),
    ask: async () => true,
    running: () => [],
    conducting: async () => null,
    drain: async (): Promise<Drained> => {
      const shim = installPaths(env).shim;
      calls.push(`drain while the shim runs ${readlinkSync(shim)}`);
      return { ok: true, after: async () => void calls.push("after") };
    },
    app: async () => null,
    logConfigured: () => false,
    ...overrides,
  };
}

/** 1.0.0 installed the way `install.sh` leaves it. */
async function installOld(): Promise<void> {
  const w = world();
  const paths = installPaths(w.env);
  const was = latest;
  latest = "1.0.0";
  const release = { version: "1.0.0", assets: [
    { name: artifactName("1.0.0", platform), url: `${base}/download/1.0.0/artifact` },
    { name: "SHA256SUMS", url: `${base}/download/1.0.0/sums` },
  ] };
  expect(await unpackRelease(w, paths, release, platform)).toBe("unpacked");
  latest = was;
  pointShim(paths, "1.0.0");
}

function shimSays(): string {
  const shim = installPaths({ HOME: home }).shim;
  return spawnSync(shim, ["version"], { encoding: "utf8" }).stdout.trim();
}

beforeEach(() => {
  home = mkdtempSync(join(work, "home-"));
  lines = [];
  calls = [];
  latest = "1.0.1";
  corrupt = false;
});

describe("the platform", () => {
  it("names the four that are built and refuses anything else by name", () => {
    expect(platformName("darwin", "arm64")).toBe("darwin-arm64");
    expect(platformName("Linux", "x86_64")).toBe("linux-x64");
    expect(platformName("linux", "aarch64")).toBe("linux-arm64");
    expect(platformName("win32", "x64")).toEqual({ refused: expect.stringContaining("no Lingtai is built for win32 x64") });
    expect(platformName("linux", "ppc64")).toEqual({ refused: expect.stringContaining("ppc64") });
  });

  it("orders versions as semver does", () => {
    expect(["1.0.10", "1.0.0-rc.1", "1.0.2", "1.0.0"].sort(compareVersions)).toEqual(["1.0.0-rc.1", "1.0.0", "1.0.2", "1.0.10"]);
    expect(["1.0.0", "1.0.0-rc.10", "1.0.0-rc", "1.0.0-rc.2", "1.0.0-beta.1", "1.0.0-rc.a"].sort(compareVersions)).toEqual([
      "1.0.0-beta.1",
      "1.0.0-rc",
      "1.0.0-rc.2",
      "1.0.0-rc.10",
      "1.0.0-rc.a",
      "1.0.0",
    ]);
  });
});

describe("lingtai upgrade", () => {
  it("unpacks beside the old version, drains while the shim still points at it, then moves the shim", async () => {
    await installOld();
    expect(await installCommand(["upgrade"], world())).toBe(0);

    const paths = installPaths({ HOME: home });
    expect(existsSync(join(paths.versions, "1.0.0", "lingtai"))).toBe(true);
    expect(readlinkSync(paths.shim)).toBe(join(paths.versions, "1.0.1", "lingtai"));
    expect(calls).toEqual([`drain while the shim runs ${join(paths.versions, "1.0.0", "lingtai")}`, "after"]);
    expect(shimSays()).toBe("lingtai 1.0.1");
  });

  it("refuses an artifact that does not match its checksum, and unpacks and moves nothing", async () => {
    await installOld();
    corrupt = true;
    expect(await installCommand(["upgrade"], world())).toBe(1);

    const paths = installPaths({ HOME: home });
    expect(lines.join("\n")).toContain("does not match its checksum");
    expect(existsSync(join(paths.versions, "1.0.1"))).toBe(false);
    expect(readdirSync(paths.versions).filter((name) => name.includes("partial"))).toEqual([]);
    expect(calls).toEqual([]);
    expect(shimSays()).toBe("lingtai 1.0.0");
  });

  it("leaves the shim where it is when the drain refuses, and a second upgrade uses what was unpacked", async () => {
    await installOld();
    expect(await installCommand(["upgrade"], world({ drain: async () => ({ ok: false, code: 130 }) }))).toBe(130);
    expect(shimSays()).toBe("lingtai 1.0.0");

    lines = [];
    expect(await installCommand(["upgrade"], world())).toBe(0);
    expect(lines.join("\n")).toContain("already unpacked");
    expect(shimSays()).toBe("lingtai 1.0.1");
  });

  it("says it is current, and drains nothing, when the newest release is the one installed", async () => {
    await installOld();
    latest = "1.0.0";
    expect(await installCommand(["upgrade"], world())).toBe(0);
    expect(lines.join("\n")).toContain("1.0.0 is current");
    expect(calls).toEqual([]);
  });

  it("refuses from a checkout, and asks GitHub nothing", async () => {
    let asked = false;
    const w = world({
      self: join(work, "checkout", "apps", "cli", "src", "entry.ts"),
      fetch: async () => {
        asked = true;
        throw new Error("no request was expected");
      },
    });
    expect(await installCommand(["upgrade"], w)).toBe(1);
    expect(asked).toBe(false);
    expect(lines.join("\n")).toContain("a checkout upgrades with git pull");
  });
});

describe("lingtai rollback", () => {
  it("points the shim back at the older directory, which still runs", async () => {
    await installOld();
    expect(await installCommand(["upgrade"], world())).toBe(0);
    expect(shimSays()).toBe("lingtai 1.0.1");

    expect(await installCommand(["rollback"], world())).toBe(0);
    expect(shimSays()).toBe("lingtai 1.0.0");
    expect(existsSync(join(installPaths({ HOME: home }).versions, "1.0.1", "lingtai"))).toBe(true);

    lines = [];
    expect(await installCommand(["rollback"], world())).toBe(1);
    expect(lines.join("\n")).toContain("nothing older than 1.0.0");
  });

  it("refuses to move a lingtai on PATH that is not a link into versions/", async () => {
    const shim = installPaths({ HOME: home }).shim;
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(shim, "#!/bin/sh\n");
    expect(await installCommand(["rollback"], world())).toBe(1);
    expect(lines.join("\n")).toContain("not Lingtai's to replace");
    expect(readFileSync(shim, "utf8")).toBe("#!/bin/sh\n");
  });
});

describe("lingtai rollback, among prereleases", () => {
  it("takes rc.2 as older than rc.10", async () => {
    const paths = installPaths({ HOME: home });
    for (const v of ["1.0.0-rc.2", "1.0.0-rc.10"]) {
      mkdirSync(join(paths.versions, v), { recursive: true });
      writeFileSync(join(paths.versions, v, "lingtai"), `#!/bin/sh\necho "lingtai ${v}"\n`);
      chmodSync(join(paths.versions, v, "lingtai"), 0o755);
    }
    pointShim(paths, "1.0.0-rc.10");
    expect(await installCommand(["rollback"], world())).toBe(0);
    expect(shimSays()).toBe("lingtai 1.0.0-rc.2");
  });
});

describe("lingtai uninstall", () => {
  it("refuses while a daemon from a checkout holds the conductor lock, and removes nothing", async () => {
    await installOld();
    const worktree = join(home, ".lingtai", "worktrees", "lingtai", "run-1");
    mkdirSync(worktree, { recursive: true });
    const w = world({ conducting: async () => "steven@host pid 777" });
    expect(await installCommand(["uninstall", "--yes"], w)).toBe(1);
    expect(lines.join("\n")).toContain("steven@host pid 777 holds the conductor lock");
    expect(existsSync(worktree)).toBe(true);
  });

  it("refuses when the log cannot say whether anything conducts", async () => {
    await installOld();
    const w = world({ conducting: async () => { throw new Error("connection refused"); } });
    expect(await installCommand(["uninstall", "--yes"], w)).toBe(1);
    expect(lines.join("\n")).toContain("could not ask the log whether anything conducts");
    expect(existsSync(join(home, ".lingtai"))).toBe(true);
  });

  it("finds a process by the directory it works in, where its command line names nothing", async () => {
    const worktree = join(home, ".lingtai", "worktrees", "lingtai", "run-1");
    mkdirSync(worktree, { recursive: true });
    const child = spawn("sleep", ["30"], { cwd: worktree, stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(runningFrom([join(home, ".lingtai") + "/"]).map((p) => p.pid)).toContain(child.pid);
    } finally {
      child.kill();
    }
  });

  it("says a key read from the environment is still there", async () => {
    await installOld();
    const w = world({
      app: async () => ({ slug: "lingtai-steven", owner: "steven", organisation: false, installations: 1, repositories: 1, key: { variable: "LINGTAI_GITHUB_APP_PRIVATE_KEY", files: [] } }),
    });
    expect(await installCommand(["uninstall", "--yes"], w)).toBe(0);
    const said = lines.join("\n");
    expect(said).toContain("Its private key is in LINGTAI_GITHUB_APP_PRIVATE_KEY in your environment, which nothing here removed");
    expect(said).not.toContain("cannot be recovered");
  });

  it("says a key set in an env file under ~/.lingtai went with it", async () => {
    await installOld();
    const file = join(home, ".lingtai", "versions", ".env.local");
    writeFileSync(file, "LINGTAI_GITHUB_APP_PRIVATE_KEY=x\n");
    const w = world({
      app: async () => ({ slug: "lingtai-steven", owner: "steven", organisation: false, installations: 1, repositories: 1, key: { variable: "LINGTAI_GITHUB_APP_PRIVATE_KEY", files: [file] } }),
    });
    expect(await installCommand(["uninstall", "--yes"], w)).toBe(0);
    expect(lines.join("\n")).toContain("which is gone");
  });

  it("refuses while a process runs from what it would remove", async () => {
    await installOld();
    const w = world({ running: () => [{ pid: 4242, command: "node /x/.local/bin/lingtai start" }] });
    expect(await installCommand(["uninstall", "--yes"], w)).toBe(1);
    expect(lines.join("\n")).toContain("pid 4242");
    expect(existsSync(join(home, ".lingtai"))).toBe(true);
  });

  it("asks once, and removes nothing on a no", async () => {
    await installOld();
    const asked: string[] = [];
    expect(await installCommand(["uninstall"], world({ ask: async (q) => (asked.push(q), false) }))).toBe(1);
    expect(asked).toHaveLength(1);
    expect(existsSync(join(home, ".lingtai", "versions", "1.0.0"))).toBe(true);
  });

  it("removes ~/.lingtai and the shim, then names the App it could not remove and where to remove it", async () => {
    await installOld();
    let appAsked = false;
    const w = world({
      app: async () => {
        // Asked while the key is still there to sign with.
        appAsked = existsSync(join(home, ".lingtai"));
        return { slug: "lingtai-steven", owner: "steven", organisation: false, installations: 1, repositories: 2, key: { path: join(home, ".lingtai", "lingtai", "app.pem") } };
      },
      logConfigured: () => true,
    });
    expect(await installCommand(["uninstall"], w)).toBe(0);

    expect(appAsked).toBe(true);
    expect(existsSync(join(home, ".lingtai"))).toBe(false);
    expect(existsSync(installPaths({ HOME: home }).shim)).toBe(false);
    const said = lines.join("\n");
    expect(said).toContain("The GitHub App lingtai-steven still exists and is still installed on 2 repositories");
    expect(said).toContain("Its private key is gone and cannot be recovered");
    expect(said).toContain("https://github.com/settings/apps/lingtai-steven");
    expect(said).toContain("the database LINGTAI_DATABASE_URL names is untouched");
  });
});

describe("lingtai doctor's release row", () => {
  it("notes a newer release for an installed copy, and asks nothing from a checkout", async () => {
    await installOld();
    expect(await releaseCheck(world())).toMatchObject({ status: "warn", detail: expect.stringContaining("1.0.1 is out") });
    latest = "1.0.0";
    expect(await releaseCheck(world())).toMatchObject({ status: "ok" });

    const checkout = world({ self: join(work, "checkout", "entry.ts"), fetch: async () => { throw new Error("asked"); } });
    expect(await releaseCheck(checkout)).toMatchObject({ status: "skip" });
  });
});
