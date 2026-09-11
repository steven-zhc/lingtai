/**
 * A ticket Lingtai has not touched has a page, and one nothing knows about
 * still has none.
 *
 * Every card in the Queued column 404'd, because `queued` is the one state no
 * event carries: an issue nobody has run has no stream, `loadTask` folded
 * nothing, and the route called `notFound()`. **Two facts were being flattened
 * into one 404** — *it does not exist* and *I have not touched it* — and the
 * page gave the first when it meant the second (#113).
 *
 * So the first three groups are about telling them apart, and the rest are
 * about the page that exists once they are: where it is in line, what is
 * holding it, and what pressing the button runs.
 *
 * The folds are pure and exported for exactly this, the split every fold in
 * `task.ts` makes; the rendering is asserted on the markup for the reason #101
 * established — these are facts about what a reader is shown.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Envelope } from "@lingtai/domain";
import type { GatePlan } from "@lingtai/conductor/filter";
import { exists, type StandingView, type TicketView } from "../src/lib/task.ts";
import { backoffOf, holding, place, planOf, type PlanView, type QueuedView } from "../src/lib/queued.ts";
import { Plan } from "../src/app/plan.tsx";
import { Standing } from "../src/app/standing.tsx";

let seq = 0n;

function e(streamId: string, type: string, data: unknown, at = "2026-09-09T04:12:15Z"): Envelope {
  seq += 1n;
  return {
    seq,
    streamId,
    version: 1,
    type,
    schemaVer: 1,
    data,
    actor: "conductor",
    causation: null,
    at: new Date(at),
  };
}

const TICKET: TicketView = {
  project: "lingtai",
  ref: "112",
  title: "the card cannot be opened",
  kind: "bug",
  labels: ["bug"],
  url: "https://github.com/steven-zhc/lingtai/issues/112",
  found: true,
  body: "the body",
  problem: null,
};

// ------------------------------------------- the two facts, told apart ----

describe("whether there is a page here", () => {
  /**
   * The row the ticket leads with. `wi-lingtai-112` — GitHub has it, Lingtai
   * has not touched it — was a 404, and the whole Queued column with it.
   */
  it("renders an id GitHub offers and the log has never seen", () => {
    expect(exists([], TICKET)).toBe(true);
  });

  /** `wi-lingtai-99999`. GitHub answered, and the answer was no. */
  it("still refuses an id nothing knows about", () => {
    expect(exists([], { ...TICKET, ref: "99999", found: false, body: null })).toBe(false);
  });

  /**
   * **The requirement that is not a page but a sentence.** A GitHub that will
   * not answer is not evidence that the issue is absent, and a 404 says *it
   * does not exist* — a claim Lingtai is in no position to make.
   */
  it("never 404s because GitHub could not be asked", () => {
    const unreachable: TicketView = {
      ...TICKET,
      found: null,
      body: null,
      problem: "403 on /repos/…: rate limit exceeded",
    };
    expect(exists([], unreachable)).toBe(true);
  });

  /** An id that is not `wi-<project>-<n>`: there is no issue to have a view about. */
  it("refuses an id that is not a work item", () => {
    expect(exists([], null)).toBe(false);
  });

  /**
   * The log is the authority on what Lingtai did. An item it has touched keeps
   * its page through a rate limit, a deleted issue and an unregistered project
   * alike — those cost the body, not the page (#76).
   */
  it("keeps the page for an item the log has touched, whatever GitHub says", () => {
    const own = [e("wi-lingtai-89", "WorkItemClaimed", { runId: "run-1" })];
    expect(exists(own, { ...TICKET, found: false, body: null })).toBe(true);
    expect(exists(own, null)).toBe(true);
  });
});

// ------------------------------------------------------- where in line ----

const QUEUED: QueuedView = {
  position: 4,
  inLine: 11,
  notOffered: null,
  runnableAt: null,
  paused: false,
  plan: null,
  problem: null,
};

describe("where it is in line", () => {
  it("numbers the place and says how long the line is", () => {
    expect(place(QUEUED)).toBe("4th of 11 in line");
    expect(place({ ...QUEUED, position: 1, inLine: 1 })).toBe("1st of 1 in line");
    expect(place({ ...QUEUED, position: 2 })).toBe("2nd of 11 in line");
    expect(place({ ...QUEUED, position: 3 })).toBe("3rd of 11 in line");
    // The teens are the ones a naive rule gets wrong.
    expect(place({ ...QUEUED, position: 12, inLine: 40 })).toBe("12th of 40 in line");
    expect(place({ ...QUEUED, position: 21, inLine: 40 })).toBe("21st of 40 in line");
  });

  /**
   * Null rather than a made-up place. An item nothing would claim is not
   * standing in the line, and `holding` is the answer instead.
   */
  it("says nothing about a place it is not in", () => {
    expect(place({ ...QUEUED, position: null })).toBeNull();
  });
});

