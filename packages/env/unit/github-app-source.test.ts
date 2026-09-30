/**
 * #308. `electGithubSource` is `appValues`'s election, pulled out pure so the
 * pairing rule is testable on plain objects rather than on a file — a
 * temporary `config.yml` or `.env.local` is the filesystem, and a test that
 * touches it is integration under 0060 §1.
 *
 * The rule under test: **whichever source names the App ID is asked first for
 * every other name.** `appValues`'s own docblock has the history — a
 * `.env.local` shipping the key path filled in and the id blank signed the
 * new App's JWT with the old App's key, because the two were asked for by
 * name rather than by source. A third source, `~/.lingtai/config.yml`
 * (#308), has to keep the same rule: it must not become a plain fallback
 * chain that lets the id come from one App and the key from another.
 */
import { describe, expect, it } from "vitest";
import { electGithubSource, githubRecordFromSection, PREFIX } from "../src/index.ts";

const ID = `${PREFIX}GITHUB_APP_ID`;
const KEY_PATH = `${PREFIX}GITHUB_APP_PRIVATE_KEY_PATH`;
const WEBHOOK = `${PREFIX}GITHUB_WEBHOOK_SECRET`;

describe("electGithubSource", () => {
  it("picks the source naming the id, and asks it for every other name too", () => {
    // The machine file names the id and its own key path; a stale key path is
    // also exported — as it would be, left over from an App this machine used
    // to point at.
    const machine = { label: "/home/config.yml", values: { [ID]: "222", [KEY_PATH]: "/machine/key.pem" } };
    const environment = { label: "environment", values: { [KEY_PATH]: "/stale/key.pem" } };

    const elected = electGithubSource([environment, machine]);
    expect(elected.source).toBe("/home/config.yml");
    // Never the stale exported path: the source that named the id supplies
    // the key path too, even though the environment is asked first in the
    // list and does name a value for that key.
    expect(elected.get(KEY_PATH)).toBe("/machine/key.pem");
  });

  it("lets an env file that names the id win over the machine file for every name", () => {
    const machine = {
      label: "/home/config.yml",
      values: { [ID]: "111", [KEY_PATH]: "/machine/key.pem", [WEBHOOK]: "machine-secret" },
    };
    const envFile = { label: "/repo/.env.local", values: { [ID]: "222", [KEY_PATH]: "/repo/key.pem" } };

    const elected = electGithubSource([envFile, machine]);
    expect(elected.source).toBe("/repo/.env.local");
    expect(elected.get(ID)).toBe("222");
    expect(elected.get(KEY_PATH)).toBe("/repo/key.pem");
    // The env file says nothing about the webhook secret, so — and only then
    // — the next source is asked, same as an ordinary fallback chain would.
    expect(elected.get(WEBHOOK)).toBe("machine-secret");
  });

  it("falls back to the next source only for a name the owner does not say", () => {
    const machine = { label: "/home/config.yml", values: { [ID]: "1", [WEBHOOK]: "from-machine" } };
    const elected = electGithubSource([{ label: "environment", values: {} }, machine]);
    expect(elected.get(WEBHOOK)).toBe("from-machine");
  });

  it("names \"environment\" as the source when nothing names an id", () => {
    const elected = electGithubSource([{ label: "environment", values: {} }]);
    expect(elected.source).toBe("environment");
    expect(elected.get(ID)).toBeUndefined();
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
});
