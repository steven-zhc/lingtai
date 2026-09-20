/**
 * An installed copy: `lingtai version`, `upgrade`, `rollback` and `uninstall`
 * (#184, [0051](../../../doc/decisions/0051-a-version-is-a-directory.md)).
 *
 *   ~/.lingtai/versions/<v>/
 *     lingtai              the binary (#185, 0050)
 *     board/               standalone, the same on every platform
 *   ~/.local/bin/lingtai   a symlink, and the only thing that ever moves
 *
 * **A version's directory is written once and never rewritten.** An upgrade
 * unpacks beside what is there and moves the shim; a rollback moves it back.
 * Nothing here removes a version a process may be running from — a daemon holds
 * the code it started with for hours, and it is told to stop through the log,
 * not through the binary, which is why the shim can move under it.
 *
 * **None of this needs the log.** A machine that has only just installed has no
 * database to name — and since #179 naming none is itself a choice, so the
 * hazard turned over: `@lingtai/event-store` no longer throws at import, it
 * opens whichever store was chosen the moment anything reads or appends. Either
 * way these four must not be the thing that reaches it, so `entry.ts` answers
 * them before it is imported, and what does need the log (the drain, the App)
 * is reached through `World` and imported only when asked.
 *
 * **The one outbound request** a tool that sends nothing anywhere makes is the
 * question *which release is newest*, and it is asked by `lingtai upgrade` and
 * `lingtai doctor` — never by any other command.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { paint } from "@lingtai/env/colour";
import type { StoreChoice } from "@lingtai/env";
import workspace from "../../../package.json" with { type: "json" };
import { platformName, versionLine } from "./version.ts";

export const INSTALL_COMMANDS = ["version", "upgrade", "rollback", "uninstall"] as const;

/** Where releases are asked about. `LINGTAI_RELEASES_API` points it at a mirror, or a test. */
export const RELEASES_API = "https://api.github.com/repos/steven-zhc/lingtai/releases";

/** The four binaries `.github/workflows/release.yml` builds. Nothing else is built, so nothing else installs. */
export const PLATFORMS = ["macos-arm64", "macos-x64", "linux-x64", "linux-arm64"] as const;

/** One per platform, holding `lingtai`; the workflow's `pack` step names them. */
export function artifactName(platform: string): string {
  return `lingtai-${platform}.tar.gz`;
}

/** `board/`, published once because it is the same on every platform. */
export const BOARD = "board.tar.gz";

export const CHECKSUMS = "SHA256SUMS";

// -------------------------------------------------------------- the world --

export interface Paths {
  /** `~/.lingtai`, or `LINGTAI_HOME`. */
  home: string;
  versions: string;
  /** `~/.local/bin/lingtai`, or `LINGTAI_BIN_DIR/lingtai`. */
  shim: string;
}

export function installPaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const user = env["HOME"] ?? homedir();
  const home = env["LINGTAI_HOME"] ?? join(user, ".lingtai");
  return {
    home,
    versions: join(home, "versions"),
    shim: join(env["LINGTAI_BIN_DIR"] ?? join(user, ".local", "bin"), "lingtai"),
  };
}

/** What the drain decided: go on, with what to do once the shim has moved — or stop, with this exit code. */
export type Drained = { ok: true; after: () => Promise<void> } | { ok: false; code: number };

export interface AppFacts {
  slug: string;
  owner: string;
  organisation: boolean;
  installations: number;
  repositories: number;
  /**
   * Where the private key was read from: a file, or a variable together with the
   * env files that set it — none where only the environment carries it.
   */
  key: { path: string } | { variable: string; files: string[] };
}