describe("what is holding it", () => {
  /**
   * `#100`'s three states, which read identically in the column and were
   * absent from this page entirely because the page could not be opened.
   */
  it("says nothing about the card that is simply next", () => {
    expect(holding(QUEUED)).toBeNull();
  });

  it("says when a backing-off item returns, in `lingtai status`'s own words", () => {
    const now = Date.parse("2026-09-09T04:00:00Z");
    const view = { ...QUEUED, position: null, runnableAt: "2026-09-09T04:32:00Z" };
    expect(holding(view, now)).toBe("backing off — runnable in 32m");
  });

  /**
   * A pause outranks a backoff: an item whose backoff lifts in a minute still
   * does not move while the conductor is taking nothing, so the time would be
   * the more precise of two answers and the wrong one.
   */
  it("puts a pause above a backoff", () => {
    const now = Date.parse("2026-09-09T04:00:00Z");
    const view = { ...QUEUED, position: null, paused: true, runnableAt: "2026-09-09T04:32:00Z" };
    expect(holding(view, now)).toBe("paused — nothing will start");
  });

  /**
   * And an issue GitHub is not offering outranks both, because it is the one
   * that survives a resume: `Run it now` would append a request that matches
   * nothing, and that is the fact somebody about to press it needs.
   */
  it("puts a ticket GitHub is not offering above either", () => {
    const view = { ...QUEUED, position: null, paused: true, notOffered: "it carries a label this recipe excludes" };
    expect(holding(view)).toBe("GitHub is not offering it — it carries a label this recipe excludes");
  });
});

describe("the backoff, folded from the item's own stream", () => {
  const HOUR = 3_600_000;
  const now = Date.parse("2026-09-09T04:12:15Z");

  it("holds nothing that has never been attempted", () => {
    expect(backoffOf([], HOUR, now)).toBeNull();
  });

  it("holds an item whose last claim is inside the window", () => {
    const own = [e("wi-lingtai-89", "WorkItemClaimed", { runId: "run-1" }, "2026-09-09T03:45:00Z")];
    expect(backoffOf(own, HOUR, now)?.toISOString()).toBe("2026-09-09T04:45:00.000Z");
  });

  it("lets go once the window is past", () => {
    const own = [e("wi-lingtai-89", "WorkItemClaimed", { runId: "run-1" }, "2026-09-09T02:45:00Z")];
    expect(backoffOf(own, HOUR, now)).toBeNull();
  });

  /**
   * A repair jumps it, and only a repair (0028). The guard is against *blind*
   * retries; a repair is told what went wrong and the recipe caps how many an
   * item may buy.
   */
  it("does not hold an item with a repair pending", () => {
    const own = [
      e("wi-lingtai-89", "WorkItemClaimed", { runId: "run-1" }, "2026-09-09T03:45:00Z"),
      e("wi-lingtai-89", "RepairRequested", {
        runId: "run-1",
        attempt: 1,
        reason: "conflict",
        after: "run-1",
      }, "2026-09-09T03:50:00Z"),
    ];
    expect(backoffOf(own, HOUR, now)).toBeNull();
  });
});

// --------------------------------------------------- what will happen ----

const GATES: GatePlan = new Map([
  ["admit", []],
  ["prepared", [{ name: "install", budgetMs: 300_000 }]],
  ["proposed", [{ name: "build", budgetMs: 900_000 }, { name: "review", budgetMs: null }]],
  ["merge", []],
  ["end", [{ name: "close the ticket", budgetMs: null }]],
]);

const PLAN: PlanView = planOf(GATES, {
  limits: { turns: 150, wall: "1h", rounds: 2 },
  tier: "guarded",
});

describe("what will happen", () => {
  /**
   * ADR 0016 §4 before a run as well as after one: a point that is merely left
   * out looks exactly like one that was configured and silently did not run,
   * and only the second is Lingtai's bug.
   */
  it("names all five points, including the ones nothing is configured at", () => {
    expect(PLAN.points.map((p) => p.point)).toEqual([
      "admit",
      "prepared",
      "proposed",
      "merge",
      "end",
    ]);
    expect(PLAN.points.filter((p) => p.skipped).map((p) => p.point)).toEqual(["admit", "merge"]);
    expect(PLAN.points[2]?.actions).toEqual(["build", "review"]);
  });

  it("carries the recipe's limits, in the recipe's own words", () => {
    expect(PLAN.turns).toBe(150);
    expect(PLAN.wall).toBe("1h");
    // The third number in the same block, because what a pass costs is all
    // three of them and 0039 §3 put them together for exactly that reason.
    expect(PLAN.rounds).toBe(2);
  });

  it("renders the plan and the bounds together", () => {
    const html = renderToStaticMarkup(<Plan plan={PLAN} />);

    expect(html).toContain("what will happen");
    expect(html).toContain("prepared");
    expect(html).toContain("install");
    expect(html).toContain("close the ticket");
    // Twice: `admit` and `merge`, each stated rather than omitted.
    expect(html.match(/<span class="pill">skipped<\/span>/g)).toHaveLength(2);
    expect(html).toContain("150 turns · 1h · guarded · 2 round(s) back");
  });

  /**
   * A repair is default-on and spends an agent without being asked again, so it
   * is stated when it is off too (0025 §2) — a default that is invisible when
   * it is off is a default nobody can audit.
   */
  it("says so when a refusal buys nothing", () => {
    // `rounds: 0` is the whole of what `repair.on: false` used to say (0039
    // §4), and it has to render as loudly: a project that sends every refusal
    // to a person is making a choice somebody should be able to see.
    const none = planOf(GATES, {
      limits: { turns: 300, wall: "2h", rounds: 0 },
      tier: "guarded",
    });
    expect(renderToStaticMarkup(<Plan plan={none} />)).toContain("straight to you");
  });

  /**
   * Never merely absent, and never guessed. A page that invented five points
   * would be inviting somebody to press a button on a description of something
   * else (#76).
   */
  it("says the recipe could not be read rather than showing a plan", () => {
    const html = renderToStaticMarkup(<Plan plan={null} />);
    expect(html).toContain("The recipe could not be read");
    expect(html).not.toContain("prepared");
  });
});

