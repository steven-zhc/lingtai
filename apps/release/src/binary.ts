/**
 * `pnpm binary` — the CLI as one executable with Node inside it (#185).
 *
 *   dist/
 *     lingtai         this: a copy of the building Node with lingtai.cjs injected
 *     lingtai.cjs     what `pnpm build` wrote, and what goes in
 *     board/          unchanged — pure JavaScript, the same on every platform
 *
 * So `dist/` minus `lingtai.cjs` and `package.json` is what an installer unpacks
 * into `versions/<v>/`, and the binary finds `board/` beside itself.
 *
 * **SEA copies the Node that runs this**, so a binary is built on the platform
 * it is for — four builds, never a cross-compile. `node --build-sea` (Node
 * 25.5) does the copy and the injection itself, with no `postject`.
 *
 * **Signing is not optional on macOS.** The injection breaks the signature the
 * copied Node shipped with and leaves the file unsigned, and on Apple Silicon
 * the kernel kills an unsigned binary at `exec` — status 137, no dialog, no
 * message. `codesign -s -` is an ad-hoc signature, which is all `exec` asks
 * for; a Developer ID and notarisation are for browser downloads.
 * `integration/build.test.ts` builds one unsigned and asserts it is killed, so this
 * step cannot be dropped and stay green.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { platformName } from "../../cli/src/version.ts";

export interface BinaryOptions {
  /** A directory `pnpm build` wrote. */
  dist: string;
  /** Where the binary goes. Default: `lingtai` inside `dist`. */
  output?: string;
  /** Only ever `false` in the test that proves why it is `true`. */
  sign?: boolean;
}

/** The artifact's name on a release: `lingtai-macos-arm64`, and so on. */
export function artifactName(platform: string = platformName()): string {
  return `lingtai-${platform}`;
}

/** Whether this Node can build a SEA without a separate injector. */
export function canBuildSea(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 25 || (major === 25 && minor >= 5);
}

export function buildBinary({ dist, output = join(dist, "lingtai"), sign = true }: BinaryOptions): string {
  const main = join(dist, "lingtai.cjs");
  if (!existsSync(main)) throw new Error(`no ${main} — pnpm build writes it first`);
  if (!canBuildSea()) {
    throw new Error(`node ${process.versions.node} cannot build a SEA; node --build-sea needs 25.5 or later`);
  }

  const scratch = mkdtempSync(join(tmpdir(), "lingtai-sea-"));
  try {
    const config = join(scratch, "sea-config.json");
    writeFileSync(
      config,
      JSON.stringify({
        main,
        output,
        disableExperimentalSEAWarning: true,
        // The code cache and the snapshot are V8's, and specific to the Node that
        // made them. Built on the target they would be right, but neither is
        // needed to start, and a binary that starts is what this is for.
        useCodeCache: false,
        useSnapshot: false,
        // `lingtai board` loads `server.js` through vm's main-context loader,
        // the one way a SEA's `import()` reaches a file, and Node flags it as
        // experimental on every start. It is the binary's business, not the
        // person's who typed `lingtai board`.
        execArgv: ["--disable-warning=ExperimentalWarning"],
      }),
    );
    rmSync(output, { force: true });
    run(process.execPath, ["--build-sea", config]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (sign && process.platform === "darwin") {
    run("codesign", ["--sign", "-", "--force", output]);
    run("codesign", ["--verify", output]);
  }
  return output;
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
}

if (process.argv[1] === import.meta.filename) {
  const at = process.argv.indexOf("--dist");
  const dist = resolve(at > 0 && process.argv[at + 1] ? process.argv[at + 1]! : join(import.meta.dirname, "../../../dist"));
  console.log(`built ${buildBinary({ dist })} (${artifactName()})`);
}
