/**
 * `pnpm build` — the one publishable unit (#183, 0049).
 *
 *   dist/
 *     package.json    not private: this is the package, and nothing else is
 *     lingtai.cjs     the CLI, one CommonJS file, because a SEA's main is one
 *     board/          Next's standalone output; server.js is apps/board/server.js
 *
 * 0010 still governs development — the source runs unbuilt, and nothing here
 * changes how a checkout runs. This is for shipping, as `packages/hook`'s Bun
 * binary already was (0002).
 */
import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build as esbuild } from "esbuild";

/** `apps/release/src` → the repository root. */
const ROOT = resolve(import.meta.dirname, "../../..");

export interface BuildOptions {
  /** Emptied first, so a build never inherits a file from the one before. */
  out: string;
  root?: string;
}

export async function buildRelease({ out, root = ROOT }: BuildOptions): Promise<void> {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  buildBoard(root, out);
  await bundleCli(root, out);
  writePackage(root, out);
}

/**
 * The board, as `standalone` plus the two directories Next leaves out of it.
 *
 * Next copies neither `.next/static` nor `public` into the standalone tree — it
 * expects a CDN to serve them — so a board run from it answers every page and
 * 404s every stylesheet.
 */
function buildBoard(root: string, out: string): void {
  const app = join(root, "apps", "board");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Read by `next build` alone, which writes it to `.next/BUILD_ID`; the
    // standalone server reads that file, so a run of the board never needs this.
    // A fixed id makes two builds of one commit one layout, which the random
    // default does not.
    LINGTAI_BUILD_ID: commit(root),
    // Collecting page data imports `@lingtai/event-store`, which opens whichever
    // log this machine's configuration names. Nothing connects during the build,
    // so it gets an address that answers nothing — rather than the operator's
    // log, or, with no URL at all, the SQLite file absence would choose (#179).
    // A build must not touch either.
    LINGTAI_DATABASE_URL: "postgres://build.invalid:5432/lingtai",
  };
  // A build started under vitest must not build as a test: `NODE_ENV=test`
  // makes Next warn and build something else, and `VITEST` sends `@lingtai/env`
  // looking for the test database.
  delete env["NODE_ENV"];
  for (const name of Object.keys(env)) if (name.startsWith("VITEST")) delete env[name];

  const built = spawnSync("pnpm", ["exec", "next", "build"], { cwd: app, env, encoding: "utf8" });
  if (built.status !== 0) {
    throw new Error(`next build exited ${built.status}\n${built.stdout}\n${built.stderr}`);
  }

  const board = join(out, "board");
  // `verbatimSymlinks`: pnpm's tree is symlinks, and each is relative to where
  // it stands. Resolved, they would point back into this checkout.
  cpSync(join(app, ".next", "standalone"), board, { recursive: true, verbatimSymlinks: true });
  cpSync(join(app, ".next", "static"), join(board, "apps", "board", ".next", "static"), { recursive: true });
  cpSync(join(app, "public"), join(board, "apps", "board", "public"), { recursive: true });
  pruneSharp(board);

  const native = nativeFiles(board);
  if (native.length > 0) {
    throw new Error(`the board is not the same on every platform — native files in it:\n${native.join("\n")}`);
  }
}

/**
 * Remove `sharp` and its `@img/*` binaries, which Next's own server trace
 * names whether or not an image is ever optimised.
 *
 * `images.unoptimized` means the one module that requires sharp is never
 * reached. `outputFileTracingExcludes` was tried first and left the `.node`
 * file in place, so the output is pruned instead, and checked after.
 */
function pruneSharp(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const store = dir.endsWith(join("node_modules", ".pnpm"));
    const inModules = dir.endsWith("node_modules");
    if (
      (store && (entry.name.startsWith("sharp@") || entry.name.startsWith("@img+"))) ||
      (inModules && (entry.name === "sharp" || entry.name === "@img"))
    ) {
      rmSync(path, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      pruneSharp(path);
    }
  }
}

/** Every `.node` file under `dir`, relative to it. Symlinks are not followed. */
export function nativeFiles(dir: string): string[] {
  return layout(dir).filter((path) => path.endsWith(".node"));
}

/**
 * Every path under `dir`, sorted — what "the same layout" is measured by.
 * A symlink is listed and not entered, since it names something already listed.
 */
export function layout(dir: string, prefix = ""): string[] {
  const paths: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    paths.push(rel);
    const stat = lstatSync(join(dir, name));
    if (stat.isDirectory()) paths.push(...layout(join(dir, name), rel));
  }
  return paths;
}

/**
 * The CLI, as one CommonJS file.
 *
 * Three things the source relies on that CJS does not have, each given back:
 * `import.meta.url`, `.filename` and `.dirname` are this file's own — or the
 * binary's, once it is one — which is what every module in it would have said
 * about itself had it not been bundled.
 */
async function bundleCli(root: string, out: string): Promise<void> {
  await esbuild({
    entryPoints: [join(root, "apps", "cli", "src", "entry.ts")],
    outfile: join(out, "lingtai.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    // Inside a SEA (#185) `__filename` is the path this file had on the machine
    // that built the binary, carried into it verbatim — so `board/` and
    // `.env.local` would be looked for in the build's checkout. The binary is
    // the file that is running, so there it is `process.execPath`.
    banner: {
      js: [
        'var __lingtai_filename = require("node:sea").isSea() ? process.execPath : __filename;',
        'var __lingtai_dirname = require("node:path").dirname(__lingtai_filename);',
        'var __import_meta_url = require("node:url").pathToFileURL(__lingtai_filename).href;',
      ].join("\n"),
    },
    define: {
      "import.meta.url": "__import_meta_url",
      "import.meta.filename": "__lingtai_filename",
      "import.meta.dirname": "__lingtai_dirname",
      // `@lingtai/env` finds `.env.local` relative to itself; bundled, that is
      // `dist/`, one directory below the checkout rather than three.
      LINGTAI_BUNDLED: "true",
    },
    legalComments: "none",
    logLevel: "error",
  });
}

function writePackage(root: string, out: string): void {
  const workspace = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
    description: string;
    engines: Record<string, string>;
  };
  const pkg = {
    name: "lingtai",
    version: workspace.version,
    description: workspace.description,
    bin: { lingtai: "lingtai.cjs" },
    engines: workspace.engines,
  };
  writeFileSync(join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

/** The commit being built, or `dev` outside a checkout. */
function commit(root: string): string {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return head.status === 0 ? head.stdout.trim() : "dev";
}

if (process.argv[1] === import.meta.filename) {
  const at = process.argv.indexOf("--out");
  const out = resolve(at > 0 && process.argv[at + 1] ? process.argv[at + 1]! : join(ROOT, "dist"));
  await buildRelease({ out });
  console.log(`built ${out}`);
}
