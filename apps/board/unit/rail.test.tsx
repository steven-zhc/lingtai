/**
 * The five points, drawn as the sequence they are.
 *
 * A running card carried thirteen objects and two of them were sequences
 * wearing the clothes of a counter (#170,
 * [the-card.md](../../../doc/design/the-card.md)). The points were a wrapped
 * row of equal pills in the same `.meta` class as the money and the turns, so
 * `pill pass` green meant *a gate action passed* in one list and *this point
 * passed* in the other, and a reader had to know which list they were in before
 * the colour meant anything.
 *
 * What is asserted here is the part a screenshot cannot settle: that all five
 * points are drawn in every lane that folds, that the three states which look
 * empty are told apart by something other than lightness, that the point name
 * is said once, and that the row stayed the unit — six objects, not thirteen.
 *
 * The geometry is asserted against `globals.css` rather than against a browser,
 * because this suite has no DOM (the root `vitest.config.ts` sets no environment). A
 * number read out of the stylesheet fails when somebody changes the stylesheet,
 * which is the property that matters; a number copied into this file would
 * assert its own copy.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GATE_STEPS, STEPS, type Envelope, type Step } from "@lingtai/domain";
import type { GatePlan } from "@lingtai/conductor/filter";
import type { TaskCard } from "@lingtai/projector/task-view";
import { LANDED_OPEN, WAITING_RAILS, railCandidates, toCard } from "../src/lib/board.ts";
import { foldProgress } from "../src/lib/progress.ts";
import { Card, LandedRow } from "../src/app/page.tsx";

const CSS = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

// --- the log ---------------------------------------------------------------

let seq = 0n;

function at(time: string, type: string, data: unknown): Envelope {
  seq += 1n;
  return {
    seq,
    streamId: "run-170",
    version: Number(seq),
    type,
    schemaVer: 2,
    data,
    actor: "conductor",
    causation: null,
    at: new Date(time),
  };
}

const gate = (point: Step, action: string) => ({
  gate: point,
  action,
  runId: "run-170",
  onSha: "b1b8694",
});

/**
 * A recipe with a point holding two actions, which the repository's own does:
 * `proposed` is `build` and `review`, and it is the case `1 passed` answered
 * worst — one action of two, reported as a whole point going green.
 */
const PLAN: GatePlan = new Map([
  ["claim", []],
  ["admit", []],
  ["prepared", [{ name: "install", budgetMs: 10 * 60_000 }]],
  ["design", []],
  ["implement", []],
  ["build", []],
  ["review", []],
  [
    "proposed",
    [
      { name: "build", budgetMs: 20 * 60_000 },
      { name: "review", budgetMs: 20 * 60_000 },
    ],
  ],
  ["merge", []],
  ["end", [{ name: "close the ticket", budgetMs: null }]],
]);

/** `GatesResolved`, from a plan — the log's own record of what was configured. */
const resolved = (plan: GatePlan) =>
  at("2026-09-15T17:12:30Z", "GatesResolved", {
    runId: "run-170",
    configHash: "abc",
    points: STEPS.map((point) => ({
      gate: point,
      actions: (plan.get(point) ?? []).map((a) => a.name),
    })),
  });

/** Installed, agent finished, build running and review not reached. */
function running(): Envelope[] {
  seq = 0n;
  return [
    at("2026-09-15T17:12:20Z", "GateRequested", gate("prepared", "install")),
    at("2026-09-15T17:12:20Z", "GateStarted", gate("prepared", "install")),
    at("2026-09-15T17:12:26Z", "GatePassed", {
      ...gate("prepared", "install"),
      evidence: "ok",
      findings: [],
    }),
    at("2026-09-15T17:12:30Z", "RunStarted", {
      workItemId: "wi-lingtai-170",
      invocation: {
        command: "claude",
        args: [],
        tier: "guarded",
        limits: { turns: 150, wallMs: 3_600_000 },
      },
    }),
    resolved(PLAN),
    at("2026-09-15T17:20:42Z", "RunFinished", {
      exitCode: 0,
      turns: 48,
      durationMs: 492_000,
      costUsd: 5.92,
    }),
    at("2026-09-15T17:20:43Z", "GateRequested", gate("proposed", "build")),
    at("2026-09-15T17:20:43Z", "GateStarted", gate("proposed", "build")),
  ];
}

/** The same run, refused at the build. */
const refused = (): Envelope[] => [
  ...running(),
  at("2026-09-15T17:34:00Z", "GateFailed", {
    ...gate("proposed", "build"),
    evidence: "2 tests failed",
    findings: [],
  }),
];

/**
 * The same refusal, with the round the pipeline ordinarily buys to answer it.
 *
 * `rounds: 3` in this repository's own recipe, so this is the common path and
 * not an edge: `FixRequested`, then an agent patching the diff for minutes,
 * then `FixApplied` (`run-once.ts:1631`, `:1721`). No `RunStarted` between
 * them — a round is a step inside a run — and `task_view` keeps the card
 * `running` throughout (`task-view.ts:554`).
 */