/** Everything these commands reach outside themselves. Replaceable, so a test needs no database, network or GitHub. */
export interface World {
  env: NodeJS.ProcessEnv;
  /** The file this process was started from — `versions/<v>/lingtai` when installed. */
  self: string;
  fetch: typeof fetch;
  log: (line: string) => void;
  /** One yes-or-no question. False when there is nobody to ask. */
  ask: (question: string) => Promise<boolean>;
  /** Processes whose command line names one of `paths`, or whose working directory is under one, other than this one. */
  running: (paths: readonly string[]) => { pid: number; command: string }[];
  /**
   * Who holds the conductor lock, where a log is configured — null where nothing
   * does. A daemon started from a checkout names nothing under `~/.lingtai`, and
   * still runs its agents there.
   */
  conducting: () => Promise<string | null>;
  /** Drain whatever conducts before the shim moves. `despiteDoctor` waives a red doctor and nothing else. */
  drain: (reason: string, despiteDoctor: boolean) => Promise<Drained>;
  /** The GitHub App this machine is configured with, asked before anything is removed. */
  app: () => Promise<AppFacts | null | { unread: string }>;
  /**
   * **Which log this machine has, and where it is** — null only where
   * `storeChoice` refuses to say, which is a half-named Postgres (0055 §2).
   *
   * Not a boolean, and not `databaseUrl()`, since #179: absence names the
   * SQLite log in `~/.lingtai` rather than naming nothing, so a machine that
   * has one would have been told it had none — while `uninstall` listed the
   * file itself among what it could not ask about, and then offered to remove
   * it without ever saying what it was.
   */
  store: () => StoreChoice | null;
}

// ------------------------------------------------------------- versions --

/**
 * `macos-arm64` and the rest — `lingtai version`'s own name for a platform —
 * or the sentence that refuses this machine by name.
 */
export function installPlatform(os: string = process.platform, arch: string = process.arch): string | { refused: string } {
  const o = os === "darwin" || os === "Darwin" ? "darwin" : os === "linux" || os === "Linux" ? "linux" : null;
  const a =
    arch === "arm64" || arch === "aarch64" ? "arm64" : arch === "x64" || arch === "x86_64" || arch === "amd64" ? "x64" : null;
  if (o === null || a === null) {
    return {
      refused:
        `no Lingtai is built for ${os} ${arch} — only ${PLATFORMS.join(", ")}. ` +
        `Nothing was installed rather than something that will not run`,
    };
  }
  return platformName(o, a);
}

/**
 * Semver's order, without the build metadata nobody here writes: `1.0.0-rc.2` <
 * `1.0.0-rc.10` < `1.0.0` < `1.0.10`. A prerelease compares field by field, a
 * numeric field as a number and below any that is not, and fewer fields first.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): [string, string | undefined] => {
    const dash = v.indexOf("-");
    return dash === -1 ? [v, undefined] : [v.slice(0, dash), v.slice(dash + 1)];
  };
  const [coreA, preA] = split(a);
  const [coreB, preB] = split(b);
  const na = coreA.split(".").map(Number);
  const nb = coreB.split(".").map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d !== 0) return d;
  }
  if (preA === undefined || preB === undefined) return preA === preB ? 0 : preA === undefined ? 1 : -1;
  const fa = preA.split(".");
  const fb = preB.split(".");
  for (let i = 0; i < Math.min(fa.length, fb.length); i++) {
    const x = fa[i]!;
    const y = fb[i]!;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return fa.length - fb.length;
}

/** The version directory this process runs from, or null for a checkout. */
export function installedVersion(self: string, paths: Paths): string | null {
  if (!existsSync(paths.versions)) return null;
  const dir = dirname(realpath(self));
  return dirname(dir) === realpath(paths.versions) ? basename(dir) : null;
}

/** Every complete version under `versions/`, oldest first. A `.partial` directory is not one. */
export function installedVersions(paths: Paths): string[] {
  if (!existsSync(paths.versions)) return [];
  return readdirSync(paths.versions)
    .filter((name) => !name.startsWith(".") && existsSync(join(paths.versions, name, "lingtai")))
    .sort(compareVersions);
}

/**
 * The version the shim points at: null where there is no shim, and a refusal
 * where there is one that is not Lingtai's to move.
 */
