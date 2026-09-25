/**
 * The six bodies, read through the loop rather than beside it.
 *
 * Every test here calls `runPass` with `bodiesFor(ports)` and asserts on the
 * `PassResult`, because a body's whole job is *which ending this answer is* and
 * an ending only means something where the loop reads it: a refusal travels to
 * `proposed`, a `needs-input` is the one `did-not-finish` with anywhere to go,
 * and a `never-ran` releases the item. Calling a body directly would check the
 * return value and nothing the return value is for.
 *
 * Nothing leaves the system. `PassPorts` is a fake — no process, no worktree, no
 * agent, no GitHub, no store — which is what puts this file in `unit/` and has
 * the `build` point run it ([0060](../../../doc/decisions/0060-the-gate-runs-unit-tests.md)
 * §1).
 */
import type { Action, ActionContext, ActionResult } from "@lingtai/actions";
import type { Envelope, PayloadOf, ToAppend } from "@lingtai/domain";
import type { Worktree } from "@lingtai/repo";
import { StepMap, type StepAction } from "@lingtai/recipe";
import { describe, expect, it } from "vitest";
import { NEEDS_INPUT, outcomeOf, runPass, type PassOptions, type PassResult } from "../src/pass.ts";
import {
  END_UNRESOLVED,
  bodiesFor,
  type Brief,
  type Claimed,
  type Cut,
  type Drafted,
  type PassPorts,
  type SentBack,
  type Taken,
  type Worked,
} from "../src/pass-steps.ts";

// --------------------------------------------------------------- fixtures ----

const BASE = "0000000000000000000000000000000000000000";
const CUT_AT = "1111111111111111111111111111111111111111";
const COMMITTED = "2222222222222222222222222222222222222222";

const context: ActionContext = { runId: "run-1", onSha: BASE, cwd: "/nowhere", env: {} };

const ITEM: Claimed = {
  workItemId: "wi-lingtai-259",
  ticket: { ref: "259", title: "T4a", body: "six bodies, filling a contract that already runs" },
  kind: "feature",
};

const TREE: Worktree = {
  path: "/nowhere/worktrees/lingtai/run-1",
  branch: "agent/259",
  baseSha: CUT_AT,
  plantedAt: "/nowhere/worktrees/lingtai/run-1/.env",
  remoteHead: null,
};

const CLOSE_ON_LANDED: StepAction = { name: "close the ticket", close: true, when: "landed" };
const HOLD_ON_BLOCKED: StepAction = { name: "hold it", labels: ["agent:hold"], when: "blocked" };

const PASSED: ActionResult = { verdict: "passed", evidence: "green", findings: [] };
const RED: ActionResult = { verdict: "failed", evidence: "pnpm install exited 1", findings: [] };

const canned = (name: string, result: ActionResult): Action => ({
  name,
  kind: "run",
  run: async () => result,
});

/** A recipe with only the ten steps on it, resolved by the real schema. */
const recipeWith = (steps: Record<string, unknown> = {}): PassOptions["recipe"] => ({
  steps: StepMap.parse(steps),
});

/** What the fake ports were asked, so a test can read the brief a step built. */
interface Asks {
  take: number;
  cut: { claimed: Claimed; again: SentBack | null }[];
  draft: Brief[];
  dispatch: Brief[];
  read: string[];
  record: { workItemId: string; at: number; plan: readonly ToAppend[] }[];
}

interface Answers {
  take?: Taken | (() => Taken);
  cut?: Cut | (() => Cut);
  draft?: Drafted | (() => Drafted);
  dispatch?: Worked | ((brief: Brief) => Worked);
  /** The stream `end` reads. Empty is an item with nothing resolved on it. */
  stream?: readonly Envelope[];
  /** Thrown by `readEnd`, so `end`'s own failure can be reached. */
  readThrows?: Error;
  recordThrows?: Error;
}