const fixRound = (): Envelope[] => [
  ...refused(),
  at("2026-09-15T17:34:01Z", "FixRequested", {
    runId: "run-170",
    round: 1,
    of: 3,
    action: "build",
    onSha: "b1b8694",
    findings: [],
  }),
];

/** That round back, having committed nothing: the refusal stands. */
const fixSpent = (): Envelope[] => [
  ...fixRound(),
  at("2026-09-15T17:48:00Z", "FixApplied", {
    runId: "run-170",
    round: 1,
    headSha: null,
    turns: 9,
    costUsd: 0.91,
    failure: null,
  }),
];

/**
 * A pass every gate passed, and the merge lane refused.
 *
 * The scenario verbatim: `RunStarted, GatesResolved, RunFinished`, the build
 * and the review green — and then nothing at all, because `IntegrationRefused`
 * is appended to `int-lingtai-main` and never touches the run's stream. What
 * reaches the card is `task_view`'s doing: Waiting, and `conflict: base moved`
 * as the note (`task-view.ts:637`).
 */
function refusedByTheLane(): Envelope[] {
  const upToTheAgent = running().slice(0, 6);
  return [
    ...upToTheAgent,
    at("2026-09-15T17:20:43Z", "GateRequested", gate("proposed", "build")),
    at("2026-09-15T17:20:43Z", "GateStarted", gate("proposed", "build")),
    at("2026-09-15T17:21:10Z", "GatePassed", {
      ...gate("proposed", "build"),
      evidence: "ok",
      findings: [],
    }),
    at("2026-09-15T17:21:11Z", "GateRequested", gate("proposed", "review")),
    at("2026-09-15T17:21:11Z", "GateStarted", gate("proposed", "review")),
    at("2026-09-15T17:22:00Z", "GatePassed", {
      ...gate("proposed", "review"),
      evidence: "no findings",
      findings: [],
    }),
  ];
}

/**
 * The install refused, so the pipeline stopped there.
 *
 * The plan is on the record and names `build` and `review` at `proposed`, and
 * nothing whatever happened at that point — which is the same *shape* as the
 * doctor's finding below and is the opposite of it in meaning: the pipeline
 * stops at the first refusal (0041 §4), so those two not running is the
 * pipeline working.
 */
function refusedAtPrepared(): Envelope[] {
  seq = 0n;
  return [
    at("2026-09-15T17:12:20Z", "GateRequested", gate("prepared", "install")),
    at("2026-09-15T17:12:20Z", "GateStarted", gate("prepared", "install")),
    resolved(PLAN),
    at("2026-09-15T17:12:26Z", "GateFailed", {
      ...gate("prepared", "install"),
      evidence: "the lockfile is out of date",
      findings: [],
    }),
  ];
}

/**
 * A run that recorded no plan at all: `RunStarted`, `RunFinished`, nothing else.
 *
 * A run that died before `GatesResolved` was appended, or one predating the
 * event. The fold falls back to the recipe being read *now*, which is exactly
 * the case the doctor's `planned` CTE cannot see, because it selects from
 * `GatesResolved` rows.
 */
function noPlanRecorded(): Envelope[] {
  seq = 0n;
  return [
    at("2026-09-15T17:12:30Z", "RunStarted", {
      workItemId: "wi-lingtai-170",
      invocation: {
        command: "claude",
        args: [],
        tier: "guarded",
        limits: { turns: 150, wallMs: 3_600_000 },
      },
    }),
    at("2026-09-15T17:20:42Z", "RunFinished", {
      exitCode: 0,
      turns: 12,
      durationMs: 492_000,
      costUsd: 1.1,
    }),
  ];
}

/**
 * **`lingtai doctor`'s three items, as a fixture.**
 *
 * `landedWithoutSteps` finds an item that landed whose last run's
 * `GatesResolved` named actions at a point and whose stream carries no gate
 * event there at all — no request, no verdict, no approval, no waiver. That is
 * #49, #53 and #55 at `merge`, and until #170 it reached the doctor as a FAIL
 * and the board as nothing whatever.
 *
 * So: `merge` is configured, every other point ran, and the item landed.
 */
const MERGE_PLAN: GatePlan = new Map([
  ...PLAN,
  ["merge", [{ name: "approve", budgetMs: null }]],
]);

function landedPastMerge(): Envelope[] {
  seq = 0n;
  return [
    at("2026-09-15T17:12:20Z", "GateRequested", gate("prepared", "install")),
    at("2026-09-15T17:12:20Z", "GateStarted", gate("prepared", "install")),
    at("2026-09-15T17:12:26Z", "GatePassed", {
      ...gate("prepared", "install"),
      evidence: "ok",
      findings: [],
    }),
    at("2026-09-15T17:12:30Z", "RunStarted", {
      workItemId: "wi-lingtai-55",
      invocation: {
        command: "claude",
        args: [],
        tier: "guarded",
        limits: { turns: 150, wallMs: 3_600_000 },
      },
    }),
    resolved(MERGE_PLAN),
    at("2026-09-15T17:20:42Z", "RunFinished", {
      exitCode: 0,
      turns: 25,
      durationMs: 492_000,
      costUsd: 1.46,
    }),
    at("2026-09-15T17:20:43Z", "GateRequested", gate("proposed", "build")),
    at("2026-09-15T17:20:43Z", "GateStarted", gate("proposed", "build")),
    at("2026-09-15T17:21:10Z", "GatePassed", {
      ...gate("proposed", "build"),
      evidence: "ok",
      findings: [],
    }),
    at("2026-09-15T17:21:11Z", "GateRequested", gate("proposed", "review")),
    at("2026-09-15T17:21:11Z", "GateStarted", gate("proposed", "review")),
    at("2026-09-15T17:22:00Z", "GatePassed", {
      ...gate("proposed", "review"),
      evidence: "no findings",
      findings: [],
    }),
    // And nothing at all at `merge`. That is the whole of the finding.
  ];
}