export function shimVersion(paths: Paths): string | null | { refused: string } {
  let stat;
  try {
    stat = lstatSync(paths.shim);
  } catch {
    return null;
  }
  if (!stat.isSymbolicLink()) {
    return { refused: `${paths.shim} is a file and not a link into ${paths.versions} — not Lingtai's to replace. Move it and run this again` };
  }
  const target = resolve(dirname(paths.shim), readlinkSync(paths.shim));
  const dir = dirname(target);
  if (dirname(dir) !== paths.versions && (!existsSync(paths.versions) || dirname(dir) !== realpath(paths.versions))) {
    return { refused: `${paths.shim} points at ${target}, which is not under ${paths.versions} — not Lingtai's to replace. Move it and run this again` };
  }
  return basename(dir);
}

/**
 * Point the shim at a version, atomically: a new link beside it, renamed over
 * it. A command started between the two sees one version or the other, never
 * no `lingtai`.
 */
export function pointShim(paths: Paths, version: string): void {
  mkdirSync(dirname(paths.shim), { recursive: true });
  const next = `${paths.shim}.${process.pid}.new`;
  rmSync(next, { force: true });
  symlinkSync(join(paths.versions, version, "lingtai"), next);
  renameSync(next, paths.shim);
}

/**
 * `<dir>/lingtai version`, and whether it said the version it is filed under —
 * `lingtai 1.0.1 macos-arm64 (binary, node v26.5.0)`, whose second word is it.
 */
export function versionRuns(dir: string, version: string): { ok: true } | { ok: false; said: string } {
  const ran = spawnSync(join(dir, "lingtai"), ["version"], { encoding: "utf8", timeout: 30_000 });
  const said = `${ran.stdout ?? ""}${ran.stderr ?? ""}${ran.error ? ran.error.message : ""}`.trim();
  const [word, named] = (ran.stdout ?? "").trim().split(/\s+/);
  return ran.status === 0 && word === "lingtai" && named === version ? { ok: true } : { ok: false, said };
}

// --------------------------------------------------------------- releases --

export interface Release {
  version: string;
  assets: { name: string; url: string }[];
}

