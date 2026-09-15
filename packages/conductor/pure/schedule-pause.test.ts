/**
 * A pass that is asked whether it is paused, and is (#166).
 *
 * `lingtai run` works the whole queue through `runQueue`, and a pause issued
 * while its first ticket ran used to be heard by nobody: the command read it
 * once, before the lock, and the loop went round and took the second. The
 * answer is asked every time round, before anything is offered or claimed —
 * this is the first time round, where nothing may be asked of GitHub at all.
 * The second time round, with a ticket finished between, is
 * `test/run-once.test.ts`'s, because that needs the projection.
 */
import type { GitHubClient } from "@lingtai/github";
import type { Runtime } from "@lingtai/agent";
import type { ProjectState } from "@lingtai/domain";
import type { Recipe } from "@lingtai/recipe";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { AgentHost, Repo } from "../src/ports.ts";
import { runQueue } from "../src/schedule.ts";

// Every one of these throws: a paused pass reaches none of them.
const untouched = <T>(what: string): T =>
  new Proxy({}, {
    get: (_, key) => {
      if (key === "then") return undefined;
      return () => {
        throw new Error(`a paused pass reached ${what}.${String(key)}`);
      };
    },
  }) as T;

describe("runQueue under a pause", () => {
  it("stops before it asks GitHub for anything, and says why", async () => {
    const lines: string[] = [];
    let asked = 0;
    const outcome = await Effect.runPromise(
      runQueue({
        project: { project: "purecheck" } as ProjectState,
        client: untouched<GitHubClient>("client"),
        runtime: untouched<Runtime>("runtime"),
        hookBinary: "/nonexistent",
        prompt: "p",
        recipe: untouched<Recipe>("recipe"),
        paused: async () => {
          asked += 1;
          return "paused by human:ops — migrating the database";
        },
        log: (l) => lines.push(l),
      }).pipe(
        Effect.provide(
          Layer.merge(Layer.succeed(Repo, untouched("repo")), Layer.succeed(AgentHost, untouched("agent"))),
        ),
      ),
    );

    expect(asked).toBe(1);
    expect(outcome.stopped).toBe("paused");
    expect(outcome.ran).toEqual([]);
    expect(lines).toContain("paused by human:ops — migrating the database");
  });
});
