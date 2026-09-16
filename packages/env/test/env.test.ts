/**
 * Where configuration values come from. No database, no network.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { envFiles, githubApp, githubWebhookSecret, hasGitHubApp, resolvePath } from "../src/index.ts";

describe("resolvePath", () => {
  /**
   * The README documented `~/.lingtai-app.pem` before this existed. Nothing
   * else expands `~` there — a shell does not read a `.env` file, dotenv takes
   * the value literally, and `path.resolve` would have produced a directory
   * *named* `~` inside the repository. The failure would have been a bare ENOENT
   * naming a path nobody wrote.
   */
  it("expands a leading tilde", () => {
    expect(resolvePath("~/.lingtai-app.pem")).toBe(resolve(homedir(), ".lingtai-app.pem"));
    expect(resolvePath("~")).toBe(homedir());
  });

  it("does not expand a tilde that is not the whole first segment", () => {
    // `~backup` is a file called that, not another user's home.
    expect(resolvePath("~backup.pem")).toContain("~backup.pem");
  });

  it("leaves an absolute path alone", () => {
    expect(resolvePath("/etc/lingtai/key.pem")).toBe("/etc/lingtai/key.pem");
  });

  it("resolves a relative path against the repository root, not the cwd", () => {
    // The same rule the environment file itself follows: a command's directory
    // must not change what configuration means.
    const fromRoot = resolvePath("../lingtai-app.pem");
    expect(fromRoot.endsWith("lingtai-app.pem")).toBe(true);
    expect(fromRoot.startsWith("/")).toBe(true);
    expect(fromRoot).not.toContain("packages/env");
  });
});

/**
 * #169. The board's setup page writes `LINGTAI_GITHUB_APP_ID` into `.env.local`
 * while the board — and a daemon — are already running. The key was always
 * re-read per call; the id came from `process.env`, fixed at start, so the page
 * that had just written the App was answered *no GitHub App configured* by its
 * own next click. The id is now read the way the key is.
 */
describe("the App is read from the env file as it is now", () => {
  it("sees an App written to the file after this module was loaded", async () => {

    const dir = await mkdtemp(join(tmpdir(), "lingtai-env-"));
    const envLocal = join(dir, ".env.local");
    const key = join(dir, "app.pem");
    const env = {};

    expect(hasGitHubApp(env, [envLocal])).toBe(false);

    await writeFile(key, "not a real key");
    await writeFile(envLocal, `LINGTAI_GITHUB_APP_ID=4242\nLINGTAI_GITHUB_APP_PRIVATE_KEY_PATH=${key}\n`);

    expect(hasGitHubApp(env, [envLocal])).toBe(true);
    expect(githubApp(env, [envLocal])).toEqual({ appId: "4242", privateKey: "not a real key", keySource: key });
  });

  it("lets a variable in the environment win over the file", async () => {

    const dir = await mkdtemp(join(tmpdir(), "lingtai-env-"));
    const envLocal = join(dir, ".env.local");
    await writeFile(envLocal, "LINGTAI_GITHUB_APP_ID=1\nLINGTAI_GITHUB_APP_PRIVATE_KEY=from-file\n");

    const app = githubApp({ LINGTAI_GITHUB_APP_ID: "2" }, [envLocal]);
    expect(app.appId).toBe("2");
    expect(app.privateKey).toBe("from-file");
  });

  /**
   * `.env.example` ships the key path filled in and the id blank, so a copied
   * `.env.local` puts a key path in `process.env` at start. The setup page then
   * writes the new App's key aside and points the file at it — and a key path
   * taken from that snapshot beside an id taken from the file signs the new
   * App's JWT with somebody else's key.
   */
  it("takes the key from the file that names the id, not from a key path the environment started with", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lingtai-env-"));
    const envLocal = join(dir, ".env.local");
    const oldKey = join(dir, "lingtai-agent.private-key.pem");
    const newKey = join(dir, "lingtai-agent.private-key.222.pem");
    await writeFile(oldKey, "app 111's key");
    await writeFile(newKey, "app 222's key");
    await writeFile(envLocal, `LINGTAI_GITHUB_APP_ID=222\nLINGTAI_GITHUB_APP_PRIVATE_KEY_PATH=${newKey}\n`);
    const started = { LINGTAI_GITHUB_APP_ID: "", LINGTAI_GITHUB_APP_PRIVATE_KEY_PATH: oldKey };

    expect(githubApp(started, [envLocal])).toEqual({ appId: "222", privateKey: "app 222's key", keySource: newKey });
  });

  /** The setup page writes the secret while the board runs; the receiver must see it. */
  it("reads the webhook secret from the file as it is now", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lingtai-env-"));
    const envLocal = join(dir, ".env.local");

    expect(githubWebhookSecret({}, [envLocal])).toBeUndefined();
    await writeFile(envLocal, "LINGTAI_GITHUB_APP_ID=222\nLINGTAI_GITHUB_WEBHOOK_SECRET=from-setup\n");
    expect(githubWebhookSecret({}, [envLocal])).toBe("from-setup");
    expect(githubWebhookSecret({ LINGTAI_GITHUB_WEBHOOK_SECRET: "set" }, [envLocal])).toBe("from-setup");
  });

  it("reads no file for an environment it was handed, unless told which", async () => {
    // `lingtai doctor` reports on the environment it is given (see `githubApp`).
    expect(hasGitHubApp({})).toBe(false);
    expect(envFiles().map((f) => f.split("/").pop())).toEqual([".env.local", ".env"]);
  });
});
