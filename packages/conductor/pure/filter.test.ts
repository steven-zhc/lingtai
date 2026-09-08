/**
 * What a project will take, said in one wording — and what it says when it
 * cannot say.
 *
 * Pure: `projectFilter` is given the client, so nothing here opens a database or
 * a socket. That matters more than usual, because the whole point of the module
 * is what it does on the failure path, and a failure path only reached through
 * a real GitHub is a failure path nothing tests.
 *
 * #76: the recipe on `main` named a label the core's enum did not have, so it
 * stopped parsing and every issue in the project vanished from the queue with
 * nothing anywhere saying why.
 */
import type { ProjectState } from "@lingtai/domain";
import type { GitHubClient } from "@lingtai/github";
import { describe, expect, it } from "vitest";
import { describeFilter, projectFilter } from "../src/filter.ts";

const project = { project: "lingtai", owner: "steven-zhc", base: "main" } as ProjectState;

const RECIPE = `
version: 1
repo:
  base: main
source:
  kinds: [bug, tech-debt, documentation]
  exclude: [blocked, agent:hold]
env:
  required: []
  plantAt: .env.local
gates:
  admit: []
runtime:
  agent: claude-code
`;

/** Answers one file at one ref, and nothing else. */
function client(file: string | null): GitHubClient {
  return {
    owner: "steven-zhc",
    repo: "lingtai",
    fileAt: async () => file,
  } as unknown as GitHubClient;
}

describe("projectFilter", () => {
  it("reduces a resolved recipe to what it takes, in priority order", async () => {
    const filter = await projectFilter(project, async () => client(RECIPE));

    expect(filter.ok).toBe(true);
    if (!filter.ok) return;
    expect(filter.kinds).toEqual(["bug", "tech-debt", "documentation"]);
    expect(filter.exclude).toEqual(["blocked", "agent:hold"]);
    expect(filter.ref).toBe("main");
    expect(filter.configHash).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * The failure that started this. `documentation` was refused by `WorkKind`,
   * so the whole file failed to parse — and a caller who only looked at the
   * returned queue saw a project with no work.
   */
  it("answers with the reason rather than throwing, when the recipe will not parse", async () => {
    const filter = await projectFilter(project, async () => client("version: 1\nrepo: {}\n"));

    expect(filter.ok).toBe(false);
    if (filter.ok) return;
    expect(filter.problem).toContain(".lingtai/config.yaml");
    // One line, keeping every problem: `RecipeInvalidError` puts one per line,
    // which reads badly in a column.
    expect(filter.problem).not.toContain("\n");
  });

  it("says so when there is no recipe at all", async () => {
    const filter = await projectFilter(project, async () => client(null));

    expect(filter.ok).toBe(false);
    if (filter.ok) return;
    expect(filter.problem).toContain("no .lingtai/config.yaml on main");
  });

  it("says so when the project cannot be reached, in the same shape", async () => {
    const filter = await projectFilter(project, async () => {
      throw new Error("no owner recorded — re-run lingtai add to record it");
    });

    expect(filter).toEqual({
      project: "lingtai",
      ok: false,
      problem: "no owner recorded — re-run lingtai add to record it",
    });
  });
});

describe("describeFilter", () => {
  it("names the recipe, what it picks up and what it excludes", async () => {
    const filter = await projectFilter(project, async () => client(RECIPE));
    const lines = describeFilter(filter);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^lingtai\s+recipe [0-9a-f]{12} from main$/);
    expect(lines[1]).toContain("picks up     bug > tech-debt > documentation");
    expect(lines[1]).toContain("(in priority order)");
    expect(lines[2]).toContain("excludes     blocked, agent:hold");
  });

  /**
   * A project that will take nothing gets a *line*, not an absence. Being
   * omitted is what an empty queue already looks like, which is the whole
   * confusion #76 records.
   */
  it("gives a project whose recipe will not resolve its own line, loudly", async () => {
    const filter = await projectFilter(project, async () => client("nope: 1\n"));
    const lines = describeFilter(filter);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("lingtai");
    expect(lines[0]).toContain("RECIPE INVALID");
    expect(lines[1]).toContain("nothing will be taken from this project");
  });
});