// --- the card --------------------------------------------------------------

function task(over: Partial<TaskCard> = {}): TaskCard {
  return {
    taskId: "wi-lingtai-170",
    project: "lingtai",
    issue: "170",
    title: "the five points are a sequence, so draw one",
    kind: "tech-debt",
    state: "running",
    tier: "guarded",
    runId: "run-170",
    turns: 48,
    costUsd: 5.92,
    gatesPassed: 1,
    gatesFailed: 0,
    gatesWaived: 0,
    gatesApproved: 0,
    baseSha: null,
    headSha: null,
    files: null,
    insertions: null,
    deletions: null,
    note: null,
    updatedAt: new Date("2026-09-15T17:20:43Z"),
    closedAt: null,
    attempts: 2,
    restarts: 1,
    restartsOf: 1,
    lastAttemptAt: null,
    awaitingSha: null,
    awaitingApproval: false,
    blocked: false,
    needs: null,
    diagnosis: null,
    asked: false,
    answer: null,
    repairPending: false,
    repairCostUsd: 4.88,
    ...over,
  };
}

const card = (t: Partial<TaskCard>, events: Envelope[], plan = PLAN, over = false) =>
  toCard(task(t), null, foldProgress(events, plan, over));

const render = (t: Partial<TaskCard>, events: Envelope[], plan = PLAN, over = false) =>
  renderToStaticMarkup(
    <Card card={card(t, events, plan, over)} showProject={false} issue={null} paused={false} />,
  );

/**
 * The card as the *board* builds it, with `railCandidates` supplying `over`
 * rather than the test asserting its own answer.
 *
 * `laneProgress` is the one thing here that cannot be called without a
 * database, and `over` is the whole of what it decides — so the decision lives
 * in a pure function and this composes the two the way the board does.
 */
const asBoard = (t: Partial<TaskCard>, events: Envelope[], plan = PLAN) => {
  const one = task(t);
  const [candidate] = railCandidates([one]);
  return toCard(one, null, candidate ? foldProgress(events, plan, candidate.over) : null);
};

// --- reading the markup ----------------------------------------------------

/** The five segments, as the point state each carries. */
const segments = (html: string): string[] =>
  [...html.matchAll(/<li class="seg s-([a-z-]+)"/g)].map((m) => m[1] ?? "");

/** Every cell's tone, in order, across the whole rail. */
const cells = (html: string): string[] =>
  [...html.matchAll(/<span class="scell (t-[a-z]+)"/g)].map((m) => m[1] ?? "");

/** The cells belonging to one step, by its position in `GATE_STEPS`. */
function cellsAt(html: string, point: (typeof GATE_STEPS)[number]): string[] {
  const parts = html.split(/<li class="seg s-[a-z-]+"/).slice(1);
  const one = parts[GATE_STEPS.indexOf(point)] ?? "";
  return [...one.matchAll(/<span class="scell (t-[a-z]+)"/g)].map((m) => m[1] ?? "");
}

/** The five names under the bar, each with the weight it carries. */
const labels = (html: string): [string, string][] =>
  [...html.matchAll(/<span class="slab (l-[a-z]+)">([^<]*)<\/span>/g)].map((m) => [
    m[1] ?? "",
    m[2] ?? "",
  ]);