// ---------------------------------------------------------- the block ----

const NEVER_RUN: StandingView = {
  state: "queued",
  since: null,
  onYou: false,
  who: "waiting for a conductor to take it",
  question: null,
  needs: null,
  diagnosis: null,
  attempt: null,
  attempts: 0,
  runId: null,
  awaitingSha: null,
  headSha: null,
  failed: [],
  deciding: null,
};

const render = (standing: StandingView, queued: QueuedView | null, unknown: string | null = null) =>
  renderToStaticMarkup(
    <Standing
      standing={standing}
      project="lingtai"
      issue={112}
      taskId="wi-lingtai-112"
      discussions={[]}
      outgoing={null}
      queued={queued}
      unknown={unknown}
    />,
  );

describe("the block, for a ticket that has never run", () => {
  it("states the state, the place in line, and that nothing has run it", () => {
    const html = render(NEVER_RUN, { ...QUEUED, plan: PLAN });

    expect(html).toContain("queued");
    expect(html).toContain("4th of 11 in line");
    expect(html).toContain("never run");
    expect(html).toContain("offered by GitHub");
    expect(html).toContain("waiting for a conductor to take it");
  });

  /**
   * The render clock is not an answer. Stamping it would put *queued now* on a
   * ticket that has sat open for a week — the substitution the card already
   * refuses (`BoardCard.updatedAt`).
   */
  it("gives no age to a ticket the log has never moved", () => {
    expect(render(NEVER_RUN, QUEUED)).not.toContain('class="sage" title=');
  });

  /** `lingtai now`, on the page that says why the item is not moving. */
  it("ends in the move a queued item has", () => {
    expect(render(NEVER_RUN, QUEUED)).toContain("Run it now");
  });

  /**
   * The same three-states-read-alike defect as #100, one page along: a card
   * that is queued *and backing off* is the one that will not be taken next,
   * and the time is the only thing that distinguishes it.
   */
  it("says when a backing-off ticket returns rather than merely that it is queued", () => {
    const html = render(NEVER_RUN, {
      ...QUEUED,
      position: null,
      runnableAt: new Date(Date.now() + 32 * 60_000).toISOString(),
    });

    expect(html).toContain("backing off — runnable in 32m");
    // And the button is still there: a request jumps the backoff (0028 §3).
    expect(html).toContain("Run it now");
  });

  /** #113's first requirement, as a sentence rather than as a status code. */
  it("says it cannot tell, when GitHub could not be asked", () => {
    const html = render(NEVER_RUN, null, "403 on /repos/…: rate limit exceeded");

    expect(html).toContain("whether it exists is not known here");
    expect(html).toContain("rate limit exceeded");
  });

  /**
   * Never merely absent (#76). A recipe that will not parse and a GitHub behind
   * a rate limit both leave the queue unanswered, and only the reason tells
   * them apart.
   */
  it("says why the queue could not be read", () => {
    const html = render(NEVER_RUN, { ...QUEUED, position: null, problem: "secondary rate limit" });

    expect(html).toContain("Its place in the queue could not be read: secondary rate limit");
    expect(html).not.toContain("offered by GitHub");
  });

  /** Nothing about the queue reaches a block that is not one. */
  it("leaves every other state exactly as it was", () => {
    const blocked: StandingView = {
      ...NEVER_RUN,
      state: "blocked",
      since: "2026-09-08T04:12:15.000Z",
      onYou: true,
      who: "waiting on you",
      attempts: 2,
    };
    const html = render(blocked, null);

    expect(html).not.toContain("Run it now");
    expect(html).not.toContain("what will happen");
    expect(html).not.toContain("in line");
  });
});