function portsAnswering(answers: Answers = {}): { ports: PassPorts; asked: Asks } {
  const asked: Asks = { take: 0, cut: [], draft: [], dispatch: [], read: [], record: [] };
  const of = <T, A>(given: T | ((arg: A) => T) | undefined, fallback: T, arg: A): T =>
    given === undefined ? fallback : typeof given === "function" ? (given as (a: A) => T)(arg) : given;

  const ports: PassPorts = {
    take: async () => {
      asked.take += 1;
      return of(answers.take, { taken: ITEM }, undefined);
    },
    cut: async (claimed, again) => {
      asked.cut.push({ claimed, again });
      return of(answers.cut, { worktree: TREE }, undefined);
    },
    draft: async (brief) => {
      asked.draft.push(brief);
      return of(answers.draft, { document: "" }, brief);
    },
    dispatch: async (brief) => {
      asked.dispatch.push(brief);
      return of(answers.dispatch, { committed: COMMITTED }, brief);
    },
    readEnd: async (workItemId) => {
      asked.read.push(workItemId);
      if (answers.readThrows) throw answers.readThrows;
      return answers.stream ?? [];
    },
    recordEnd: async (workItemId, at, plan) => {
      asked.record.push({ workItemId, at, plan });
      if (answers.recordThrows) throw answers.recordThrows;
    },
  };
  return { ports, asked };
}

/** One run of the whole pass, with whatever the recipe declares and the ports say. */
async function pass(
  options: {
    steps?: Record<string, unknown>;
    answers?: Answers;
    actions?: Record<string, readonly Action[]>;
    ceilings?: PassOptions["ceilings"];
  } = {},
): Promise<{ result: PassResult; asked: Asks; ports: PassPorts }> {
  const { ports, asked } = portsAnswering(options.answers);
  const result = await runPass({
    recipe: recipeWith(options.steps),
    context,
    emit: () => {},
    bodies: bodiesFor(ports),
    ceilings: options.ceilings,
    actionsAt: (step, actions) =>
      options.actions?.[step] ?? actions.map((a) => canned(a.name, PASSED)),
  });
  return { result, asked, ports };
}

/** Every visit, as `<step>:<ending>`, which is the shape of the walk. */
const walk = (result: PassResult): string[] =>
  result.steps.map((visit) => `${visit.step}:${visit.ending.ending}`);

const endRow = (plan: readonly ToAppend[]): PayloadOf<"EndActionsResolved"> =>
  plan[0]?.data as PayloadOf<"EndActionsResolved">;

// ------------------------------------------------------------------ claim ----

