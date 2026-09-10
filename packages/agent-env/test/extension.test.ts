/**
 * What an extension is given, and — the part the epic asks for by name — what
 * it cannot be given.
 *
 * 0016 §5 said the opposite until 0037: *"Plugins are trusted code. There is no
 * plugin sandbox. They run in the daemon's process with the daemon's
 * credentials, including the GitHub App key."* These are that paragraph's
 * retirement, written as assertions.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extensionEnv, projectEnvPath } from "../src/index.ts";

const PROJECT = "extcheck";
let home: string;

async function project(text: string): Promise<void> {
  await mkdir(join(home, "env"), { recursive: true });
  await writeFile(projectEnvPath(PROJECT, home), text);
}

/** Layer 2 — the machine's own file, where the conductor's credentials live. */
const machine = {
  LINGTAI_DATABASE_URL: "postgresql://real:secret@db.example.com:6543/postgres",
  LINGTAI_GITHUB_APP_ID: "12345",
  TELEGRAM_BOT_TOKEN: "from-the-machine",
};

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "lingtai-ext-"));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("extensionEnv", () => {
  it("gives the names the subscriber declared, and layer 1", async () => {
    await project("TELEGRAM_CHAT_ID=-100123\n");
    const env = await extensionEnv({
      project: PROJECT,
      names: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
      machine,
      home,
      from: { PATH: "/usr/bin", HOME: "/home/op", AWS_SECRET_ACCESS_KEY: "not this" },
    });

    expect(env.missing).toEqual([]);
    expect(env.values["TELEGRAM_BOT_TOKEN"]).toBe("from-the-machine");
    expect(env.values["TELEGRAM_CHAT_ID"]).toBe("-100123");
    expect(env.values["PATH"]).toBe("/usr/bin");
    // The operator's shell is not an input. `runnableEnv` takes six names and
    // this is not one of them.
    expect(env.values["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
  });

  it("takes the project's file over the machine's, like the agent's does", async () => {
    await project("TELEGRAM_BOT_TOKEN=for-this-project\n");
    const env = await extensionEnv({
      project: PROJECT,
      names: ["TELEGRAM_BOT_TOKEN"],
      machine,
      home,
      from: {},
    });
    expect(env.values["TELEGRAM_BOT_TOKEN"]).toBe("for-this-project");
  });

  /**
   * **No extension can read `LINGTAI_DATABASE_URL`** — `#126`'s last line.
   *
   * Structural rather than remembered: `isMachineOwn` strips every `LINGTAI_`
   * name from the machine's file, so there is nothing to hand over even for an
   * extension that asks by name. The recipe schema refuses the ask as well, and
   * this is the half that survives somebody editing the other.
   */
  it("has no LINGTAI_ value to give, even to one that asks for it", async () => {
    await project("");
    const env = await extensionEnv({
      project: PROJECT,
      names: ["LINGTAI_DATABASE_URL", "LINGTAI_GITHUB_APP_ID"],
      machine,
      home,
      from: { PATH: "/usr/bin" },
    });

    expect(env.values["LINGTAI_DATABASE_URL"]).toBeUndefined();
    expect(env.values["LINGTAI_GITHUB_APP_ID"]).toBeUndefined();
    expect(env.missing).toEqual(["LINGTAI_DATABASE_URL", "LINGTAI_GITHUB_APP_ID"]);
    expect(Object.values(env.values)).not.toContain(machine.LINGTAI_DATABASE_URL);
  });

  /**
   * Reported rather than dropped, for the reason `env.required` is a check and
   * not a filter (0021): a Telegram extension started without its token is an
   * HTTP 401 two minutes later, about a variable nobody thought was missing.
   */
  it("says which declared names neither file supplied", async () => {
    await project("TELEGRAM_CHAT_ID=\n");
    const env = await extensionEnv({
      project: PROJECT,
      names: ["TELEGRAM_CHAT_ID", "SLACK_WEBHOOK"],
      machine: {},
      home,
      from: {},
    });
    // An empty value is a missing one: a line somebody started and did not
    // finish is not a configured extension.
    expect(env.missing).toEqual(["TELEGRAM_CHAT_ID", "SLACK_WEBHOOK"]);
  });
});