/** The newest release, from the GitHub Releases API — the one outbound request. */
export async function newestRelease(world: Pick<World, "fetch" | "env" | "self">, timeoutMs = 30_000): Promise<Release> {
  const api = world.env["LINGTAI_RELEASES_API"] ?? RELEASES_API;
  const res = await world.fetch(`${api}/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": `lingtai/${workspace.version}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${api}/latest answered ${res.status}`);
  const body = (await res.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] };
  if (!body.tag_name) throw new Error(`${api}/latest named no tag`);
  return {
    version: body.tag_name.replace(/^v/, ""),
    assets: (body.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url })),
  };
}

/** `<hex>  <name>` per line, as `shasum -a 256` and `sha256sum` both write. */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m) out.set(m[2]!, m[1]!.toLowerCase());
  }
  return out;
}

async function download(world: Pick<World, "fetch">, url: string): Promise<Buffer> {
  const res = await world.fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Fetch this platform's binary and the board, **check both against `SHA256SUMS`
 * before a byte of either is unpacked**, and unpack them into `versions/<v>/`.
 *
 * Into a `versions/.<v>.partial-*` of its own first, then renamed: a directory
 * named for a version is always a whole one, and two unpacks at once never
 * share a staging directory. One already there is left exactly as it is — a
 * process may be running from it, and an unpack that finds another got there
 * first uses that one.
 */
export async function unpackRelease(
  world: Pick<World, "fetch" | "log">,
  paths: Paths,
  release: Release,
  platform: string,
): Promise<"unpacked" | "present"> {
  const dir = join(paths.versions, release.version);
  if (existsSync(join(dir, "lingtai"))) return "present";

  const names = [artifactName(platform), BOARD];
  const sums = release.assets.find((a) => a.name === CHECKSUMS);
  if (!sums) throw new Error(`release ${release.version} has no ${CHECKSUMS}, so nothing in it can be checked — not installed`);
  for (const name of names) {
    if (!release.assets.some((a) => a.name === name)) throw new Error(`release ${release.version} has no ${name}`);
  }

  world.log(paint.muted(`fetching ${names.join(" and ")}`));
  const expected = parseChecksums((await download(world, sums.url)).toString("utf8"));
  const fetched = new Map<string, Buffer>();
  for (const name of names) {
    const want = expected.get(name);
    if (!want) throw new Error(`${CHECKSUMS} for ${release.version} does not list ${name} — not installed`);
    const bytes = await download(world, release.assets.find((a) => a.name === name)!.url);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== want) {
      throw new Error(`${name} does not match its checksum — expected ${want}, got ${actual}. Nothing was unpacked`);
    }
    fetched.set(name, bytes);
  }

  mkdirSync(paths.versions, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "lingtai-upgrade-"));
  const partial = mkdtempSync(join(paths.versions, `.${release.version}.partial-`));
  try {
    for (const [name, bytes] of fetched) {
      const tarball = join(scratch, name);
      writeFileSync(tarball, bytes);
      const tar = spawnSync("tar", ["-xzf", tarball, "-C", partial], { encoding: "utf8" });
      if (tar.status !== 0) throw new Error(`tar could not unpack ${name}: ${tar.stderr.trim()}`);
    }
    const runs = versionRuns(partial, release.version);
    if (!runs.ok) {
      throw new Error(`the unpacked lingtai does not run here as ${release.version}, so it was not installed — it said: ${runs.said || "nothing"}`);
    }
    try {
      renameSync(partial, dir);
    } catch (err) {
      // Another unpack renamed its whole directory into place first.
      if (existsSync(join(dir, "lingtai"))) return "present";
      throw err;
    }
    return "unpacked";
  } finally {
    rmSync(partial, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------- commands --

export async function installCommand(argv: readonly string[], world: World): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "version":
      world.log(versionLine());
      return 0;
    case "upgrade":
      return upgrade(rest, world);
    case "rollback":
      return rollback(rest, world);
    case "uninstall":
      return uninstall(rest, world);
    default:
      throw new Error(`not an install command: ${command}`);
  }
}

function refuse(world: Pick<World, "log">, line: string, code = 1): number {
  world.log(paint.fail(line));
  return code;
}

/**
 * `lingtai upgrade`: the newest release, unpacked beside this one; the conductor
 * drained; then the shim moved.
 *
 * **Everything that can fail without stopping anything goes first** — the
 * question, the download, the checksum, and whether the new version runs at all
 * — so a refusal leaves the system as it was, 0042's order. The drain comes
 * before the switch, and the start is left to the person: this command has no
 * terminal to hold a daemon in.
 */
async function upgrade(argv: readonly string[], world: World): Promise<number> {
  const unknown = argv.find((a) => a !== "--despite-doctor");
  if (unknown !== undefined) return refuse(world, `lingtai upgrade [--despite-doctor] — no ${unknown}`, 2);
  const paths = installPaths(world.env);
  const current = installedVersion(world.self, paths);
  if (current === null) {
    return refuse(
      world,
      `this lingtai is not under ${paths.versions} — a checkout upgrades with git pull and lingtai restart, and nothing was fetched`,
    );
  }
  const shim = shimVersion(paths);
  if (typeof shim === "object" && shim !== null) return refuse(world, `not upgrading: ${shim.refused}`);

  const platform = installPlatform();
  if (typeof platform !== "string") return refuse(world, `not upgrading: ${platform.refused}`);

  let release: Release;
  try {
    release = await newestRelease(world);
  } catch (err) {
    return refuse(world, `could not ask GitHub Releases which version is newest — ${(err as Error).message}. Nothing changed`);
  }
  const pointed = shim ?? current;
  if (compareVersions(release.version, pointed) <= 0) {
    world.log(paint.pass(`lingtai ${pointed} is current — the newest release is ${release.version}. Nothing changed`));
    return 0;
  }

  try {
    const unpacked = await unpackRelease(world, paths, release, platform);
    world.log(
      unpacked === "present"
        ? paint.muted(`${release.version} is already unpacked in ${join(paths.versions, release.version)} — used as it is`)
        : `unpacked ${release.version} into ${join(paths.versions, release.version)}, checksum verified`,
    );
  } catch (err) {
    return refuse(world, `not upgrading: ${(err as Error).message}`);
  }

  const drained = await world.drain(`upgrading ${pointed} to ${release.version}`, argv.includes("--despite-doctor"));
  if (!drained.ok) {
    world.log(paint.held(`the shim still points at ${pointed}. lingtai upgrade again picks up where this stopped`));
    return drained.code;
  }

  pointShim(paths, release.version);
  await drained.after();
  world.log(paint.pass(`${paths.shim} now runs ${release.version} (was ${pointed})`));
  world.log(
    paint.muted(
      `${join(paths.versions, pointed)} is kept: lingtai rollback points back at it. Nothing was started — lingtai start runs ${release.version}`,
    ),
  );
  return 0;
}

/** `lingtai rollback [<version>]`: the shim, pointed at an older directory. Nothing is fetched and nothing removed. */
function rollback(argv: readonly string[], world: World): number {
  if (argv.length > 1 || argv.some((a) => a.startsWith("--"))) return refuse(world, "lingtai rollback [<version>]", 2);
  const paths = installPaths(world.env);
  const shim = shimVersion(paths);
  if (shim === null) return refuse(world, `there is no ${paths.shim} to move — nothing is installed here`);
  if (typeof shim === "object") return refuse(world, `not rolling back: ${shim.refused}`);

  const versions = installedVersions(paths);
  const target = argv[0] ?? versions.filter((v) => compareVersions(v, shim) < 0).at(-1);
  if (target === undefined) {
    return refuse(world, `nothing older than ${shim} is under ${paths.versions} — installed: ${versions.join(", ") || "none"}`);
  }
  if (!versions.includes(target)) {
    return refuse(world, `${target} is not under ${paths.versions} — installed: ${versions.join(", ") || "none"}`);
  }
  if (target === shim) {
    world.log(paint.pass(`${paths.shim} already runs ${target}. Nothing changed`));
    return 0;
  }
  const runs = versionRuns(join(paths.versions, target), target);
  if (!runs.ok) return refuse(world, `not rolling back: ${target} does not run — it said: ${runs.said || "nothing"}`);

  pointShim(paths, target);
  world.log(paint.pass(`${paths.shim} runs ${target} again (was ${shim})`));
  world.log(
    paint.muted(`a daemon started from ${shim} keeps running it — lingtai shutdown, then lingtai start, runs ${target}`),
  );
  return 0;
}

/**
 * `lingtai uninstall`: asks once, removes everything under `~/.lingtai` and the
 * shim, and then names what it could not remove.
 *
 * **What an uninstall cannot delete matters more than what it can.** The App is
 * asked about *before* anything goes, because its private key may be among what
 * goes, and after that nothing can ask GitHub anything as the App.
 */
async function uninstall(argv: readonly string[], world: World): Promise<number> {
  const unknown = argv.find((a) => a !== "--yes" && a !== "--nothing-conducts");
  if (unknown !== undefined) return refuse(world, `lingtai uninstall [--yes] [--nothing-conducts] — no ${unknown}`, 2);
  const paths = installPaths(world.env);
  const user = world.env["HOME"] ?? homedir();
  if (resolve(paths.home) === resolve(user) || resolve(paths.home) === sep) {
    return refuse(world, `not uninstalling: LINGTAI_HOME is ${paths.home}, and removing everything under it is not something to do by accident`);
  }
  const shim = shimVersion(paths);
  const ownShim = typeof shim === "string";
  if (!existsSync(paths.home) && !ownShim) {
    world.log(`nothing is installed: there is no ${paths.home} and no ${paths.shim}`);
    return 0;
  }

  // The rule the layout rests on: nothing is removed while a process runs from
  // it. A daemon started through the shim names the shim, not the directory, and
  // an agent in `worktrees/` may name neither but works in it — so the shim, and
  // anything under the home by command line or working directory, are looked for.
  const running = world.running([paths.home + sep, paths.shim]);
  if (running.length > 0) {
    world.log(paint.fail("not uninstalling — these are running from what would be removed:"));
    for (const p of running) world.log(paint.fail(`  · pid ${p.pid}  ${p.command}`));
    world.log(paint.muted("lingtai shutdown stops a daemon after its pass; then lingtai uninstall again"));
    return 1;
  }
  // A daemon from a checkout is none of those, and its agents' worktrees,
  // recipes and run logs are here all the same. The lock says it conducts.
  let holder: string | null;
  try {
    holder = await world.conducting();
  } catch (err) {
    return refuse(
      world,
      `not uninstalling: could not ask the log whether anything conducts (${(err as Error).message}) — ` +
        "a daemon's worktrees are under what would be removed. Unset LINGTAI_DATABASE_URL if that log is gone",
    );
  }
  if (holder !== null) {
    world.log(paint.fail(`not uninstalling — ${holder} holds the conductor lock, and its worktrees, recipe and run logs are under ${paths.home}`));
    world.log(paint.muted("lingtai shutdown stops a daemon after its pass; then lingtai uninstall again"));
    return 1;
  }
  const store = world.store();
  // With no log configured here the lock was not asked, and a null is not a no:
  // a daemon from a checkout reads the checkout's `.env.local`, not this copy's.
  // Anything under the home but `versions/` is a conductor's, so it is not removed
  // on a question nobody could answer.
  const state = existsSync(paths.home) ? readdirSync(paths.home).filter((name) => name !== "versions") : [];
  if (store === null && state.length > 0 && !argv.includes("--nothing-conducts")) {
    return refuse(
      world,
      `not uninstalling: no log is configured for this lingtai, so whether a daemon started elsewhere conducts on ` +
        `${state.map((name) => join(paths.home, name)).join(", ")} could not be asked. ` +
        "LINGTAI_DATABASE_URL=<its log> lingtai uninstall asks the lock; --nothing-conducts answers for it, once you know",
    );
  }

  const app = await world.app().catch((err: unknown) => ({ unread: (err as Error).message }));

  const what = ownShim ? `everything under ${paths.home}, and ${paths.shim}` : `everything under ${paths.home}`;
  // **Named, because "everything under ~/.lingtai" does not name it.** Where
  // the log is a file it is under the home, it is the only copy there has ever
  // been of it — nothing converts a log between the stores (0055) — and it goes
  // with the worktrees and the run logs in one `rmSync`. A Postgres log is
  // somewhere else and survives this, which is why only this one is said.
  if (store !== null && store.kind === "sqlite" && existsSync(store.path)) {
    world.log(
      paint.signal(
        `${store.path} is this machine's event log — every event it holds goes with it, and nothing here copies it anywhere`,
      ),
    );
  }
  if (!argv.includes("--yes") && !(await world.ask(`Remove ${what}? This cannot be undone. [y/N] `))) {
    world.log("nothing was removed");
    return 1;
  }

  // Decided before the removal, while the path it compares with still exists.
  const keyKept =
    app !== null &&
    !("unread" in app) &&
    ("path" in app.key ? !isUnder(app.key.path, paths.home) : !app.key.files.some((f) => isUnder(f, paths.home)));

  rmSync(paths.home, { recursive: true, force: true });
  if (ownShim) unlinkSync(paths.shim);
  world.log(paint.pass(`Removed ${what}.`));

  if (app === null) {
    world.log("No GitHub App was configured here, so none is left behind.");
  } else if ("unread" in app) {
    world.log(
      paint.signal(
        `A GitHub App may still exist and be installed on your repositories — it could not be asked (${app.unread}). ` +
          `Look for it at https://github.com/settings/apps and remove it there.`,
      ),
    );
  } else {
    const key =
      "path" in app.key
        ? keyKept
          ? `Its private key at ${app.key.path} was not under ${paths.home} and is still there.`
          : "Its private key is gone and cannot be recovered — if you reinstall, create a new App."
        : keyKept
          ? `Its private key is in ${app.key.variable}${app.key.files.length > 0 ? ` in ${app.key.files.join(", ")}` : " in your environment"}, which nothing here removed.`
          : `Its private key was in ${app.key.variable} in ${app.key.files.join(", ")}, which is gone — unless your shell exports ${app.key.variable} too, if you reinstall, create a new App.`;
    world.log(
      paint.signal(
        `The GitHub App ${app.slug} still exists and is still installed on ${app.repositories} ` +
          `${app.repositories === 1 ? "repository" : "repositories"} (${app.installations} ` +
          `${app.installations === 1 ? "installation" : "installations"}).`,
      ),
    );
    world.log(key);
    world.log(
      `Remove it: ${
        app.organisation
          ? `https://github.com/organizations/${app.owner}/settings/apps/${app.slug}`
          : `https://github.com/settings/apps/${app.slug}`
      }`,
    );
  }
  if (store !== null && store.kind === "postgres") {
    world.log("The log is not under ~/.lingtai: the database LINGTAI_DATABASE_URL names is untouched, and its tables are yours to drop.");
  }
  return 0;
}

// ---------------------------------------------------------------- doctor --

/** `lingtai doctor`'s row: whether a newer release exists. Asked only of an installed copy. */
export async function releaseCheck(
  world: Pick<World, "fetch" | "env" | "self">,
): Promise<{ name: string; status: "ok" | "warn" | "skip"; detail: string }> {
  const name = "release: newest";
  const paths = installPaths(world.env);
  const current = installedVersion(world.self, paths);
  if (current === null) {
    return { name, status: "skip", detail: "a checkout, not an installed copy — git pull is its upgrade, and GitHub was not asked" };
  }
  try {
    const release = await newestRelease(world, 5_000);
    return compareVersions(release.version, current) > 0
      ? { name, status: "warn", detail: `running ${current}, and ${release.version} is out — lingtai upgrade fetches it` }
      : { name, status: "ok", detail: `running ${current}, the newest release` };
  } catch (err) {
    return { name, status: "warn", detail: `running ${current} — GitHub Releases could not be asked: ${(err as Error).message}` };
  }
}

// ------------------------------------------------------------------ live --

/**
 * `ps`, filtered to command lines naming one of `needles` or working
 * directories under one, without this process or the shell that started it.
 */
export function runningFrom(needles: readonly string[]): { pid: number; command: string }[] {
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (ps.status !== 0) throw new Error(`ps could not list processes: ${ps.stderr.trim()}`);
  const dirs = needles.filter((n) => n.endsWith(sep)).flatMap((n) => [n, realpath(n) + sep]);
  const cwds = workingDirectories();
  return ps.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), command: m[2]! }))
    .filter((p) => p.pid !== process.pid && p.pid !== process.ppid)
    .filter((p) => {
      const cwd = cwds.get(p.pid);
      return needles.some((n) => p.command.includes(n)) || (cwd !== undefined && dirs.some((d) => (cwd + sep).startsWith(d)));
    });
}

/** Every process's working directory this user may read: `/proc` on Linux, `lsof` elsewhere. */
function workingDirectories(): Map<number, string> {
  const out = new Map<number, string>();
  if (existsSync("/proc/self/cwd")) {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        out.set(Number(name), readlinkSync(`/proc/${name}/cwd`));
      } catch {
        // Gone, or not ours to read.
      }
    }
    return out;
  }
  const lsof = spawnSync("lsof", ["-w", "-a", "-d", "cwd", "-F", "pn"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (lsof.error) throw new Error(`lsof could not list working directories: ${lsof.error.message}`);
  let pid = 0;
  for (const line of lsof.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid > 0) out.set(pid, line.slice(1));
  }
  return out;
}

/**
 * The real path, through its longest existing prefix — so a file that is not
 * there compares with its directory as that directory really is (`/var` is
 * `/private/var` on macOS).
 */
function realpath(path: string): string {
  const full = resolve(path);
  try {
    return realpathSync(full);
  } catch {
    const up = dirname(full);
    return up === full ? full : join(realpath(up), basename(full));
  }
}

function isUnder(path: string, dir: string): boolean {
  const p = realpath(path);
  const d = realpath(dir);
  return p === d || p.startsWith(d + sep);
}