describe("claim picks the ticket, and cannot refuse", () => {
  it("takes the item, and every step after it is about that item", async () => {
    const { result, asked } = await pass();

    expect(walk(result)).toEqual([
      "claim:passed",
      "admit:passed",
      "prepared:passed",
      "design:passed",
      "implement:passed",
      "build:passed",
      "review:passed",
      "proposed:passed",
      "merge:passed",
      "end:passed",
    ]);
    expect(asked.take).toBe(1);
    expect(asked.cut[0]?.claimed).toEqual(ITEM);
    expect(asked.dispatch[0]?.ticket).toEqual(ITEM.ticket);
    // `end` resolves onto the stream `claim` named, and nowhere else.
    expect(asked.read).toEqual([ITEM.workItemId]);
  });

  /**
   * The two declines that leave nothing behind. Neither is a refusal — 0058 §2,
   * *there is no item to hold and no diff to fix* — so neither buys a fix round
   * and neither reaches the router: `claim` is not in `ARRIVE_AT_THE_ROUTER`.
   */
  it.each([
    { answer: { passedOver: "excluded-label" } as Taken, because: "passed-over" },
    { answer: { notClaimed: "held by local:41" } as Taken, because: "not-claimed" },
  ])("stops the pass when the item was not taken ($because)", async ({ answer, because }) => {
    const { result, asked } = await pass({ answers: { take: answer } });

    expect(walk(result)).toEqual(["claim:did-not-finish", "end:passed"]);
    expect(result.stoppedAt).toEqual({
      step: "claim",
      ending: { ending: "did-not-finish", because, at: null, detail: expect.any(String) },
    });
    expect(result.routes).toEqual([]);
    // Nothing was cut, nothing was dispatched, and `end` had no stream to
    // resolve onto — the whole of what *the pass is about no item* means.
    expect(asked.cut).toEqual([]);
    expect(asked.dispatch).toEqual([]);
    expect(asked.read).toEqual([]);
  });

  /**
   * The third decline, and the one with a stream behind it: the claim's append
   * may have committed. `end` resolves for the item even though no ticket was
   * ever handed back, because an item this run may be holding is one somebody has
   * to be told about.
   */
  it("names the item when the claim may have committed, and still resolves `end` for it", async () => {
    const { result, asked } = await pass({
      steps: { end: [HOLD_ON_BLOCKED] },
      answers: { take: { mayHold: { workItemId: "wi-lingtai-259", detail: "connection reset" } } },
    });

    expect(walk(result)).toEqual(["claim:did-not-finish", "end:passed"]);
    const ending = result.stoppedAt?.ending;
    expect(ending).toMatchObject({ ending: "did-not-finish", because: "claim-unconfirmed" });
    expect(ending && "detail" in ending ? ending.detail : "").toContain("wi-lingtai-259");
    expect(outcomeOf(result)).toBe("blocked");
    expect(asked.read).toEqual(["wi-lingtai-259"]);
    expect(endRow(asked.record[0]?.plan ?? [])).toEqual({
      outcome: "blocked",
      actions: [{ name: "hold it", labels: ["agent:hold"] }],
    });
  });

  /**
   * One closure, two passes. `claim` is where a pass begins, so the item, the
   * tree and the design are cleared there — a second pass that took nothing must
   * not resolve `end` onto the item the first one landed.
   */
  it("forgets the previous pass's item when the next claim takes nothing", async () => {
    let first = true;
    const { ports, asked } = portsAnswering({
      take: () => {
        const answer: Taken = first ? { taken: ITEM } : { passedOver: "no kind label" };
        first = false;
        return answer;
      },
    });
    const bodies = bodiesFor(ports);
    const run = () =>
      runPass({
        recipe: recipeWith({ end: [CLOSE_ON_LANDED] }),
        context,
        emit: () => {},
        bodies,
        actionsAt: (_step, actions) => actions.map((a) => canned(a.name, PASSED)),
      });

    await run();
    const second = await run();

    expect(walk(second)).toEqual(["claim:did-not-finish", "end:passed"]);
    expect(asked.read).toEqual([ITEM.workItemId]);
    expect(asked.record).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ admit ----

describe("admit cuts the tree, and that is where the head comes from", () => {
  it("advances `onSha` to the base it cut, so every later visit is judged there", async () => {
    const judged: { step: string; onSha: string }[] = [];
    const watching = (step: string): Action => ({
      name: step,
      kind: "run",
      run: async (ctx) => {
        judged.push({ step, onSha: ctx.onSha });
        return PASSED;
      },
    });
    const { result, asked } = await pass({
      steps: { prepared: [{ name: "install", run: "true" }] },
      actions: { prepared: [watching("prepared")] },
    });

    expect(result.steps[1]?.ending).toEqual({ ending: "passed", head: CUT_AT });
    // The pipeline at `prepared` and the agent at `implement` see the same head,
    // and it is the one the tree was cut at rather than the caller's base.
    expect(judged).toEqual([{ step: "prepared", onSha: CUT_AT }]);
    expect(asked.dispatch[0]?.context.onSha).toBe(CUT_AT);
  });

  it("stops the pass when the tree could not be cut, and buys nothing", async () => {
    const { result, asked } = await pass({ answers: { cut: { notCut: "no such base ref" } } });

    expect(walk(result)).toEqual(["claim:passed", "admit:did-not-finish", "end:passed"]);
    expect(result.stoppedAt?.ending).toMatchObject({
      ending: "did-not-finish",
      because: "worktree",
    });
    // Not `needs-input`, so it does not reach the router: there is no question in
    // a clone that did not finish (0057 §2).
    expect(result.routes).toEqual([]);
    expect(asked.draft).toEqual([]);
  });

  it("asks, and the question is what a person is left holding", async () => {
    const { result } = await pass({ answers: { cut: { asked: "which base — main or 1.0?" } } });

    expect(walk(result)).toEqual([
      "claim:passed",
      "admit:did-not-finish",
      "proposed:routed",
      "end:passed",
    ]);
    expect(result.stoppedAt).toEqual({
      step: "admit",
      ending: {
        ending: "did-not-finish",
        because: NEEDS_INPUT,
        at: null,
        detail: "which base — main or 1.0?",
      },
    });
    expect(result.rested).toBe("waiting");
  });

  it("is handed no reason to be run again on the way through", async () => {
    const { asked } = await pass();

    expect(asked.cut).toHaveLength(1);
    expect(asked.cut[0]?.again).toBeNull();
  });
});

// --------------------------------------------------------------- prepared ----

describe("prepared refuses, and the refusal reports like any other", () => {
  /**
   * The ticket's own *watch out*: a failed install is the cheapest refusal there
   * is. Every join it travels through is the skeleton's — `endingOf` reads a
   * `failed` verdict at a refusing step as a refusal, the loop takes it to
   * `proposed`, the router sends it to a person, and what the person is shown is
   * the install rather than the router.
   */
  it("carries a failed install to a person, naming the install and not the router", async () => {
    const { result } = await pass({
      steps: { prepared: [{ name: "install", run: "pnpm install --frozen-lockfile" }] },
      actions: { prepared: [canned("install", RED)] },
    });

    expect(walk(result)).toEqual([
      "claim:passed",
      "admit:passed",
      "prepared:refused",
      "proposed:routed",
      "end:passed",
    ]);
    expect(result.stoppedAt).toEqual({
      step: "prepared",
      ending: {
        ending: "refused",
        because: "action-refused",
        at: "install",
        detail: "pnpm install exited 1",
      },
    });
    expect(result.routes).toEqual([
      { from: "prepared", to: "waiting", why: expect.any(String) },
    ]);
    expect(result.rested).toBe("waiting");
    expect(outcomeOf(result)).toBe("blocked");
  });

  /**
   * 0061 §3's worked example, from the other side: a failed install refuses
   * before any agent has run, so there is no diff and no error in one to fix.
   * `implement` is therefore not among the destinations the judge is offered —
   * even with a round to spend.
   */
  it("offers the judge a person and a restart, and never `implement`", async () => {
    const { result } = await pass({
      steps: { prepared: [{ name: "install", run: "false" }] },
      actions: { prepared: [canned("install", RED)] },
      ceilings: { rounds: 3, restartsLeft: 1 },
    });

    const router = result.steps.find((visit) => visit.step === "proposed");
    expect(router?.ending.ending).toBe("routed");
    // What the router was offered is what `NOT_BUILT_YET`'s body quotes back.
    const why = router?.ending.ending === "routed" ? router.ending.why : "";
    expect(why).toContain("prepared");
    expect(why).not.toContain("implement");
  });

  it("passes on a green install, and adds nothing of its own", async () => {
    const { result } = await pass({
      steps: { prepared: [{ name: "install", run: "true" }] },
    });

    expect(result.steps[2]?.ending).toEqual({ ending: "passed" });
    // The body added no head, no reason and no findings — the visit is its
    // plugins' and nothing else.
    expect(result.steps[2]?.results.map((r) => r.verdict)).toEqual(["passed"]);
  });
});

// ----------------------------------------------------------------- design ----

describe("design produces a document, or nothing, and nothing is an answer", () => {
  /**
   * The ticket's other *watch out*. An empty document is a **pass** — not a skip
   * and not a failure — the step appears in the walk, and `implement` is briefed
   * with `""` and works from the issue's own text. There is no conditional step.
   */
  it("passes on an empty document, and `implement` is briefed from the issue", async () => {
    const { result, asked } = await pass({ answers: { draft: { document: "" } } });

    expect(result.steps[3]).toEqual({ step: "design", ending: { ending: "passed" }, results: [] });
    expect(asked.dispatch[0]?.design).toBe("");
    expect(asked.dispatch[0]?.ticket.body).toBe(ITEM.ticket.body);
    expect(result.stoppedAt).toBeNull();
    expect(outcomeOf(result)).toBe("landed");
  });

  it("hands a document it did write to the agent at `implement`", async () => {
    const { asked } = await pass({ answers: { draft: { document: "## The shape\n\nSix bodies." } } });

    expect(asked.dispatch[0]?.design).toBe("## The shape\n\nSix bodies.");
  });

  it("asks, and the question is the one `did-not-finish` with somewhere to go", async () => {
    const { result } = await pass({ answers: { draft: { asked: "is a design wanted here?" } } });

    expect(walk(result)).toEqual([
      "claim:passed",
      "admit:passed",
      "prepared:passed",
      "design:did-not-finish",
      "proposed:routed",
      "end:passed",
    ]);
    expect(result.stoppedAt?.ending).toMatchObject({ because: NEEDS_INPUT });
  });

  /**
   * 0061 §3 puts `agent:` at `design` as well as at `implement`, so a design
   * agent meets the account's wall identically — and the answer has to be the
   * same one: `never-ran`, which releases the item rather than holding it for a
   * person. It does not reach the router, because paying an agent to ask what to
   * do about a quota is the one route that cannot work.
   */
  it("stands the conductor down when its agent never started", async () => {
    const { result } = await pass({
      answers: { draft: { neverStarted: { agent: "claude-code", detail: "session limit" } } },
    });

    expect(walk(result)).toEqual([
      "claim:passed",
      "admit:passed",
      "prepared:passed",
      "design:never-ran",
      "end:passed",
    ]);
    expect(result.stoppedAt?.ending).toEqual({
      ending: "never-ran",
      at: "claude-code",
      detail: "session limit",
    });
    expect(result.routes).toEqual([]);
    expect(outcomeOf(result)).toBe("failed");
  });

  it("stops the pass when its agent left no receipt", async () => {
    const { result } = await pass({ answers: { draft: { stopped: "the runtime exited 1" } } });

    expect(result.stoppedAt?.ending).toEqual({
      ending: "did-not-finish",
      because: "did-not-finish",
      at: null,
      detail: "the runtime exited 1",
    });
    // Not `needs-input`, so there is nothing for a judge to route.
    expect(result.routes).toEqual([]);
    expect(outcomeOf(result)).toBe("blocked");
  });
});

// -------------------------------------------------------------- implement ----

describe("implement dispatches the one agent, and reports what it committed", () => {
  /**
   * Declared at `proposed` rather than at `build`, because `KINDS_AT.build` is
   * still `[]` and the recipe schema refuses an action at a step no code reaches
   * — which is the same `#61` rule this pass is arranged around, one layer out.
   * The point is the head either way: whatever runs after `implement` is judged
   * against what `implement` committed.
   */
  it("moves the head to the commit, and what runs after it is judged there", async () => {
    const judged: string[] = [];
    const { result } = await pass({
      steps: { proposed: [{ name: "test", run: "pnpm test" }] },
      actions: {
        proposed: [
          {
            name: "test",
            kind: "run",
            run: async (ctx) => {
              judged.push(ctx.onSha);
              return PASSED;
            },
          },
        ],
      },
    });

    expect(result.steps[4]?.ending).toEqual({ ending: "passed", head: COMMITTED });
    expect(judged).toEqual([COMMITTED]);
  });

  it.each([
    {
      what: "asked",
      answer: { asked: "the ticket names two files and neither exists" } as Worked,
      ending: { ending: "did-not-finish", because: NEEDS_INPUT },
      routed: true,
    },
    {
      what: "left no receipt",
      answer: { stopped: "the turn budget was spent" } as Worked,
      ending: { ending: "did-not-finish", because: "did-not-finish" },
      routed: false,
    },
    {
      what: "never started",
      answer: { neverStarted: { agent: "claude-code", detail: "signed out" } } as Worked,
      ending: { ending: "never-ran" },
      routed: false,
    },
  ])("reports an agent that $what", async ({ answer, ending, routed }) => {
    const { result } = await pass({ answers: { dispatch: answer } });

    expect(result.stoppedAt?.step).toBe("implement");
    expect(result.stoppedAt?.ending).toMatchObject(ending);
    expect(result.routes.length).toBe(routed ? 1 : 0);
    // `end` runs on all three, which is the whole of 0058 §3.
    expect(result.steps.at(-1)?.step).toBe("end");
  });

  it("is handed the round it is in and the findings it was bought on", async () => {
    const { asked } = await pass();

    expect(asked.dispatch[0]?.context.round).toBe(0);
    expect(asked.dispatch[0]?.context.recheck).toEqual([]);
    expect(asked.dispatch[0]?.again).toBeNull();
  });

  /**
   * The other half of a question, and the reason `SentBack` exists: the judge may
   * answer a `needs-input` with *that step again, stating your assumption*, which
   * spends a round and buys another agent run. So the second brief must differ
   * from the first, and the only thing that can make it differ is what the judge
   * said — a byte-identical brief buys the same question back and burns every
   * round arriving at the answer the first one did.
   *
   * The judge is a body here, because `NOT_BUILT_YET`'s router sends every
   * arrival to a person while no `judge:` is built (T4b).
   */
  it("is told why it is being run again, and what it asked the first time", async () => {
    let asks = true;
    const { ports, asked } = portsAnswering({
      dispatch: () => {
        const answer: Worked = asks ? { asked: "which of the two files?" } : { committed: COMMITTED };
        asks = false;
        return answer;
      },
    });
    const result = await runPass({
      recipe: recipeWith(),
      context,
      emit: () => {},
      bodies: {
        ...bodiesFor(ports),
        proposed: async ({ arriving }) =>
          arriving === null
            ? { ending: "passed" }
            : { ending: "routed", to: "implement", why: "state your assumption and carry on" },
      },
      ceilings: { rounds: 1, restartsLeft: 0 },
      actionsAt: (_step, actions) => actions.map((a) => canned(a.name, PASSED)),
    });

    expect(walk(result)).toEqual([
      "claim:passed",
      "admit:passed",
      "prepared:passed",
      "design:passed",
      "implement:did-not-finish",
      "proposed:routed",
      "implement:passed",
      "build:passed",
      "review:passed",
      "proposed:passed",
      "merge:passed",
      "end:passed",
    ]);
    expect(asked.dispatch[1]?.again).toEqual({
      why: "state your assumption and carry on",
      asked: "which of the two files?",
    });
    expect(asked.dispatch[1]?.context.round).toBe(1);
    expect(outcomeOf(result)).toBe("landed");
  });
});

// -------------------------------------------------------------------- end ----

describe("end runs on every ending and cannot refuse", () => {
  /**
   * The three outcomes a pass can produce, and `end` resolving the declared list
   * against each. `closed` is the fourth and no pass produces it: it is a person
   * deciding the ticket is over, and `close.ts` resolves `end` for it.
   */
  it.each([
    { outcome: "landed", answers: {} as Answers, actions: [{ name: "close the ticket", close: true }] },
    {
      outcome: "blocked",
      answers: { dispatch: { asked: "which base?" } } as Answers,
      actions: [{ name: "hold it", labels: ["agent:hold"] }],
    },
    {
      outcome: "failed",
      answers: {
        dispatch: { neverStarted: { agent: "claude-code", detail: "quota" } },
      } as Answers,
      actions: [],
    },
  ])("resolves the cells `when: $outcome` matches", async ({ outcome, answers, actions }) => {
    const { result, asked } = await pass({
      steps: { end: [CLOSE_ON_LANDED, HOLD_ON_BLOCKED] },
      answers,
    });

    expect(outcomeOf(result)).toBe(outcome);
    expect(result.steps.at(-1)).toEqual({ step: "end", ending: { ending: "passed" }, results: [] });
    expect(endRow(asked.record[0]?.plan ?? [])).toEqual({ outcome, actions });
  });

  it("records the resolution at the version the read gave", async () => {
    const stream = [
      {
        seq: 1n,
        streamId: ITEM.workItemId,
        version: 1,
        type: "WorkItemClaimed",
        schemaVer: 1,
        data: {},
        actor: "conductor",
        causation: null,
        at: new Date(),
      } satisfies Envelope,
    ];
    const { asked } = await pass({ steps: { end: [CLOSE_ON_LANDED] }, answers: { stream } });

    expect(asked.record[0]?.at).toBe(1);
    expect(asked.record[0]?.workItemId).toBe(ITEM.workItemId);
  });

  it("appends nothing when the recipe declares nothing at the step", async () => {
    const { result, asked } = await pass();

    expect(result.steps.at(-1)?.ending).toEqual({ ending: "passed" });
    expect(asked.read).toEqual([ITEM.workItemId]);
    expect(asked.record).toEqual([]);
  });

  /**
   * The point resolves once per outcome, and the item's own stream is where that
   * is checked — `resolveEndActions`, called rather than reimplemented. An item
   * that was blocked, came back and then landed resolves twice for two different
   * outcomes; this one has already landed.
   */
  it("appends nothing a second time for an outcome the stream already carries", async () => {
    const already: Envelope = {
      seq: 2n,
      streamId: ITEM.workItemId,
      version: 2,
      type: "EndActionsResolved",
      schemaVer: 1,
      data: { outcome: "landed", actions: [] },
      actor: "conductor",
      causation: null,
      at: new Date(),
    };
    const { asked } = await pass({ steps: { end: [CLOSE_ON_LANDED] }, answers: { stream: [already] } });

    expect(asked.record).toEqual([]);
  });

  /**
   * **The effects never decide whether the ending happened.** The nine steps
   * before `end` passed, so the outcome is `landed` and stays `landed`: `end` is
   * never what stopped a pass, so a resolution that could not be recorded is
   * reported on `end`'s own entry in `steps` and nowhere else.
   */
  it.each([
    { act: "read", answers: { readThrows: new Error("connection reset") } as Answers },
    {
      act: "record",
      answers: { recordThrows: new Error("version 1 is taken") } as Answers,
    },
  ])("reports a $act that threw without changing the outcome", async ({ act, answers }) => {
    const { result } = await pass({ steps: { end: [CLOSE_ON_LANDED] }, answers });

    const ending = result.steps.at(-1)?.ending;
    expect(ending).toMatchObject({ ending: "did-not-finish", because: END_UNRESOLVED, at: null });
    expect(ending && "detail" in ending ? ending.detail : "").toContain(`\`${act}\` threw`);
    // The landing stands, and the pass reports it as one.
    expect(result.stoppedAt).toBeNull();
    expect(outcomeOf(result)).toBe("landed");
  });

  /**
   * `EndActionsResolved` lives on the work item's stream, and a pass that took no
   * item has none. So the step passes, and it does so without asking the port for
   * a stream nobody can name.
   */
  it("resolves nothing when the pass is about no item", async () => {
    const { result, asked } = await pass({
      steps: { end: [CLOSE_ON_LANDED, HOLD_ON_BLOCKED] },
      answers: { take: { notClaimed: "lost-race" } },
    });

    expect(result.steps.at(-1)).toEqual({ step: "end", ending: { ending: "passed" }, results: [] });
    expect(asked.read).toEqual([]);
    expect(asked.record).toEqual([]);
  });
});
