/**
 * `pnpm release <version>` — what a GitHub Release carries (#184, 0050).
 *
 *   release/
 *     lingtai-<v>-darwin-arm64.tar.gz   ┐
 *     lingtai-<v>-darwin-x64.tar.gz     │ each unpacks to what
 *     lingtai-<v>-linux-x64.tar.gz      │ ~/.lingtai/versions/<v>/ holds:
 *     lingtai-<v>-linux-arm64.tar.gz    ┘ lingtai, board/, package.json
 *     SHA256SUMS
 *
 * **Four tarballs of one content, today, and that is the point.** The CLI is
 * JavaScript and the board is pure JavaScript (0049), so every platform's
 * artifact is the same bytes. The names are per platform because #185's binary
 * is not, and when it lands it replaces `lingtai` inside each — the installer,
 * which already asks for its own platform's name, does not change.
 *
 * `lingtai` is `lingtai.cjs` renamed. Node reads an extensionless file by the
 * nearest `package.json`, which here is the generated one and has no `type`, so
 * it is CommonJS — and its `#!/usr/bin/env node` makes it runnable as a binary
 * will be.
 *
 * Publishing is a person's: `gh release create v<v> release/*`.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRelease } from "./build.ts";

/** The names `apps/cli/src/install.ts` and `install.sh` ask for. Kept in step by `test/install.test.ts`. */
export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;

export interface PackOptions {
  /** A `pnpm build` output. */
  dist: string;
  out: string;
  version: string;
}

export function packRelease({ dist, out, version }: PackOptions): string[] {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
    throw new Error(`"${version}" is not a version — 1.0.0, or 1.0.0-rc.1`);
  }
  mkdirSync(out, { recursive: true });
  const stage = mkdtempSync(join(tmpdir(), "lingtai-pack-"));
  try {
    cpSync(join(dist, "board"), join(stage, "board"), { recursive: true, verbatimSymlinks: true });
    cpSync(join(dist, "lingtai.cjs"), join(stage, "lingtai"));
    chmodSync(join(stage, "lingtai"), 0o755);
    const pkg = JSON.parse(readFileSync(join(dist, "package.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(stage, "package.json"), `${JSON.stringify({ ...pkg, version, bin: { lingtai: "lingtai" } }, null, 2)}\n`);

    const sums: string[] = [];
    const names: string[] = [];
    for (const platform of PLATFORMS) {
      const name = `lingtai-${version}-${platform}.tar.gz`;
      const tarball = join(out, name);
      // `COPYFILE_DISABLE`: macOS tar otherwise adds `._*` resource forks.
      const tar = spawnSync("tar", ["-czf", tarball, "-C", stage, "lingtai", "package.json", "board"], {
        encoding: "utf8",
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      });
      if (tar.status !== 0) throw new Error(`tar exited ${tar.status}: ${tar.stderr}`);
      sums.push(`${createHash("sha256").update(readFileSync(tarball)).digest("hex")}  ${name}`);
      names.push(name);
    }
    writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
    return [...names, "SHA256SUMS"];
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] === import.meta.filename) {
  const version = process.argv[2];
  if (!version) {
    console.error("pnpm release <version>");
    process.exit(2);
  }
  const root = resolve(import.meta.dirname, "../../..");
  const dist = join(root, "dist");
  const out = join(root, "release");
  await buildRelease({ out: dist });
  rmSync(out, { recursive: true, force: true });
  for (const name of packRelease({ dist, out, version })) console.log(`release/${name}`);
  console.log(`publish with: gh release create v${version} release/*`);
}