/** The one sentence under the bar, as a reader sees it — never its title. */
function sentence(html: string): string {
  const m = /<p class="snow[^"]*"[^>]*>(.*?)<\/p>/s.exec(html);
  return (m?.[1] ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * What the card carries, counted the way #170 counts it: every pill, plus the
 * sequence, which is one object however many segments it draws. That is the
 * whole of the design — the bar, its five labels and its sentence are one thing
 * that answers *where has this got to*, and thirteen boxed facts were thirteen.
 */
const objects = (html: string): number =>
  (html.match(/<li class="pill/g) ?? []).length + (html.match(/<div class="seq"/g) ?? []).length;

// --- what a running card says ---------------------------------------------

describe("a running card", () => {
  it("draws the bar, the five names and one sentence", () => {
    const html = render({}, running());

    expect(segments(html)).toEqual(["skipped", "passed", "running", "skipped", "pending"]);
    expect(labels(html).map(([, name]) => name)).toEqual([...GATE_STEPS]);
    expect((html.match(/<p class="snow/g) ?? []).length).toBe(1);
  });

  /**
   * It read `proposed:build 42s / 20m`. The highlighted label already says
   * `proposed`, so the sentence is the action and its bound and nothing else —
   * one fact said once.
   */
  it("says the point's name in the label and not again in the sentence", () => {
    const html = render({}, running());

    expect(labels(html)).toContainEqual(["l-at", "proposed"]);
    expect(sentence(html)).toMatch(/^build \d/);
    expect(sentence(html)).not.toContain("proposed");
  });

  /** The action's own bound, which is what separates slow from about to be killed. */
  it("keeps the denominator the phase is measured against", () => {
    expect(sentence(render({}, running()))).toMatch(/\/ 20m$/);
  });

  /**
   * Four tones, and `off` is the one doing work no colour can: *nothing
   * configured* and *not reached yet* are both grey, so the difference has to
   * survive being grey. It is italic, in `globals.css`.
   */
  it("gives each name the weight its point has earned", () => {
    expect(labels(render({}, running()))).toEqual([
      ["l-off", "admit"],
      ["l-done", "prepared"],
      ["l-at", "proposed"],
      ["l-off", "merge"],
      ["l-done", "end"],
    ]);
    expect(CSS).toMatch(/\.slab\.l-off\s*\{[^}]*font-style:\s*italic/);
  });

  it("says so when the agent has finished and no point has started", () => {
    const between = running().slice(0, 6);
    expect(sentence(render({}, between))).toBe("between points");
  });

  /**
   * **Six, down from thirteen.** The row is the unit: every pill on the old
   * card was a true fact somebody added for a good reason, and none of those
   * arguments was about the row (`the-bar.md`, one surface along).
   *
   * This fixture is the heaviest running card there is — elapsed, turns, the
   * work's money, what answering cost, a second attempt, a restart, a passed
   * gate and a live phase.
   */
  it("carries six objects, not thirteen", () => {
    const html = render({}, running());

    expect(objects(html)).toBeLessThanOrEqual(6);
    // And it is six because it still says all of it, not because facts were
    // dropped: the work's money and what answering cost stay two numbers (#84).
    expect(html).toContain("$5.92");
    expect(html).toContain("$4.88 answering");
    expect(html).toContain("48 turns");
  });

  /**
   * `attempt 2` and `restart 1 of 1` are 0040's two axes — depth and breadth —
   * and they sat as two unrelated pills among the scalars. One object, and the
   * two numbers still distinct inside it.
   */
  it("says which round as one object and still says both numbers", () => {
    const html = render({}, running());
    const pills = [...html.matchAll(/<li class="pill sig"[^>]*>([^<]*)</g)].map((m) => m[1]);

    expect(pills).toContain("attempt 2 · restart 1 of 1");
  });

  /**
   * `1 passed` and a green `prepared` segment are one fact at two
   * granularities. The counter goes and the rail keeps it, per point and in
   * order — and a point holding two actions draws a cell each, which is the
   * granularity the counter had and the flat row did not.
   */
  it("drops the gate counters the rail already says, per action", () => {
    const html = render({}, running());

    expect(html).not.toContain("1 passed");
    // `proposed` is `build` and `review`: the build is running and the review
    // has not been reached. One fill over the pair could not say that.
    expect(cellsAt(html, "proposed")).toEqual(["t-run", "t-pending"]);
    expect(cellsAt(html, "prepared")).toEqual(["t-pass"]);
  });

  /** A card whose stream would not read keeps the counters it always had. */
  it("keeps the counters on a card with no rail to replace them", () => {
    const html = renderToStaticMarkup(
      <Card card={toCard(task({ state: "queued" }))} showProject={false} issue={null} paused={false} />,
    );

    expect(html).toContain("1 passed");
    expect(segments(html)).toEqual([]);
  });
});

// --- all five, in every lane that folds ------------------------------------

describe("all five points, in every lane", () => {
  /**
   * ADR 0016 §4. A point that is merely omitted is indistinguishable from one
   * that was configured and silently did not run, and only the second of those
   * is Lingtai's bug — so the bar cannot be *filled means done*, and cannot
   * draw fewer than five.
   */
  it("draws five segments on a running card", () => {
    expect(segments(render({}, running()))).toHaveLength(5);
  });

  it("draws five segments on a blocked card", () => {
    const html = render(
      { state: "waiting", blocked: true, gatesFailed: 1, awaitingSha: "b".repeat(40) },
      refused(),
    );

    expect(segments(html)).toHaveLength(5);
    expect(segments(html)[GATE_STEPS.indexOf("proposed")]).toBe("failed");
    expect(labels(html)).toContainEqual(["l-bad", "proposed"]);
  });

  it("draws five segments on a landed row", () => {
    const landed = card({ state: "landed" }, landedPastMerge(), MERGE_PLAN, true);
    const html = renderToStaticMarkup(
      <LandedRow card={landed} showProject={false} issue={null} />,
    );

    expect(segments(html)).toHaveLength(5);
    // No names on a row that is one line by #81's decision; the marks are what
    // is scanned, and each segment's title says the rest.
    expect(labels(html)).toEqual([]);
  });
});

// --- a card stopped on a person --------------------------------------------

/**
 * The Waiting lane folds since #170, and a fold is not a run in flight. What is
 * asserted here is that nothing the rail brought with it overwrote the lane's
 * own reading: `waiting 3h` is a question nobody has answered, and the sentence
 * under the bar has to agree with the segment above it.
 */
describe("a card stopped on a person", () => {
  const blocked = () =>
    render(
      { state: "waiting", blocked: true, gatesFailed: 1, awaitingSha: "b".repeat(40) },
      refused(),
    );

  /**
   * The elapsed pill used to branch on *is there a rail*, which was the same
   * test as *is this card running* only while Running was the one lane that
   * folded. A refused card read `running 13h58m` about a run that is not
   * running — a plausible number, which is the worst kind.
   */
  it("keeps the lane's own number and never claims the run is in flight", () => {
    const html = blocked();

    expect(html).toMatch(/<li class="pill" title="[^"]*">waiting /);
    expect(html).not.toContain(`class="pill run"`);
  });

  /**
   * `between points` carries the title *the agent has finished and no point has
   * started yet*, which on this card is the opposite of what happened: the
   * build was refused, the segment above the sentence is red, and a person is
   * being asked. The sentence is the action and what came of it, the same shape
   * the live line has.
   */
  it("says what refused it, under the segment that says so", () => {
    const html = blocked();

    expect(sentence(html)).toBe("build refused");
    expect(html).not.toContain("between points");
    expect(html).not.toContain("the agent has finished and no point has started yet");
  });

  /** And a run with nothing refused keeps the neutral sentence it had. */
  it("leaves the in-between sentence to a run that is in between", () => {
    expect(sentence(render({}, running().slice(0, 6)))).toBe("between points");
  });

  /**
   * **A refusal that is not on this stream.** Every gate passed, the run's
   * stream ends at the last verdict, and the pass is stopped anyway: the merge
   * lane refused the integration on `int-lingtai-main`, which this fold does
   * not read. Nothing in flight and nothing refused here is *also* what a run
   * one second between two points looks like, so the lane settles it — and
   * `between points`, whose title says the agent has just finished and
   * something is coming, was the wrong half of that on the one lane 0016 §8
   * calls the lane the board exists for.
   */
  it("never says between points about a pass that is not between anything", () => {
    const html = render(
      { state: "waiting", note: "conflict: base moved", updatedAt: new Date("2026-09-15T17:25:00Z") },
      refusedByTheLane(),
    );

    expect(sentence(html)).toBe("nothing running");
    expect(html).not.toContain("between points");
    expect(html).not.toContain("the agent has finished and no point has started yet");
    // The rail itself is unchanged and honest: the gates it drew all passed.
    expect(cellsAt(html, "proposed")).toEqual(["t-pass", "t-pass"]);
    // And the reason is on the card, one line down, where `task_view` put it.
    expect(html).toContain("conflict: base moved");
  });
});

// --- a card answering a refusal --------------------------------------------

/**
 * **A refusal being answered is not a refusal**, and with `rounds: 3` it is the
 * ordinary path here rather than an edge. The pipeline stops at the first
 * refusal and then buys a round: an agent patching the diff, minutes at a time,
 * on a card `task_view` keeps `running`.
 *
 * The fold had nothing in flight for the whole of that agent's run, so the card
 * read `build refused` under a hover saying nothing was running and a person
 * was being waited on — both false, while money was being spent. The round is a
 * phase now, which is what the fixture above this stops short of.
 */
describe("a card answering a refusal", () => {
  it("names the round it is spending rather than calling the pass refused", () => {
    const html = render({}, fixRound());

    expect(sentence(html)).toMatch(/^fixing round 1 of 3 \d/);
    expect(html).not.toContain("build refused");
    expect(html).not.toContain("between points");
    expect(html).not.toContain(
      "the pipeline stops at the first refusal and waits for a person",
    );
  });

  /**
   * The round's event carries no ceiling of its own, and the fixer is launched
   * under the same `runtime.limits.wall` the implementer was (`run-once.ts:1088`,
   * `:1697`) — which `RunStarted` is the only event to write down. *Slow* and
   * *about to be killed* are the two this line exists to separate.
   */
  it("measures the round against the wall clock the run recorded", () => {
    expect(sentence(render({}, fixRound()))).toMatch(/\/ 1h$/);
  });

  /**
   * And the gap between a refusal and the round bought to answer it, which is
   * the same second the conductor spends deciding. `build refused` carries a
   * title saying a person is being waited on — a claim about the lane, and one
   * this card is the wrong lane for.
   */
  it("keeps the refusal off a card whose lane says the pass is still working", () => {
    const html = render({}, refused());

    expect(sentence(html)).toBe("between points");
    expect(html).not.toContain("build refused");
    // The segment is red all the same. The bar reports the verdict; the
    // sentence reports who is waiting on what.
    expect(cellsAt(html, "proposed")).toEqual(["t-fail", "t-pending"]);
  });

  /** The name of a phase that is not a point, printed whole and not sliced. */
  it("highlights no point for a phase that is not one", () => {
    const html = render({}, fixRound());

    expect(labels(html).filter(([tone]) => tone === "l-at")).toEqual([]);
    // And the refused segment stays red: the round is answering that verdict,
    // not replacing it.
    expect(cellsAt(html, "proposed")).toEqual(["t-fail", "t-pending"]);
  });

  /**
   * And the round coming back does not leave a phase standing. A fixer that
   * committed nothing is the refusal standing: the card goes to a person, and
   * what it says is what refused it.
   */
  it("goes back to the refusal when the round is spent", () => {
    const html = render(
      { state: "waiting", blocked: true, gatesFailed: 1, awaitingSha: "b".repeat(40) },
      fixSpent(),
    );

    expect(sentence(html)).toBe("build refused");
  });
});

// --- the seven states ------------------------------------------------------

describe("the seven states", () => {
  /**
   * Three of them look empty and mean different things. The bar has to tell
   * them apart with something that is not a lightness, or the state 0016 §4
   * calls our bug renders as somebody's configuration.
   */
  it("gives never-ran a mark of its own, apart from skipped and from pending", () => {
    const html = renderToStaticMarkup(
      <LandedRow
        card={card({ state: "landed" }, landedPastMerge(), MERGE_PLAN, true)}
        showProject={false}
        issue={null}
      />,
    );

    expect(cellsAt(html, "merge")).toEqual(["t-never"]);
    expect(cellsAt(html, "admit")).toEqual(["t-skipped"]);
    expect(cellsAt(html, "end")).toEqual(["t-pending"]);

    // Three classes is not three treatments. The stylesheet is where that is
    // decided, so it is where it is asserted: a hatch, an outline with no fill,
    // and a flat rule.
    expect(CSS).toMatch(/\.scell\.t-never\s*\{[^}]*repeating-linear-gradient/);
    expect(CSS).toMatch(/\.scell\.t-skipped\s*\{[^}]*background:\s*transparent[^}]*dashed/);
    expect(CSS).toMatch(/\.scell\.t-pending\s*\{[^}]*background:\s*var\(--rule\)/);
  });

  it("fills passed, failed, running and waived, and never waived in green", () => {
    expect(CSS).toMatch(/\.scell\.t-pass\s*\{[^}]*var\(--pass\)/);
    expect(CSS).toMatch(/\.scell\.t-fail\s*\{[^}]*var\(--fail\)/);
    expect(CSS).toMatch(/\.scell\.t-run\s*\{[^}]*var\(--accent\)/);
    // A person's word standing in for a gate: the held colour, and an override
    // of a red build must not look like a build that went green.
    expect(CSS).toMatch(/\.scell\.t-waived\s*\{[^}]*var\(--held\)/);
    expect(CSS).not.toMatch(/\.scell\.t-waived\s*\{[^}]*var\(--pass\)/);
  });

  /**
   * The same comparison `lingtai doctor` makes, made where a person is already
   * looking. It failed on #49, #53 and #55 for months; the board drew `merge`
   * as `skipped`-coloured silence, because the fold had no way to know the pass
   * was over.
   */
  it("reaches the card from the run doctor fails on", () => {
    const over = foldProgress(landedPastMerge(), MERGE_PLAN, true);
    expect(over?.points.find((p) => p.point === "merge")?.state).toBe("never-ran");

    // And never on a run still in flight, where a point not reached yet is the
    // ordinary case and painting it red would put the fail colour everywhere.
    const live = foldProgress(landedPastMerge(), MERGE_PLAN, false);
    expect(live?.points.find((p) => p.point === "merge")?.state).toBe("pending");
  });
});

// --- what may be called our bug --------------------------------------------

/**
 * `never-ran` is the one mark on the rail that accuses Lingtai rather than
 * reporting on a run, so the rule that draws it is held to exactly the
 * comparison `landedWithoutSteps` makes — *this item landed*, and *against
 * the plan the log says this run was given*. Everything looser than that puts
 * the hatch on a pipeline that was working.
 */
describe("the hatch, and what may not draw it", () => {
  /**
   * The pipeline stops at the first refusal (0041 §4), so a run refused at
   * `prepared` has a `proposed` that correctly recorded nothing. Close the
   * ticket and the card joins the Landed column — `COLUMN_OF.closed` is
   * `landed` — which is the whole of how a closed item can be mistaken for a
   * landed one. The doctor is anchored on `WorkItemLanded` and never reports
   * this run; the board must not either.
   */
  it("never draws it on a closed item whose run was refused", () => {
    const html = renderToStaticMarkup(
      <Card
        card={asBoard({ state: "closed", gatesFailed: 1 }, refusedAtPrepared())}
        showProject={false}
        issue={null}
        paused={false}
      />,
    );

    expect(segments(html)).toEqual(["skipped", "failed", "pending", "skipped", "pending"]);
    expect(cells(html)).not.toContain("t-never");
  });

  /** And the flag itself, which is where that is decided. */
  it("calls an item landed only when it landed", () => {
    const landed = railCandidates([task({ state: "landed" })]);
    const closed = railCandidates([task({ state: "closed" })]);

    expect(landed.map((c) => c.over)).toEqual([true]);
    expect(closed.map((c) => c.over)).toEqual([false]);
  });

  /**
   * The doctor's `planned` CTE selects from `GatesResolved` rows, so a stream
   * without one contributes nothing to it. Here such a stream falls back to the
   * recipe being read *now* — which may not be the one this run got — and a
   * recipe the run never saw cannot accuse it of skipping a point.
   */
  it("never draws it from a plan the log did not record", () => {
    const over = foldProgress(noPlanRecorded(), PLAN, true);

    expect(over?.points.map((p) => p.state)).toEqual([
      // claim, design, implement, build, review — nothing planned and nothing
      // recorded, which is `skipped` and not an accusation (#227).
      "skipped",
      "skipped",
      "pending",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
      "pending",
      "skipped",
      "pending",
    ]);
  });

  /**
   * **The hatch at a step `gates:` has no key for**, which is the case a
   * name-based filter on the bar would have lost in silence (#227).
   *
   * `GatesResolved` records all ten steps and `foldProgress` folds all ten, so
   * this state is reachable from the log today; 0061 §1 makes it reachable from
   * a recipe the day `gates:` becomes `steps:`. Either way the rule is 0016 §4
   * and it does not care which five the recipe can name: a step that was
   * configured and did not run must be **on** the bar wearing the hatch,
   * because a step that is merely missing from it reads as one nobody
   * configured — and only the first of those is Lingtai's bug.
   */
  const IMPLEMENT_PLAN: GatePlan = new Map([...PLAN, ["implement", [{ name: "design", budgetMs: null }]]]);

  function landedPastImplement(): Envelope[] {
    seq = 0n;
    return [
      at("2026-09-15T17:12:30Z", "RunStarted", {
        workItemId: "wi-lingtai-227",
        invocation: {
          command: "claude",
          args: [],
          tier: "guarded",
          limits: { turns: 150, wallMs: 3_600_000 },
        },
      }),
      resolved(IMPLEMENT_PLAN),
      at("2026-09-15T17:20:42Z", "RunFinished", {
        exitCode: 0,
        turns: 25,
        durationMs: 492_000,
        costUsd: 1.46,
      }),
    ];
  }

  it("draws a step outside GATE_STEPS that was configured and did not run", () => {
    const over = foldProgress(landedPastImplement(), IMPLEMENT_PLAN, true);
    expect(over?.points.find((p) => p.point === "implement")?.state).toBe("never-ran");

    const html = render({ state: "landed" }, landedPastImplement(), IMPLEMENT_PLAN, true);

    // The five, plus `implement` — in pass order, so it sits after `prepared`.
    expect(labels(html).map(([, name]) => name)).toEqual([
      "admit",
      "prepared",
      "implement",
      "proposed",
      "merge",
      "end",
    ]);
    expect(segments(html)[2]).toBe("never-ran");
  });

  /**
   * And the other half of the same rule: a step nothing is configured at is
   * `skipped`, which is the one state the bar may leave out — the five that
   * `gates:` cannot name say it on every card there has ever been, and drawing
   * ten names is a card redesign rather than a rename (`.segs` is `repeat(5,…)`).
   */
  it("leaves out the five that say nothing, and only those", () => {
    const html = render({ state: "landed" }, landedPastMerge(), MERGE_PLAN, true);

    expect(labels(html).map(([, name]) => name)).toEqual([...GATE_STEPS]);
  });
});

// --- what a lane costs, and what it says -----------------------------------

describe("which cards draw a rail", () => {
  /**
   * The lane the board exists for (0016 §8) is also the lane that stalls —
   * `COLUMNS` says "45 items and growing" — and the rail reads a whole run
   * stream per card on a route that re-renders on every append (`live.tsx`).
   * *It is small* is not a bound; `WAITING_RAILS` is.
   */
  it("bounds the Waiting fold, however long the lane is", () => {
    const lane = Array.from({ length: 45 }, (_, i) =>
      task({ taskId: `wi-${i}`, runId: `run-${i}`, state: "waiting" }),
    );

    const folded = railCandidates(lane);
    expect(folded).toHaveLength(WAITING_RAILS);
    // The head of the lane, in the order `readTasks` gives it — oldest wait
    // first, which is what to do next.
    expect(folded.map((c) => c.task.taskId)).toEqual(
      lane.slice(0, WAITING_RAILS).map((t) => t.taskId),
    );
  });

  /**
   * `Landed` opens the newest `LANDED_OPEN` rows of *all* its cards and
   * collapses the rest, and a ticket closed on GitHub before any run was
   * claimed has no `runId` and a fresh `updatedAt` — so it occupies an open row
   * without folding. Filtering `runId` before the slice rather than after would
   * fill that place from the fourth-newest card, drawing a rail on a row inside
   * the `older` disclosure.
   */
  it("folds the Landed rows the lane draws open, and no others", () => {
    const row = (taskId: string, runId: string | null, state: TaskCard["state"], hour: number) =>
      task({ taskId, runId, state, updatedAt: new Date(`2026-09-16T0${hour}:00:00Z`) });
    const rows = [
      row("never-claimed", null, "closed", 9),
      row("landed-b", "run-b", "landed", 8),
      row("closed-c", "run-c", "closed", 7),
      row("collapsed-d", "run-d", "landed", 6),
    ];
    expect(rows).toHaveLength(LANDED_OPEN + 1);

    const folded = railCandidates(rows);
    expect(folded.map((c) => c.task.taskId)).toEqual(["landed-b", "closed-c"]);
  });
});

// --- the geometry, the motion and the palette ------------------------------

describe("what the column can give a card", () => {
  /**
   * `22rem` is the width the column actually gives a card, so *does it fit* is
   * settled rather than assumed — and the labels are the constraint, because
   * `prepared` and `proposed` are the longest things in the bar.
   *
   * The numbers come out of the stylesheet, so raising the label's size fails
   * here rather than wrapping the bar on somebody's screen.
   */
  it("fits the five names at 22rem without wrapping", () => {
    const fontSize = Number(/\.slab\s*\{[^}]*font-size:\s*([\d.]+)px/.exec(CSS)?.[1]);
    const gap = Number(/\.segs\s*\{[^}]*gap:\s*([\d.]+)px/.exec(CSS)?.[1]);
    const padding = Number(/^\.card\s*\{[^}]*padding:\s*[\d.]+px\s+([\d.]+)px/m.exec(CSS)?.[1]);
    expect(fontSize).toBeGreaterThan(0);
    expect(gap).toBeGreaterThan(0);
    expect(padding).toBeGreaterThan(0);

    // 22rem at the app's 16px root, less the card's own padding and its two
    // borders — the stripe is 2px and the right edge is 1px.
    const inside = 22 * 16 - padding * 2 - 3;
    const column = (inside - gap * 4) / 5;
    // A monospace advance is 0.6em in every face this app names.
    const longest = Math.max(...GATE_STEPS.map((p) => p.length)) * fontSize * 0.6;

    expect(longest).toBeLessThanOrEqual(column);
    // And the bar is a grid of five, not a flex row that could wrap instead.
    expect(CSS).toMatch(/\.segs\s*\{[^}]*grid-template-columns:\s*repeat\(5,/);
  });
});

describe("the motion", () => {
  /** Every class the card and its row draw, so "on the card" is a list and not a hope. */
  const CARD_CLASSES = [
    "card",
    "id",
    "ti",
    "proj",
    "iss",
    "kdot",
    "meta",
    "pill",
    "seq",
    "segs",
    "seg",
    "sbar",
    "scell",
    "slab",
    "snow",
    "question",
    "held",
    "btnrow",
    "lrow",
    "lseq",
    "lmeta",
  ];

  /** Selector → declarations, for every rule that sets an animation. */
  const animated = [...CSS.matchAll(/([^{}]+)\{([^}]*animation:[^}]*)\}/g)].map((m) => ({
    selector: (m[1] ?? "").trim().split("\n").at(-1)?.trim() ?? "",
    body: m[2] ?? "",
  }));

  it("moves the running segment and nothing else on the card", () => {
    const moving = animated.filter((r) => !/animation:\s*none/.test(r.body));
    const onCard = moving.filter((r) =>
      CARD_CLASSES.some((c) => new RegExp(`\\.${c}\\b`).test(r.selector)),
    );

    expect(onCard.map((r) => r.selector)).toEqual([".scell.t-run"]);
  });

  it("holds still for a reader who has asked it to", () => {
    // The blanket rule at the top of the file, and the segment's own — so that
    // deleting the first cannot quietly leave a card pulsing.
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \* \{[^}]*animation: none/);
    expect(CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{ \.scell\.t-run \{ animation: none; \} \}/,
    );
  });
});

describe("the palette", () => {
  /** Everything `var(--…)` the sequence's own rules reach for. */
  const block = CSS.slice(CSS.indexOf("--- the sequence"), CSS.indexOf("--- queued ---"));
  const used = new Set([...block.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1] ?? ""));

  it("adds no token, and names one that both themes define", () => {
    const light = CSS.slice(CSS.indexOf(":root {"), CSS.indexOf("@media (prefers-color-scheme"));
    const dark = CSS.slice(CSS.indexOf("@media (prefers-color-scheme"), CSS.indexOf("* { box-sizing"));

    expect(used.size).toBeGreaterThan(0);
    for (const token of used) {
      // Declared, and declared at the top of the file rather than here: the bar
      // adds no colour of its own.
      const declared = new RegExp(`${token}:\\s*([^;]+);`).exec(light);
      expect(declared, `${token} is not a token`).not.toBeNull();
      // A colour has a second value, for the other ground. Type and the mark
      // are not a theme's and are declared once — `--mono` is the same face in
      // both, which is why it is not in the dark block.
      if ((declared?.[1] ?? "").trim().startsWith("#")) {
        expect(dark, `${token} has no dark value`).toContain(`${token}:`);
      }
    }
  });

  /**
   * Amber means *a person is the thing being waited on* and nothing else. On a
   * card that is the blocked lane, which is a pill above; the bar has seven
   * states and not one of them is a person waiting.
   */
  it("leaves amber to the lane that is asking for somebody", () => {
    expect(used.has("--signal")).toBe(false);
    expect(used.has("--signal-soft")).toBe(false);
  });
});
