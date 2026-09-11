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
import { describeFilter, passCeiling, projectFilter } from "../src/filter.ts";

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
  prepared:
    - name: install
      run: pnpm install
      timeout: 10m
  proposed:
    - name: build
      run: pnpm test
      timeout: 20m
    - name: review
      agent: reviewer
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
    // Parsed here so that no caller reads a duration string, and defaulted by
    // the schema rather than by a constant in the queue (0028).
    expect(filter.backoffMs).toBe(60 * 60_000);
  });

  /**
   * The denominator a running card measures a gate against (#79) — parsed here
   * for the reason `backoffMs` is, so the board never gets its own idea of what
   * `20m` is.
   *
   * All five points, including the ones nothing is configured at: an empty
   * point is `skipped` and the skip has to be visible, or a point that *was*
   * configured and silently did not run is indistinguishable from it
   * (ADR 0016 §4).
   */
  it("carries every point's actions with the timeouts already numbers", async () => {
    const filter = await projectFilter(project, async () => client(RECIPE));

    expect(filter.ok).toBe(true);
    if (!filter.ok) return;
    expect([...filter.plan.keys()]).toEqual(["admit", "prepared", "proposed", "merge", "end"]);
    expect(filter.plan.get("prepared")).toEqual([{ name: "install", budgetMs: 10 * 60_000 }]);
    // A reviewer has no clock on it, and null is not zero: a card that showed a
    // budget of 0 would say it was already out of time.
    expect(filter.plan.get("proposed")).toEqual([
      { name: "build", budgetMs: 20 * 60_000 },
      { name: "review", budgetMs: null },
    ]);
    expect(filter.plan.get("merge")).toEqual([]);
  });

  /** The recipe decides it, so a recipe that says something else is obeyed. */
  it("takes the backoff from the recipe, in milliseconds", async () => {
    const filter = await projectFilter(project, async () =>
      client(RECIPE.replace("exclude:", "backoff: 15m\n  exclude:")),
    );

    expect(filter.ok).toBe(true);
    if (!filter.ok) return;
    expect(filter.backoffMs).toBe(15 * 60_000);
  });

  /**
   * Zero is not a shorter backoff, it is the absence of the guard the $29 loop
   * bought — so it fails to resolve, naming the key, rather than throwing from
   * the middle of a queue pass.
   */
  it("refuses a backoff that is not a positive duration", async () => {
    const filter = await projectFilter(project, async () =>
      client(RECIPE.replace("exclude:", "backoff: 0s\n  exclude:")),
    );

    expect(filter.ok).toBe(false);
    if (filter.ok) return;
    expect(filter.problem).toContain("source.backoff");
    expect(filter.problem).toContain("positive duration");
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
  it("names the recipe, what it picks up and excludes, what a pass costs and when it retries", async () => {
    const filter = await projectFilter(project, async () => client(RECIPE));
    const lines = describeFilter(filter);

    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^lingtai\s+recipe [0-9a-f]{12} from main$/);
    expect(lines[1]).toContain("picks up     bug > tech-debt > documentation");
    expect(lines[1]).toContain("(in priority order)");
    expect(lines[2]).toContain("excludes     blocked, agent:hold");
    // Printed by a recipe that never mentions it, which is the point: a default
    // that spends money has to be readable without opening Lingtai's source
    // (0025 §2), and a line that only appears when it is on is not that.
    // The product and not the numbers: what an operator is deciding about is
    // what one pass of this project can cost (0039 §3).
    expect(lines[3]).toContain("a pass       up to 3 agent runs");
    // And for the same reason again: the backoff decides when this project
    // spends money next, and it was in none of the four places that describe a
    // project (#95).
    expect(lines[4]).toContain("retries      after 1h, unless a repair is pending");
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

/**
 * What a pass costs, said once so three places cannot disagree.
 *
 * On 2026-09-10 `lingtai shutdown` told an operator it would wait at most one
 * `wall`. That was true when the sentence was written and false once a refusal
 * could buy another agent run — a sentence in `apps/cli` chasing a number in
 * `packages/recipe`, with nothing between them to notice. The fix is not a
 * better sentence, it is one sentence that is **made of** the numbers, so the
 * only way to make it wrong is to change the numbers.
 */
describe("what a pass may spend", () => {
  const limits = (rounds: number, wall = "1h", wallMs = 3_600_000) => ({
    rounds,
    turns: 150,
    wall,
    wallMs,
  });

  it("multiplies the wall by the runs a pass can buy, not by the rounds", () => {
    // Two rounds is three runs: the work, then two goes at what refused it.
    // Off-by-one here is the whole failure being prevented.
    expect(passCeiling(limits(2))).toContain("up to 3 agent runs");
    expect(passCeiling(limits(2))).toContain("at most 3h");
  });

  /** The assertion the ticket asked for: change the number, the sentence moves. */
  it("changes when rounds changes", () => {
    const one = passCeiling(limits(1));
    const four = passCeiling(limits(4));

    expect(one).not.toBe(four);
    expect(one).toContain("at most 2h");
    expect(four).toContain("at most 5h");
  });

  it("reads the wall back in the recipe's own words", () => {
    // `15m` and not `900000`: this line is read against the file it came from.
    expect(passCeiling(limits(1, "15m", 900_000))).toContain("15m and 150 turns each");
    expect(passCeiling(limits(1, "15m", 900_000))).toContain("at most 30m");
  });

  /**
   * `rounds: 0` is the whole of what `repair.on: false` used to say (0039 §4),
   * and it has to read as a choice rather than as an absence — 0025 §2's rule
   * that a default which spends money is shown when it is off as well as on.
   */
  it("says where a refusal goes when nothing is bought", () => {
    const none = passCeiling(limits(0));

    expect(none).toContain("straight to you");
    expect(none).toContain("runtime.limits.rounds: 0");
    // And no product, because there is nothing to multiply.
    expect(none).not.toContain("agent runs");
  });
});
