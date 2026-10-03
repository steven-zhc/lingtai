/**
 * #320. `electGithubSource` is `appValues`'s election, pulled out pure so the
 * pairing rule is testable on plain objects rather than on a file — a
 * temporary `config.yml` or `.env.local` is the filesystem, and a test that
 * touches it is integration under 0060 §1.
 *
 * The rule under test: **whichever source names the App ID answers for every
 * other name, and it answers alone.** `appValues`'s own docblock has the
 * history — a `.env.local` shipping the key path filled in and the id blank
 * signed the new App's JWT with the old App's key, because the two were asked
 * for by name rather than by source. A third source,
 * `~/.lingtai/config.yml` (#308), has to keep the same rule: it must not
 * become a plain fallback chain that lets the id come from one App and the
 * secret from another.
 *
 * `orderGithubSources` is `appValues`'s precedence, pulled out the same way:
 * the election tests below build their input through it rather than ordering
 * an array by hand, so a change to that one call site inside `appValues` —
 * putting `config.yml` ahead of an env file — turns them red instead of
 * leaving the bug to the integration suite that runs after a merge (#320's
 * third cold-review finding).
 */
import { describe, expect, it } from "vitest";
import { PREFIX, electGithubSource, githubRecordFromSection, orderGithubSources } from "../src/index.ts";

const ID = `${PREFIX}GITHUB_APP_ID`;
const KEY_PATH = `${PREFIX}GITHUB_APP_PRIVATE_KEY_PATH`;
const WEBHOOK = `${PREFIX}GITHUB_WEBHOOK_SECRET`;

describe("electGithubSource", () => {
  it("picks the source naming the id, and asks it for every other name too", () => {
    // The machine file names the id and its own key path; a stale key path is
    // also exported — as it would be, left over from an App this machine used
    // to point at. Built through `orderGithubSources`, the same ordering
    // `appValues` hands to `electGithubSource`, rather than hand-ordered here.
    const machine = { label: "/home/config.yml", values: { [ID]: "222", [KEY_PATH]: "/machine/key.pem" } };
    const environment = { label: "environment", values: { [KEY_PATH]: "/stale/key.pem" } };

    const elected = electGithubSource(orderGithubSources(environment, [], [machine]));
    expect(elected.source).toBe("/home/config.yml");
    // Never the stale exported path: the source that named the id supplies
    // the key path too, even though the environment is asked first in the
    // list and does name a value for that key.
    expect(elected.get(KEY_PATH)).toBe("/machine/key.pem");
  });

  it("lets an env file that names the id win over the machine file for every name", () => {
    // Through `orderGithubSources`, which is production's own precedence
    // (environment, then the env files, then the machine file last) rather
    // than an order this test chose — a reordering at that one call site
    // would turn this red (#320's third cold-review finding).
    const environment = { label: "environment", values: {} };
    const machine = {
      label: "/home/config.yml",
      values: { [ID]: "111", [KEY_PATH]: "/machine/key.pem", [WEBHOOK]: "machine-secret" },
    };
    const envFile = { label: "/repo/.env.local", values: { [ID]: "222", [KEY_PATH]: "/repo/key.pem" } };

    const elected = electGithubSource(orderGithubSources(environment, [envFile], [machine]));
    expect(elected.source).toBe("/repo/.env.local");
    expect(elected.get(ID)).toBe("222");
    expect(elected.get(KEY_PATH)).toBe("/repo/key.pem");
    // The env file says nothing about the webhook secret, and the owner
    // answers alone — this is never filled in from the machine file, which is
    // App 111's secret paired with App 222's id.
    expect(elected.get(WEBHOOK)).toBeUndefined();
  });

  it("never lets the webhook secret follow a different App than the id", () => {
    // The cold review's reproduction against cbd2713, as a unit test: a
    // machine record names the secret, an env file owns the id — again
    // through `orderGithubSources` rather than an order chosen to pass.
    const environment = { label: "environment", values: {} };
    const machine = { label: "/home/config.yml", values: { [ID]: "111", [WEBHOOK]: "machine-secret" } };
    const envFile = { label: "/repo/.env.local", values: { [ID]: "222" } };

    const elected = electGithubSource(orderGithubSources(environment, [envFile], [machine]));
    expect(elected.source).toBe("/repo/.env.local");
    expect(elected.get(WEBHOOK)).toBeUndefined();
  });

  it("answers nothing at all, for any name, when no source names an id", () => {
    const sources: { label: string; values: Record<string, string> }[] = [
      { label: "environment", values: {} },
      { label: "/home/config.yml", values: { [WEBHOOK]: "orphaned-secret" } },
    ];
    const elected = electGithubSource(sources);
    expect(elected.source).toBe("environment");
    expect(elected.get(ID)).toBeUndefined();
    // Nothing elected the id, so nothing answers for the secret either — it
    // is not a value anybody configured for an App that does not exist here.
    expect(elected.get(WEBHOOK)).toBeUndefined();
  });
});

describe("orderGithubSources", () => {
  /**
   * #320's third cold-review finding: the other tests in this file construct
   * their own `[source, source]` arrays, which pass under any precedence
   * `appValues` might hand to `electGithubSource` — so a change at that one
   * call site (`index.ts`, inside `appValues`) that put `config.yml` ahead of
   * an env file would stay green. This pins the order itself: environment
   * first, then every env file in the order it was given, then the machine
   * file last.
   */
  it("puts the environment first, the env files next, and config.yml last", () => {
    const environment = { label: "environment", values: {} };
    const envFile = { label: "/repo/.env.local", values: {} };
    const machine = { label: "/home/config.yml", values: {} };

    expect(orderGithubSources(environment, [envFile], [machine]).map((s) => s.label)).toEqual([
      "environment",
      "/repo/.env.local",
      "/home/config.yml",
    ]);
  });
});

describe("githubRecordFromSection", () => {
  it("translates the file's own keys to the LINGTAI_GITHUB_ names", () => {
    const record = githubRecordFromSection({ app_id: "42", private_key_path: "/abs/key.pem", webhook_secret: "s" }, "/home");
    expect(record).toEqual({ [ID]: "42", [KEY_PATH]: "/abs/key.pem", [WEBHOOK]: "s" });
  });

  it("resolves a relative private_key_path against home, never the checkout", () => {
    const record = githubRecordFromSection({ app_id: "42", private_key_path: "key.pem" }, "/home/.lingtai");
    expect(record[KEY_PATH]).toBe("/home/.lingtai/key.pem");
  });

  it("expands a leading tilde", () => {
    const record = githubRecordFromSection({ private_key_path: "~/key.pem" }, "/home/.lingtai");
    expect(record[KEY_PATH]).not.toContain("~");
    expect(record[KEY_PATH]?.endsWith("/key.pem")).toBe(true);
  });

  it("is empty for an absent or empty section", () => {
    expect(githubRecordFromSection(undefined, "/home")).toEqual({});
    expect(githubRecordFromSection({}, "/home")).toEqual({});
  });

  it("ignores an empty string, the same as every other value here", () => {
    expect(githubRecordFromSection({ app_id: "" }, "/home")).toEqual({});
  });

  it("reads app_id written unquoted, which YAML parses as a number", () => {
    const record = githubRecordFromSection({ app_id: 1850235 }, "/home");
    expect(record[ID]).toBe("1850235");
  });
});
