/**
 * `lingtai approve --reject`, from the command line a person types.
 *
 * `--reject` went in #150, and `parseFlags` accepts any flag — so the habit
 * the docs had taught for months ran a plain approve and merged the diff the
 * person meant to refuse, with an approval on the log they never gave. The
 * flag is refused by name, before anything is read or appended, which is why
 * this needs no database: a project that does not exist is never looked up.
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("lingtai approve", () => {
  it("refuses --reject rather than approving, and names requeue", async () => {
    const outcome = await run(
      process.execPath,
      ["apps/cli/src/lingtai.ts", "approve", "nosuchproject", "--issue", "41", "--reject", "wrong approach"],
      { cwd: root, env: process.env, timeout: 60_000 },
    ).then(
      () => ({ code: 0, stderr: "" }),
      (err: { code: number; stderr: string }) => ({ code: err.code, stderr: err.stderr }),
    );

    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toContain("no --reject");
    expect(outcome.stderr).toContain("lingtai requeue nosuchproject --issue 41 --note");
  }, 90_000);
});
