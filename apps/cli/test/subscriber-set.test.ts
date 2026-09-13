/**
 * The daemon's subscribers when a recipe could not be read at startup.
 *
 * `launchd` starts the daemon at login, before the network or the GitHub App
 * is reachable, so the first read of every recipe fails while every pass after
 * it conducts normally. Built once, the subscriber list stayed empty for the
 * life of the daemon and the startup line said *no subscriber declared* — a
 * project that chose to be quiet, when its recipe had not loaded.
 *
 * The recipe read is the seam: `reread` and `filters` are what `projectFilters`
 * would have answered, and nothing else is stood in for.
 */
import type { ProjectFilter } from "@lingtai/conductor";
import { describe, expect, it } from "vitest";
import { createSubscriberSet } from "../src/subscribers.ts";

const unread = (project: string): ProjectFilter => ({ project, ok: false, problem: "network is unreachable" });

const declaring = (project: string): ProjectFilter =>
  ({
    project,
    ok: true,
    recipe: {
      subscribers: [
        { name: "desktop", on: ["ApprovalRequested", "WorkItemBlocked"], run: "true", env: [] },
      ],
    },
  }) as unknown as ProjectFilter;

const options = {
  cwd: process.cwd(),
  subject: async () => null,
  resolveEnv: (async () => ({ merged: {} })) as never,
};

describe("a recipe that could not be read at startup", () => {
  it("is said to be unread, not declared none", async () => {
    const set = await createSubscriberSet({
      ...options,
      filters: [unread("lingtai")],
      reread: async () => [unread("lingtai")],
    });

    const lines = set.describe();
    expect(set.subscribers()).toEqual([]);
    expect(lines.join("\n")).not.toContain("no subscriber declared");
    expect(lines.join("\n")).toContain("lingtai unknown");
    expect(lines.join("\n")).toContain("network is unreachable");
  });

  it("is built on a later pass, once the recipe reads", async () => {
    let reachable = false;
    const said: string[] = [];
    const set = await createSubscriberSet({
      ...options,
      filters: [unread("lingtai")],
      reread: async (projects) => projects.map((p) => (reachable ? declaring(p) : unread(p))),
      log: (line) => said.push(line),
    });

    await set.retry();
    expect(set.subscribers()).toEqual([]);

    reachable = true;
    await set.retry();
    expect(set.subscribers().map((s) => `${s.project}/${s.name}`)).toEqual(["lingtai/desktop"]);
    expect(said.join("\n")).toContain("subscriber lingtai/desktop on ApprovalRequested, WorkItemBlocked");
    expect(set.describe().join("\n")).not.toContain("unknown");
  });

  it("does not ask again about a project that was read", async () => {
    let asked = 0;
    const set = await createSubscriberSet({
      ...options,
      filters: [declaring("lingtai")],
      reread: async () => {
        asked += 1;
        return [];
      },
    });

    await set.retry();
    expect(asked).toBe(0);
    expect(set.subscribers()).toHaveLength(1);
  });

  /** The per-project env failure: said, not followed by "no subscriber declared". */
  it("says so when the env files could not be read, rather than declaring none", async () => {
    const set = await createSubscriberSet({
      ...options,
      resolveEnv: (async () => {
        throw new Error("EACCES");
      }) as never,
      filters: [declaring("lingtai")],
      reread: async () => [],
    });

    const lines = set.describe().join("\n");
    expect(lines).not.toContain("no subscriber declared");
    expect(lines).toContain("EACCES");
  });
});
