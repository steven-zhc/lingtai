/**
 * What a render costs, as a property rather than as a stopwatch.
 *
 * #112 measured the home page at 4.68s, 4.69s and 4.82s server-side, three
 * times the detail page at a third the size, and — because `live.tsx` asks the
 * router to re-render on every append — paid again for every event the log took
 * during a run. The stage breakdown had one shape in it: `board.ts` asked each
 * project for its recipe and its queue **in series**, so two repositories cost
 * 597ms + 762ms where 762 would have done, and a third would have added a
 * third.
 *
 * A wall-clock assertion would only re-measure this machine's GitHub. What is
 * asserted here is the thing that was actually wrong and that a later edit can
 * silently undo: whether the projects overlap. It fails closed — a sequential loop deadlocks
 * on the barrier rather than merely running slower. (The recipe is a local file since #180,
 * so a render no longer fetches it at all.)
 */
import { describe, expect, it } from "vitest";
import type { ProjectState } from "@lingtai/domain";
import { DEPENDENCIES_UNREAD } from "@lingtai/conductor/discover";
import { queuedCards, type ProjectQueue } from "../src/lib/board.ts";

/** Enough of a project for a fold that only ever reads its name. */
const project = (name: string): ProjectState =>
  ({ project: name, owner: "steven-zhc", base: "main" }) as ProjectState;

/**
 * A gate every caller must arrive at before any of them may leave.
 *
 * The whole test, really. Under `Promise.all` all of them arrive; under a loop
 * of `await`s the first one waits for a second caller that the loop will not
 * send until the first has returned, and the race below reports that rather
 * than hanging for the suite's timeout.
 */
function barrier(expected: number) {
  let arrived = 0;
  let open!: () => void;
  const all = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    async wait(): Promise<void> {
      arrived += 1;
      if (arrived === expected) open();
      let timer: ReturnType<typeof setTimeout>;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`only ${arrived} of ${expected} projects were in flight at once`)),
          250,
        );
      });
      try {
        await Promise.race([all, late]);
      } finally {
        clearTimeout(timer!);
      }
    },
  };
}

/**
 * A project that answered, carrying only what the fold reads.
 *
 * `recipe` and `client` are on a resolved filter and are the *asking*'s, not
 * the fold's — nothing below this point looks at either.
 */
function resolvedFilter(name: string, kinds: string[]) {
  return {
    project: name,
    ok: true,
    kinds,
    backoffMs: 0,
    // `restarts` among them since 0040: the fold reads it for the bar's chip,
    // which names both ceilings because they multiply.
    limits: { rounds: 2, restarts: 0, turns: 150, wall: "1h", wallMs: 3_600_000 },
    plan: new Map(),
  } as unknown as Extract<ProjectQueue, { state: "listed" }>["filter"];
}

function listed(name: string, kinds: string[], refs: string[]): ProjectQueue {
  return {
    state: "listed",
    filter: resolvedFilter(name, kinds),
    offered: { runnable: [], skipped: [], kindColors: {}, dependenciesUnread: null },
    runnable: refs.map((ref) => ({
      taskId: `wi-${name}-${ref}`,
      issue: ref,
      title: `issue ${ref}`,
      kind: kinds[0]!,
    })),
  };
}

describe("the projects on a board", () => {
  it("are all asked at once, not one after the one before", async () => {
    const gate = barrier(2);
    const result = await queuedCards([project("lingtai"), project("nextloom-ai-admin")], async (p) => {
      await gate.wait();
      return listed(p.project!, ["bug"], ["1"]);
    });

    expect(result.cards.map((c) => c.project)).toEqual(["lingtai", "nextloom-ai-admin"]);
  });

  it("still fold in the order the projects were given, whichever answers first", async () => {
    const slow = new Map([["lingtai", 20]]);
    const result = await queuedCards(
      [project("lingtai"), project("nextloom-ai-admin")],
      async (p) => {
        await new Promise((r) => setTimeout(r, slow.get(p.project!) ?? 0));
        return listed(p.project!, p.project === "lingtai" ? ["bug"] : ["feature", "bug"], ["7"]);
      },
    );

    // First mention wins, and the first mention is the first *project* — the
    // rule the old loop got from being a loop, and the one concurrency is most
    // likely to take away.
    expect(result.kindOrder).toEqual(["bug", "feature"]);
    expect(result.limits.map((l) => l.project)).toEqual(["lingtai", "nextloom-ai-admin"]);
  });

  /**
   * #131, on the surface the operator watches. A ticket held by an open blocker
   * is not a card, so without this it is simply absent from Queued; and a
   * repository whose GitHub reports no dependencies shows an order nobody
   * checked against a chain. Both are listed, so neither is a problem — they
   * are notes, in `lingtai status`'s own words.
   */
  it("say what they passed over, and which issues were not checked for a blocker", async () => {
    const result = await queuedCards([project("lingtai")], async (p) => {
      const answer = listed(p.project!, ["bug"], ["121"]);
      return {
        ...answer,
        offered: {
          runnable: [],
          skipped: [
            { ref: 123, reason: "blocked-by" },
            { ref: 9, reason: "excluded-label" },
            { ref: 10, reason: "excluded-label" },
          ],
          kindColors: {},
          dependenciesUnread: DEPENDENCIES_UNREAD,
        },
      } as ProjectQueue;
    });

    expect(result.problems).toEqual([]);
    expect(result.notes).toEqual([
      { project: "lingtai", reason: "3 passed over — excluded-label 2, blocked-by 1" },
      { project: "lingtai", reason: DEPENDENCIES_UNREAD },
    ]);
  });

  it("name a project GitHub would not answer for, and keep its filter", async () => {
    const result = await queuedCards([project("lingtai")], async (p) => ({
      state: "unanswered",
      filter: resolvedFilter(p.project!, ["bug"]),
      problem: "API rate limit exceeded",
    }));

    expect(result.problems).toEqual([{ project: "lingtai", reason: "API rate limit exceeded" }]);
    // The recipe resolved, so the column still knows what this project
    // prioritises even though its queue could not be listed.
    expect(result.kindOrder).toEqual(["bug"]);
  });
});
