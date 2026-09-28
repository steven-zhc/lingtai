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
import type { QueueActionDeps } from "@lingtai/actions";
import {
  createMergeAction,
  createQueueAction,
  createWorktreeAction,
  type Action,
  type ActionContext,
  type ActionFinding,
  type ActionResult,
  type CutAnswer,
  type LandAnswer,
  type MergeStrategy,
  type TakeAnswer,
} from "@lingtai/actions";
import type { Envelope, PayloadOf, ToAppend } from "@lingtai/domain";
import type { Worktree } from "@lingtai/repo";
import { StepMap, type QueueSettings, type StepAction } from "@lingtai/recipe";
import { describe, expect, it } from "vitest";
import {
  NEEDS_INPUT,
  outcomeOf,
  runPass,
  type Destination,
  type PassOptions,
  type PassResult,
} from "../src/pass.ts";
import { BUILT_IN, BUILT_IN_FOR, judgeDeclaredAt } from "../src/judge.ts";
import {
  END_UNRESOLVED,
  bodiesFor,
  type Brief,
  type Claimed,
  type Drafted,
  type Judged,
  type Judging,
  type PassPorts,
  type SentBack,
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

/**
 * The four values a `queue:` action carries, as `conduct.ts`'s `defaultsAt`
 * builds them off `queueOf(recipe)` where a recipe declares nothing (`#269`).
 *
 * All four, because a block is all four: the schema requires them, and `queueOf`
 * writes `take: both` where the machine file names nobody.
 */
const QUEUE: QueueSettings = {
  kinds: ["bug", "feature"],
  exclude: ["agent:hold"],
  backoff: "1h",
  assignee: { take: "both" },
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

const MERGED = "3333333333333333333333333333333333333333";

const PASSED: ActionResult = { verdict: "passed", evidence: "green", findings: [] };
const RED: ActionResult = { verdict: "failed", evidence: "pnpm install exited 1", findings: [] };

/**
 * A finding with a `failureScenario`, which is the whole of what makes it worth an
 * agent: *something the fixer could not have authored* (0038 §2).
 */
const BLOCKER: ActionFinding = {
  file: "packages/conductor/src/pass.ts",
  line: 1201,
  claim: "the router is asked before the build",
  failureScenario: "a red build pays for a review of a diff that does not compile",
  severity: "blocker",
};

/** What a reviewer that says the diff stops here looks like — findings, and `failed`. */
const REVIEW_REFUSED: ActionResult = {
  verdict: "failed",
  evidence: "blocker packages/conductor/src/pass.ts:1201 — the router is asked before the build",
  findings: [BLOCKER],
};

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
  /**
   * What each `queue:` action was asked to select over — the four values, which
   * is the whole of what the take is handed since `#269`.
   *
   * Beside the ports rather than on them, for `cut`'s reason: `claim`'s work is a
   * plugin's now, so what a test reads back is the action's argument and not a
   * port call.
   */
  take: QueueSettings[];
  /**
   * What each `worktree:` action was asked to cut — its `base` and `submodules`,
   * which is the whole of what the cut is handed since `#268`.
   *
   * Beside the ports rather than on them: `admit`'s work is a plugin's now, so
   * what a test reads back is the action's argument and not a port call.
   */
  cut: { base: string; submodules: boolean }[];
  draft: Brief[];
  dispatch: Brief[];
  /** Every brief a judge was handed, which is what *spends an agent* looks like. */
  judge: Judging[];
  /**
   * What each `merge:` action was asked to land — its `strategy` and the `onSha`
   * it was reached on, which is the whole of what the lane is handed since
   * `#270`.
   *
   * Beside the ports rather than on them, for `cut`'s reason: `merge`'s work is a
   * plugin's now, so what a test reads back is the action's argument and not a
   * port call.
   */
  land: { strategy: MergeStrategy; onSha: string }[];
  read: string[];
  record: { workItemId: string; at: number; plan: readonly ToAppend[] }[];
}

interface Answers {
  /** What the take answers. `ITEM`, taken, by default. */
  take?: TakeAnswer | (() => TakeAnswer);
  /** What the cut answers. Cut at `CUT_AT`, by default. */
  cut?: CutAnswer;
  draft?: Drafted | (() => Drafted);
  dispatch?: Worked | ((brief: Brief) => Worked);
  /** Nothing declared, by default: the built-ins and the person are what answer. */
  judge?: Judged | ((on: Judging) => Judged);
  /** What the lane answers. Merged at `MERGED`, by default. */
  land?: LandAnswer | (() => LandAnswer);
  /** The stream `end` reads. Empty is an item with nothing resolved on it. */
  stream?: readonly Envelope[];
  /** Thrown by `readEnd`, so `end`'s own failure can be reached. */
  readThrows?: Error;
  recordThrows?: Error;
}

function portsAnswering(
  answers: Answers = {},
): { ports: PassPorts; asked: Asks; taking: QueueActionDeps } {
  const asked: Asks = {
    take: [],
    cut: [],
    draft: [],
    dispatch: [],
    judge: [],
    land: [],
    read: [],
    record: [],
  };
  const of = <T, A>(given: T | ((arg: A) => T) | undefined, fallback: T, arg: A): T =>
    given === undefined ? fallback : typeof given === "function" ? (given as (a: A) => T)(arg) : given;

  /**
   * **What `take` leaves behind, held where `conduct.ts` holds it** (`#269`).
   *
   * The take is an action's, so the item and its stream are the *caller's* fact
   * and the ports only read them — which is why the reset that begins a pass is
   * in the take below rather than in `claim`'s body: the action runs before the
   * body, and a reset written there would wipe what it had just taken.
   */
  let took: Claimed | null = null;
  let onStream: string | null = null;

  /**
   * The take, as the `queue:` action runs it — **and the reset is the first thing
   * in it**, for the reason `conduct.ts` puts it there: the three ways it can
   * decline set no item, and it was exactly those that would let `end` resolve
   * onto the item the pass before had landed.
   */
  const taking: QueueActionDeps = {
    take: async (spec) => {
      asked.take.push(spec);
      took = null;
      onStream = null;
      const answer = of<TakeAnswer, undefined>(
        answers.take,
        { taken: { workItemId: ITEM.workItemId, kind: ITEM.kind } },
        undefined,
      );
      if ("taken" in answer) {
        took = { ...ITEM, workItemId: answer.taken.workItemId, kind: answer.taken.kind };
        onStream = answer.taken.workItemId;
      } else if ("mayHold" in answer) {
        // The one decline that leaves a stream behind: `end` still resolves
        // against it, because an item this run may be holding is one somebody has
        // to be told about.
        onStream = answer.mayHold.workItemId;
      }
      return answer;
    },
  };

  const ports: PassPorts = {
    item: () => took,
    onStream: () => onStream,
    draft: async (brief) => {
      asked.draft.push(brief);
      return of(answers.draft, { document: "" }, brief);
    },
    dispatch: async (brief) => {
      asked.dispatch.push(brief);
      return of(answers.dispatch, { committed: COMMITTED }, brief);
    },
    judge: async (on) => {
      asked.judge.push(on);
      return of(answers.judge, { noJudge: true }, on);
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
  return { ports, asked, taking };
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
  const { ports, asked, taking } = portsAnswering(options.answers);
  /**
   * **`claim`'s, `admit`'s and `merge`'s defaults, as `conduct.ts`'s `defaultsAt`
   * supplies them** (0065 §3).
   *
   * All three bodies are empty — `admit`'s since `#268`, `merge`'s since `#270`
   * and `claim`'s since `#269` — so a pass whose recipe declares nothing there
   * takes nothing, cuts nothing and lands nothing unless the caller substitutes,
   * and *the caller substitutes* is the decision rather than a detail of the
   * conductor. Mirrored here rather than imported, because importing `conduct.ts`
   * would bring a GitHub client and a store into a file whose whole claim is that
   * nothing leaves the system.
   */
  const claiming = (): Action => createQueueAction({ name: "take the ticket", ...QUEUE }, taking);
  const cutting = (): Action =>
    createWorktreeAction(
      { name: "cut the branch", base: "main", submodules: false },
      {
        cut: async (spec) => {
          asked.cut.push(spec);
          return options.answers?.cut ?? { head: CUT_AT, where: TREE.path };
        },
      },
    );
  const landing = (): Action =>
    createMergeAction(
      { name: "land the branch", strategy: "merge-commit" },
      {
        land: async (spec) => {
          asked.land.push(spec);
          const answer = options.answers?.land;
          if (answer === undefined) return { merged: MERGED };
          return typeof answer === "function" ? answer() : answer;
        },
      },
    );
  const result = await runPass({
    recipe: recipeWith(options.steps),
    context,
    emit: () => {},
    bodies: bodiesFor(ports),
    ceilings: options.ceilings,
    actionsAt: (step, actions) => {
      if (options.actions?.[step] !== undefined) return options.actions[step];
      if (actions.length > 0) return actions.map((a) => canned(a.name, PASSED));
      if (step === "claim") return [claiming()];
      if (step === "admit") return [cutting()];
      return step === "merge" ? [landing()] : [];
    },
  });
  return { result, asked, ports };
}

/** Every visit, as `<step>:<ending>`, which is the shape of the walk. */
const walk = (result: PassResult): string[] =>
  result.steps.map((visit) => `${visit.step}:${visit.ending.ending}`);

const endRow = (plan: readonly ToAppend[]): PayloadOf<"EndActionsResolved"> =>
  plan[0]?.data as PayloadOf<"EndActionsResolved">;

// ------------------------------------------------------------------ claim ----

describe("claim runs the `queue:` plugin, and cannot refuse", () => {
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
    expect(asked.take).toEqual([QUEUE]);
    expect(asked.cut).toEqual([{ base: "main", submodules: false }]);
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
    { answer: { passedOver: "excluded-label" } as TakeAnswer, because: "passed-over" },
    { answer: { notClaimed: "held by local:41" } as TakeAnswer, because: "not-claimed" },
  ])("stops the pass when the item was not taken ($because)", async ({ answer, because }) => {
    const { result, asked } = await pass({ answers: { take: answer } });

    expect(walk(result)).toEqual(["claim:did-not-finish", "end:passed"]);
    // The action's own `because`, travelling — `endingOf` reads it off the result
    // and `at` is the action that said it, where the body used to answer `null`.
    expect(result.stoppedAt).toEqual({
      step: "claim",
      ending: {
        ending: "did-not-finish",
        because,
        at: "take the ticket",
        detail: expect.any(String),
      },
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
   * One closure, two passes. `claim` is where a pass begins, so the item and its
   * stream are cleared by the take that makes them — a second pass that took
   * nothing must not resolve `end` onto the item the first one landed.
   *
   * **The reset is in the take and not in the body, since `#269`**, because the
   * action runs before the body: a `claim: async () => { took = null; … }` would
   * clear what the action had just taken, which is the one way this migration
   * could have been silently wrong.
   */
  it("forgets the previous pass's item when the next claim takes nothing", async () => {
    let first = true;
    const { ports, asked, taking } = portsAnswering({
      take: () => {
        const answer: TakeAnswer = first
          ? { taken: { workItemId: ITEM.workItemId, kind: ITEM.kind } }
          : { passedOver: "no kind label" };
        first = false;
        return answer;
      },
    });
    const bodies = bodiesFor(ports);
    const claiming = createQueueAction({ name: "take the ticket", ...QUEUE }, taking);
    const run = () =>
      runPass({
        recipe: recipeWith({ end: [CLOSE_ON_LANDED] }),
        context,
        emit: () => {},
        bodies,
        actionsAt: (step, actions) =>
          step === "claim" ? [claiming] : actions.map((a) => canned(a.name, PASSED)),
      });

    await run();
    const second = await run();

    expect(walk(second)).toEqual(["claim:did-not-finish", "end:passed"]);
    expect(asked.read).toEqual([ITEM.workItemId]);
    expect(asked.record).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ admit ----

describe("admit runs the `worktree:` plugin, and that is where the head comes from", () => {
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

  /**
   * **A declared `worktree:` is what runs, and `admit` runs nothing else**
   * (`#268`).
   *
   * This is the half of `#268`'s first major finding that had to be closed: a
   * `worktree:` at `admit` used to resolve, be recorded in `StepsResolved` as
   * planned, and produce no verdict — so the item landed with a point the log
   * said was configured and never ran, which is the mark reserved for Lingtai's
   * own bug (0016 §4, and 0065 §5). It cannot arise now because the step runs
   * what is declared there: the action produces `StepStarted` and a verdict like
   * any other, and the `head` on the ending is the proof it did the work rather
   * than merely being listed.
   */
  it("cuts from what the recipe declares, and the head is the action's", async () => {
    const asked: { base: string; submodules: boolean }[] = [];
    const declared = createWorktreeAction(
      { name: "cut the branch", base: "1.0", submodules: true },
      {
        cut: async (spec) => {
          asked.push(spec);
          return { head: CUT_AT, where: TREE.path };
        },
      },
    );
    const { result } = await pass({
      steps: { admit: [{ name: "cut the branch", worktree: { base: "1.0", submodules: true } }] },
      actions: { admit: [declared] },
    });

    expect(asked).toEqual([{ base: "1.0", submodules: true }]);
    expect(result.steps[1]).toMatchObject({
      step: "admit",
      ending: { ending: "passed", head: CUT_AT },
      results: [{ action: "cut the branch", verdict: "passed" }],
    });
  });

  it("stops the pass when the tree could not be cut, and buys nothing", async () => {
    const { result, asked } = await pass({ answers: { cut: { notCut: "no such base ref" } } });

    expect(walk(result)).toEqual(["claim:passed", "admit:did-not-finish", "end:passed"]);
    // The action's name rather than `null`, which is the one thing that changed
    // when the work left the body: `endingOf` names what did not finish.
    expect(result.stoppedAt?.ending).toMatchObject({
      ending: "did-not-finish",
      because: "did-not-finish",
      at: "cut the branch",
      detail: expect.stringContaining("no such base ref"),
    });
    // Not `needs-input`, so it does not reach the router: there is no question in
    // a clone that did not finish (0057 §2). And no head, so `onSha` is still the
    // base the caller handed in — nothing was cut.
    expect(result.routes).toEqual([]);
    expect(result.stoppedAt?.ending).not.toHaveProperty("head");
    expect(asked.draft).toEqual([]);
  });

  /**
   * **A question from the plugin holds the item, where the body's reached the
   * judge** (`#268`).
   *
   * `CutAnswer.asked` is the same affordance `Asked` was — 0058 §3b's edge out of
   * `admit` for a step that stopped and asked — and a plugin asks with the one
   * verdict the pipeline has for it: `needs-approval`, which `endingOf` reads as
   * `held`. So it rests here rather than at `waiting`, and `held` is on the
   * endings that do not arrive at the router *because the recipe already asked a
   * person*. Nothing produces it at `admit` today, which is why this is the test
   * that says what would happen.
   */
  it("holds the item when the cut asks a question", async () => {
    const { result } = await pass({ answers: { cut: { asked: "which base — main or 1.0?" } } });

    expect(walk(result)).toEqual(["claim:passed", "admit:held", "end:passed"]);
    expect(result.stoppedAt).toEqual({
      step: "admit",
      ending: { ending: "held", at: "cut the branch", question: "which base — main or 1.0?" },
    });
    expect(result.routes).toEqual([]);
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
      // **What was wanted and what happened, and no ceiling between them**
      // (`#271`). The built-in wants the work fixed where it stands; `prepared`
      // offers no step at all, so a person got it — and `ceiling` is null
      // because no number a project could raise would have offered `implement`
      // here. That is the reading `chose` alone would get wrong.
      {
        from: "prepared",
        chose: "implement",
        to: "waiting",
        why: expect.any(String),
        ceiling: null,
      },
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
   * Declared at `proposed` rather than at `build`, and since 2026-09-27 either
   * would resolve — `runPlugin` serves both. The point is the head either way:
   * whatever runs after `implement` is judged against what `implement`
   * committed, and which step declares it is the caller's seam and not this
   * claim.
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
    const { ports, asked, taking } = portsAnswering({
      dispatch: () => {
        const answer: Worked = asks ? { asked: "which of the two files?" } : { committed: COMMITTED };
        asks = false;
        return answer;
      },
    });
    const claiming = createQueueAction({ name: "take the ticket", ...QUEUE }, taking);
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
      // `claim`'s default, because the body takes nothing since `#269` and a pass
      // that claimed no item cannot brief an agent.
      actionsAt: (step, actions) =>
        step === "claim" ? [claiming] : actions.map((a) => canned(a.name, PASSED)),
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
      // The question is the whole of what this round was bought on, and `asked`
      // is where it is: `printed` would be the same words twice.
      printed: null,
    });
    expect(asked.dispatch[1]?.context.round).toBe(1);
    expect(outcomeOf(result)).toBe("landed");
  });
});

// ------------------------------------------------------------------ build ----

describe("build is its own step, and a red one skips review", () => {
  /**
   * The behaviour change with the cheapest argument behind it. `build` goes first
   * **not because it is quick** — median 313s against review's 149s — but because
   * it spends no tokens where a review spends an agent: the refusal reaches
   * `proposed` and `review` is never visited at all.
   */
  it("refuses, and `review` is never reached", async () => {
    const { result, asked } = await pass({ actions: { build: [canned("typecheck", RED)] } });

    expect(walk(result)).toEqual([
      "claim:passed",
      "admit:passed",
      "prepared:passed",
      "design:passed",
      "implement:passed",
      "build:refused",
      "proposed:routed",
      "end:passed",
    ]);
    expect(result.steps.some((visit) => visit.step === "review")).toBe(false);
    // And the lane was never asked to merge a diff that does not compile.
    expect(asked.land).toEqual([]);
  });

  /** Its work is its plugins', which is `prepared`'s argument at the next step along. */
  it("passes on a green build, and adds nothing of its own", async () => {
    const { result } = await pass({ actions: { build: [canned("typecheck", PASSED)] } });

    const built = result.steps.find((visit) => visit.step === "build");
    expect(built?.ending).toEqual({ ending: "passed" });
    expect(built?.results.map((r) => r.verdict)).toEqual(["passed"]);
  });
});

// ----------------------------------------------------------------- review ----

describe("review returns findings and judges nothing", () => {
  /**
   * 0058 §3 — *a reviewer returns findings with a severity and no verdict* — and
   * the measurement behind it: **10% of `review`'s refusals in fourteen days
   * carried no findings at all**, 24 of them
   * ([012](../../../doc/experiments/012-where-the-turns-go.md) §4). The step
   * passes carrying what the reviewer said, and the judgement is made where
   * there is a round to buy with it.
   */
  it("passes carrying the findings, and the judge is asked about them", async () => {
    const { result, asked } = await pass({
      actions: { review: [canned("cold reviewer", REVIEW_REFUSED)] },
      ceilings: { rounds: 1, restartsLeft: 0 },
    });

    const reviewed = result.steps.find((visit) => visit.step === "review");
    expect(reviewed?.ending).toEqual({ ending: "passed" });
    // Nothing is dropped: the reviewer's own verdict is on the visit, and it is
    // what says there is a `findings` direction to judge at all.
    expect(reviewed?.results.map((r) => r.verdict)).toEqual(["failed"]);
    expect(asked.judge).toEqual([
      {
        when: "findings",
        offering: ["waiting", "implement"],
        findings: [BLOCKER],
        evidence: REVIEW_REFUSED.evidence,
      },
    ]);
  });

  /** A reviewer that refused nothing lets the change through, and `merge` runs. */
  it("lets the change through when the reviewer refused nothing", async () => {
    const minor: ActionFinding = { ...BLOCKER, severity: "minor" };
    const { result, asked } = await pass({
      actions: {
        review: [canned("cold reviewer", { verdict: "passed", evidence: "read it", findings: [minor] })],
      },
    });

    expect(walk(result).slice(-4)).toEqual([
      "review:passed",
      "proposed:passed",
      "merge:passed",
      "end:passed",
    ]);
    // A finding at or below the bar is the `backlog:` plugin's business and never
    // a reason to hold a change back, so no judge was asked and nothing was paid.
    expect(asked.judge).toEqual([]);
    expect(asked.land).toHaveLength(1);
    expect(outcomeOf(result)).toBe("landed");
  });
});

// --------------------------------------------------------------- proposed ----

describe("proposed is the only step that routes, and one judge answers each when", () => {
  /** A `build` and a `review` declared together, since most of these need both. */
  const checked = (build: ActionResult, review: ActionResult) => ({
    actions: { build: [canned("typecheck", build)], review: [canned("cold reviewer", review)] },
  });

  /**
   * **`conduct.ts`'s own `ports.judge`, line for line** (`#274`, `#277`).
   *
   * The live port looks the entry up, hands a built-in back as a *name* the body
   * applies, and dispatches a runtime — so the cases below that hand this to
   * `answers.judge` are about the recipe rather than about a fake: what is
   * declared at `proposed:` is what the pass gets. A `Judged` written out by hand
   * would assert the body and say nothing about the lines that make a declared
   * judge reachable.
   *
   * `agent` stands in for `askTheAgent`, which is the one thing a unit test may
   * not have: dispatching one spawns a process. What is mirrored is everything
   * around it — the lookup, the branch, and that a runtime's answer arrives as a
   * `next` the body then holds to the offer.
   */
  const theRecipesJudge =
    (steps: Record<string, unknown>, agent: (named: string, on: Judging) => Judged = notAsked) =>
    (on: Judging): Judged => {
      const declared = judgeDeclaredAt(recipeWith(steps).steps.proposed, on.when);
      if (declared === null) return { noJudge: true };
      return "built" in declared ? declared : agent(declared.named, on);
    };

  /** No dispatch was arranged, which is a person — as it is when one fails live. */
  const notAsked = (named: string): Judged => ({
    next: "waiting",
    named,
    why: `the "${named}" judge was not asked`,
  });

  /** A `judge:` entry, as a recipe writes one. */
  const declaring = (when: string, name: string, judge = "same-worktree") => ({
    proposed: [{ name, judge, when }],
  });

  /**
   * The mechanical direction, and the whole of what keeps `proposed` from buying
   * a model to answer a question a `switch` answers: `red` and `verify-failed` were
   * seen sixty times between them in fourteen days and not one was a judgement.
   * Nothing was declared, so the built-in answered — and no judge was paid.
   */
  it("sends a red build back to `implement` without paying for a judgement", async () => {
    let red = true;
    const { result, asked } = await pass({
      actions: {
        build: [
          {
            name: "typecheck",
            kind: "run",
            run: async () => {
              const answer = red ? RED : PASSED;
              red = false;
              return answer;
            },
          },
        ],
      },
      ceilings: { rounds: 1, restartsLeft: 0 },
    });

    expect(walk(result).slice(5)).toEqual([
      "build:refused",
      "proposed:routed",
      "implement:passed",
      "build:passed",
      "review:passed",
      "proposed:passed",
      "merge:passed",
      "end:passed",
    ]);
    expect(result.routes).toEqual([
      // It got what it wanted and no ceiling was reached, which is what `chose`
      // and `to` agreeing says (`#271`).
      {
        from: "build",
        chose: "implement",
        to: "implement",
        why: expect.stringContaining("same-worktree"),
        ceiling: null,
      },
    ]);
    expect(asked.judge.map((on) => on.when)).toEqual(["red"]);
    // **And the agent that was sent back was shown the three errors.** A `run:`
    // action raises no findings, so `context.recheck` is empty on this edge and
    // `asked` is null — the visit before the router was `build` and not
    // `implement` — which leaves `printed` as the only thing on the brief that
    // says what to fix. Without it the round is ~31 turns and ~$3.40 spent on an
    // agent told nothing but that something failed.
    expect(asked.dispatch[1]?.again).toEqual({
      why: expect.stringContaining("same-worktree"),
      asked: null,
      printed: { step: "build", detail: RED.evidence },
    });
    expect(asked.dispatch[1]?.context.recheck).toEqual([]);
    expect(outcomeOf(result)).toBe("landed");
  });

  /**
   * **A red build at `build:` reaches the router and buys the round the recipe's
   * own judge asked for** (`#274`) — the thing `#267` and `#263` each spent a
   * ticket proving was broken, at $14.19 between them with nothing landed.
   *
   * Two halves, and both had to be true. The refusal has to *travel*: `build` is
   * in `ARRIVE_AT_THE_ROUTER` and `proposed` is not, so the same commands
   * declared at `proposed:` — where this repository's recipe had them until
   * `a417908` — set `stoppedAt` and broke the loop before any judge was asked.
   * And there has to be a judge to ask, which is the cell this ticket opened:
   * the route below is `judgeDeclaredAt`'s answer over a real `proposed:` list,
   * through the one line `conduct.ts` holds.
   *
   * The destination is the same one the default gives for a `red`, and that is
   * the point rather than a weakness: the first version of these entries a person
   * can *edit* changes no behaviour. What it changes is whose sentence is on the
   * card — the recipe's line, by name.
   */
  it("buys a round for a red build from the judge the recipe declared", async () => {
    const steps = declaring("red", "a red build is the agent's to fix, where it already is");
    let red = true;
    const { result, asked } = await pass({
      steps,
      answers: { judge: theRecipesJudge(steps) },
      actions: {
        build: [
          {
            name: "typecheck",
            kind: "run",
            run: async () => {
              const answer = red ? RED : PASSED;
              red = false;
              return answer;
            },
          },
        ],
      },
      ceilings: { rounds: 1, restartsLeft: 0 },
    });

    expect(walk(result).slice(5)).toEqual([
      "build:refused",
      "proposed:routed",
      "implement:passed",
      "build:passed",
      "review:passed",
      "proposed:passed",
      "merge:passed",
      "end:passed",
    ]);
    expect(asked.judge.map((on) => on.when)).toEqual(["red"]);
    expect(result.routes).toEqual([
      {
        from: "build",
        chose: "implement",
        to: "implement",
        // The recipe's line, named — not the built-in's name, which is what a
        // person would have to grep the source for to find the entry to edit.
        why: expect.stringContaining('the "a red build is the agent\'s to fix, where it already is" judge'),
        ceiling: null,
      },
    ]);
    // And it says what it declares rather than calling a `red` mechanical: the
    // same rule applied because a person wrote it down, not because nothing did.
    expect(result.routes[0]?.why).toContain("the recipe declares `judge: same-worktree`");
    expect(result.routes[0]?.why).not.toContain("is mechanical");
    // The agent that bought the round was shown what failed, which is the whole
    // of what the round is for.
    expect(asked.dispatch[1]?.again?.printed).toEqual({ step: "build", detail: RED.evidence });
    expect(outcomeOf(result)).toBe("landed");
  });

  /**
   * **And the direction that was costing the money**: `findings` has no built-in,
   * so an undeclared one parks at `waiting` with every round unspent — `#267` and
   * `#263`, both fixed by a person. Declared, the same arrival buys the round.
   *
   * Both halves are asserted in one case on purpose: *absent is not empty* (0064
   * §5) is the claim, and it is only a claim if the two recipes are run against
   * the same refusal. `rounds: 1` and one review that refuses, twice over.
   */
  it("buys a round for a reviewer's findings where the recipe declares one, and holds where it does not", async () => {
    const steps = declaring("findings", "the lines, until the rounds are spent");
    const spend = {
      ...checked(PASSED, REVIEW_REFUSED),
      ceilings: { rounds: 1, restartsLeft: 0 } as PassOptions["ceilings"],
    };

    const declared = await pass({ ...spend, steps, answers: { judge: theRecipesJudge(steps) } });
    // `review`'s findings arrive on the way through, so the router is `proposed`
    // itself and the round goes back to `implement`.
    expect(declared.asked.judge.map((on) => on.when)).toEqual(["findings", "findings"]);
    expect(declared.result.routes[0]).toMatchObject({ from: "proposed", to: "implement" });
    expect(declared.asked.dispatch).toHaveLength(2);
    // The findings are what the round was bought on, and what the agent is
    // briefed with — an empty `recheck` here would be a round spent on nothing.
    expect(declared.asked.dispatch[1]?.context.recheck).toEqual([BLOCKER]);
    // The second refusal has no round left, so it rests with a person: a
    // declared judge is bounded by the ceiling, never above it (0064 §7).
    expect(declared.result.rested).toBe("waiting");
    expect(declared.result.routes[1]?.why).toContain("`rounds` is spent");

    const nothing = await pass({ ...spend, steps: { proposed: [] }, answers: {} });
    expect(nothing.result.routes[0]?.to).toBe("waiting");
    expect(nothing.result.routes[0]?.why).toContain("no `judge:` is declared");
    expect(nothing.asked.dispatch).toHaveLength(1);
  });

  /**
   * **A runtime judge is a dispatch, and what it buys is the round the ceilings
   * already paid for** (`#277`).
   *
   * `judge: claude-code` at `findings` — the direction 0061 §3 measured at 231
   * refusals and calls the one judgement worth an agent — reaches the pass as a
   * `next` rather than as a name, because `judgeDeclaredAt` answers a runtime as
   * a runtime and the port is what asks it. The agent here answers *the lines*,
   * so the round goes back to `implement`.
   *
   * **And it stops at `rounds`, not one past it.** The same judge is asked the
   * second time with `implement` off the offer, and the most it can do with that
   * set is a person: the counting is the workflow's, the offer is what is left of
   * it, and no answer widens a set it was handed. `rounds: 1` and two refusals is
   * the smallest arrangement where the difference between *spends a round* and
   * *spends rounds* is visible.
   */
  it("dispatches a runtime judge the recipe declares, and spends one round of `rounds`", async () => {
    const steps = declaring("findings", "the lines or the approach", "claude-code");
    const seen: Judging[] = [];
    const theLines = (named: string, on: Judging): Judged => {
      seen.push(on);
      return { next: "implement", named, why: "the seam is right and two of its lines are wrong" };
    };

    const { result, asked } = await pass({
      ...checked(PASSED, REVIEW_REFUSED),
      steps,
      answers: { judge: theRecipesJudge(steps, theLines) },
      ceilings: { rounds: 1, restartsLeft: 0 },
    });

    // Asked on both arrivals, and never handed a count — the brief is the
    // direction, the words and the set (`JudgeBrief`).
    expect(seen.map((on) => on.when)).toEqual(["findings", "findings"]);
    expect(Object.keys(seen[0]!).sort()).toEqual(["evidence", "findings", "offering", "when"]);
    // The round it asked for, bought once, on the findings it read.
    expect(result.routes[0]).toMatchObject({ from: "proposed", chose: "implement", to: "implement" });
    expect(result.routes[0]?.why).toContain("two of its lines are wrong");
    expect(asked.dispatch).toHaveLength(2);
    expect(asked.dispatch[1]?.context.recheck).toEqual([BLOCKER]);
    // And the second time, `implement` was never on the set to ask for.
    expect(seen[1]?.offering).not.toContain("implement");
    expect(result.routes[1]).toMatchObject({ chose: "implement", to: "waiting", ceiling: "rounds" });
    expect(result.rested).toBe("waiting");
  });

  /**
   * **An agent judge that answers nothing reaches a person**, and the dispatch is
   * where that is decided (`#277`).
   *
   * A run that never started, one that did not finish, and an answer that will
   * not read as a destination are one case to the pass: none of them judged
   * anything, so `askTheAgent` answers `waiting` with the runtime's own words —
   * the same rule `agent-action.ts` applies to a reviewer whose answer will not
   * parse. **What it must not do is go round again**: an agent that could not
   * answer once costs the same the second time and terminates no sooner, so the
   * pass rests and the round is unspent.
   */
  it("holds for a person where the runtime judge answered nothing, and buys no round", async () => {
    const steps = declaring("findings", "the lines or the approach", "claude-code");
    const silent = (named: string): Judged => ({
      next: "waiting",
      named,
      why: `the "${named}" judge did not answer (timeout): 15m — so the pass is held for a person`,
    });

    const { result, asked } = await pass({
      ...checked(PASSED, REVIEW_REFUSED),
      steps,
      answers: { judge: theRecipesJudge(steps, silent) },
      // Three rounds to spend, and not one of them is spent on an answer nobody got.
      ceilings: { rounds: 3, restartsLeft: 0 },
    });

    expect(result.routes[0]).toMatchObject({ to: "waiting", ceiling: null });
    expect(result.routes[0]?.why).toContain("did not answer (timeout)");
    expect(asked.dispatch).toHaveLength(1);
    expect(result.rested).toBe("waiting");
    expect(outcomeOf(result)).toBe("blocked");
  });

  /**
   * **And an agent judge is held to the offer exactly as any other is** — the
   * refusal names the recipe's own entry, so what a person does about it is one
   * line rather than a grep (0061 §8, `#271`).
   *
   * The loop this closes is the expensive one: a judge that could answer
   * `implement` past a spent `rounds` would buy ~31 turns and ~$3.40 a round for
   * ever with nothing reporting a fault. It costs one pass and stops, and the
   * card says which ceiling refused it — a number somebody can raise.
   */
  it("refuses a runtime judge's answer the offer did not contain, naming the recipe's entry", async () => {
    const steps = declaring("findings", "the lines or the approach", "claude-code");
    const greedy = (named: string): Judged => ({ next: "implement", named, why: "one more go" });

    const { result } = await pass({
      ...checked(PASSED, REVIEW_REFUSED),
      steps,
      answers: { judge: theRecipesJudge(steps, greedy) },
      ceilings: { rounds: 0, restartsLeft: 0 },
    });

    expect(result.routes[0]).toMatchObject({ chose: "implement", to: "waiting" });
    expect(result.routes[0]?.why).toContain('the "the lines or the approach" judge answered "implement"');
    expect(result.routes[0]?.why).toContain("`rounds` is spent");
    expect(result.rested).toBe("waiting");
  });

  /**
   * **The one move a judge may not make for a mechanical refusal**, and the
   * reason `claim` is not in the set it was handed: 0039 §2, kept in code and
   * never in the recipe. A red build leaves the work still there and its remedy
   * is to fix it where it stands, so releasing the item throws a branch away for
   * a typecheck error. The judge asks anyway and is refused by name.
   */
  it("refuses a judge that answers `claim` for a mechanical refusal", async () => {
    const { result, asked } = await pass({
      actions: { build: [canned("typecheck", RED)] },
      answers: { judge: { next: "claim", named: "claude-code", why: "start over" } },
      // A restart to spend, and it is still on no offer: the direction is `red`.
      ceilings: { rounds: 1, restartsLeft: 3 },
    });

    expect(asked.judge[0]?.offering).toEqual(["waiting", "implement"]);
    expect(result.routes[0]?.to).toBe("waiting");
    expect(result.routes[0]?.why).toContain('answered "claim"');
    expect(result.rested).toBe("waiting");
    // The item is held for a person, never released.
    expect(outcomeOf(result)).toBe("blocked");
  });

  /**
   * **The set depends on how far the pass got, not only on what is left to
   * spend** (0061 §3, and the ticket's own *watch out*). A failed install refuses
   * before any agent has run, so there is no diff and no error in one to fix —
   * and a judge that knows nothing about `prepared` still cannot choose wrongly,
   * because the wrong answer was never in the set.
   *
   * **And `claim` is on neither**, though the item has a restart to spend: both
   * are mechanical directions, and 0039 §2's rule is that a restart needs a
   * judgement. No number a project writes down should make a failed install buy
   * a fresh worktree, and no judge should be able to either.
   */
  it("offers a judge only the steps the pass reached", async () => {
    const spare = { rounds: 3, restartsLeft: 1 };
    const early = await pass({
      steps: { prepared: [{ name: "install", run: "x" }] },
      actions: { prepared: [canned("install", RED)] },
      ceilings: spare,
    });
    const late = await pass({ ...checked(RED, PASSED), ceilings: spare });

    expect(early.asked.judge[0]?.offering).toEqual(["waiting"]);
    expect(late.asked.judge[0]?.offering).toEqual(["waiting", "implement"]);
    // And a judge is never told what it is answering for, nor what is left to
    // spend: `Judging` carries the direction, the words and the set, and no
    // ceiling and no count (`JudgeBrief`).
    expect(Object.keys(late.asked.judge[0] ?? {}).sort()).toEqual([
      "evidence",
      "findings",
      "offering",
      "when",
    ]);
  });

  /**
   * The direction 0061 §3 measured at 231 refusals and calls *the one judgement
   * worth an agent*. Here it answers `claim` — *the approach, not the lines* —
   * which requeues: the item is released and a higher-priority ticket opened in
   * the meantime goes first (0040).
   */
  it("takes a declared judge's answer for the findings direction, and a `claim` requeues", async () => {
    const { result, asked } = await pass({
      ...checked(PASSED, REVIEW_REFUSED),
      answers: {
        judge: { next: "claim", named: "claude-code", why: "the approach is wrong, not the lines" },
      },
      ceilings: { rounds: 1, restartsLeft: 1 },
    });

    expect(asked.judge[0]?.when).toBe("findings");
    expect(result.routes).toEqual([
      {
        from: "proposed",
        chose: "claim",
        to: "claim",
        why: "the approach is wrong, not the lines",
        ceiling: null,
      },
    ]);
    expect(result.rested).toBe("requeued");
    // Nothing refused, so nothing is named as having stopped it — and a requeue
    // releases the item, which is `failed` at `end`.
    expect(result.stoppedAt).toBeNull();
    expect(outcomeOf(result)).toBe("failed");
    expect(asked.land).toEqual([]);
  });

  /**
   * **An arrival no judge can answer still reaches a person**, which is the floor
   * `#253` set and the one thing replacing its router had to keep. 0061 §3's yaml
   * names `ask-or-assume` for `needs-input` and nothing implements it, so a
   * question reaches somebody rather than a name the schema would accept and no
   * code answers.
   */
  it("holds a direction no judge answers for a person", async () => {
    const { result, asked } = await pass({
      answers: { dispatch: { asked: "the ticket names two files and neither exists" } },
      ceilings: { rounds: 1, restartsLeft: 0 },
    });

    expect(asked.judge.map((on) => on.when)).toEqual([NEEDS_INPUT]);
    expect(result.routes[0]?.to).toBe("waiting");
    expect(result.routes[0]?.why).toContain("no `judge:` is declared");
    expect(result.rested).toBe("waiting");
    // The person is shown the step that asked, not the router that sent it.
    expect(result.stoppedAt?.step).toBe("implement");
  });

  /**
   * 0061 §8 once more — *a step refuses a destination it did not offer* — and the
   * fallback is the one destination that cannot loop. An overruled judge is not
   * one to ask for a second opinion, so the answer is a person with the refusal
   * on the card rather than the next cheapest step.
   */
  it("refuses a destination it did not offer, and names the judge", async () => {
    const { result } = await pass({
      ...checked(PASSED, REVIEW_REFUSED),
      answers: { judge: { next: "implement", named: "claude-code", why: "have another go" } },
      // Nothing left to spend, so `implement` is on no offer.
      ceilings: { rounds: 0, restartsLeft: 0 },
    });

    expect(result.routes[0]?.to).toBe("waiting");
    expect(result.routes[0]?.why).toContain(
      'the "claude-code" judge answered "implement" for `review`\'s findings',
    );
    expect(result.rested).toBe("waiting");
  });

  /**
   * `decideFix`'s first rule and the one that makes the loop safe to have (0038
   * §2): the bar is not *has findings*, it is *carries something the fixer could
   * not have authored*. This is the 24 refusals a year that carried nothing — and
   * no judge is asked about them, because paying a model to discover there is
   * nothing to fix is paying twice.
   */
  it("spends nothing on a refusal carrying nothing an agent could be held to", async () => {
    const anOpinion: ActionFinding = { ...BLOCKER, failureScenario: "  " };
    const { result, asked } = await pass({
      ...checked(PASSED, { verdict: "failed", evidence: "", findings: [anOpinion] }),
      ceilings: { rounds: 3, restartsLeft: 3 },
    });

    expect(asked.judge).toEqual([]);
    expect(result.routes[0]).toMatchObject({ to: "waiting" });
    expect(result.routes[0]?.why).toContain("nothing an agent could be held to");
    expect(result.rested).toBe("waiting");
  });

  /**
   * The mechanical answer is written in this file's vocabulary because
   * `judge.ts`'s `Destination` has three values and cannot say `build`; this is
   * what makes a divergence between the two a failing test rather than a
   * surprise. It is deleted the day T5 makes them one.
   */
  it("answers a mechanical direction exactly as `judge.ts`'s built-in does", async () => {
    const named = BUILT_IN_FOR.red;
    expect(named).not.toBeNull();

    for (const rounds of [0, 1]) {
      const { result } = await pass({
        actions: { build: [canned("typecheck", RED)] },
        ceilings: { rounds, restartsLeft: 0 },
      });
      const theirs = BUILT_IN[named ?? "same-worktree"]({
        when: "red",
        evidence: RED.evidence,
        findings: [],
        offer: rounds > 0 ? ["implement", "human"] : ["human"],
      });

      expect(result.routes[0]?.to).toBe(theirs === "human" ? "waiting" : theirs);
    }
  });

  /**
   * **What was chosen, what happened, and which ceiling is the difference between
   * them** (`#271`; 0064 §7's pair, and the fields `PassRouted` carries).
   *
   * Both rows below end at `waiting` and `to` alone cannot tell either of them
   * from a decision that asked for a person — which is the sentence on the card.
   * The first wanted another round and the rounds were spent; the second wanted a
   * fresh approach and the item had no restart left. The route is why a pass took
   * the path it took, and until `#271` it was written to a file that is deleted on
   * the ending where the change lands.
   */
  it("records what the decision wanted, and which ceiling refused it", async () => {
    const spent = await pass({
      actions: { build: [canned("typecheck", RED)] },
      // The built-in wants `implement` and there is no round to buy it with.
      ceilings: { rounds: 0, restartsLeft: 0 },
    });

    expect(spent.result.routes).toEqual([
      {
        from: "build",
        chose: "implement",
        to: "waiting",
        why: expect.stringContaining("same-worktree"),
        ceiling: "rounds",
      },
    ]);

    const overruled = await pass({
      ...checked(PASSED, REVIEW_REFUSED),
      answers: { judge: { next: "claim", named: "claude-code", why: "the approach is wrong" } },
      // A round to spend, so `claim` is the one destination off the set — and the
      // ceiling that took it off is the item's and not this pass's.
      ceilings: { rounds: 1, restartsLeft: 0 },
    });

    expect(overruled.result.routes).toEqual([
      {
        from: "proposed",
        chose: "claim",
        to: "waiting",
        why: expect.stringContaining('answered "claim"'),
        ceiling: "restarts",
      },
    ]);
  });

  /**
   * **And the words a person reads name the ceiling too** (0064 §7, `#267`).
   *
   * `ceiling` on the route is for whoever reads the log back; the sentence is
   * what is on the card, and until the offer had two sets it could say only
   * *that is not one of the steps it was offered* — true of a spent `rounds`
   * and of a step no number would have bought alike. Both rows below end at
   * `waiting`, and the next move a person has differs: the first is a line in
   * `~/.lingtai/<project>/recipe.yml`, and the second is not.
   */
  it("names the ceiling in the words, where a number is what refused the choice", async () => {
    const spent = await pass({
      actions: { build: [canned("typecheck", RED)] },
      ceilings: { rounds: 0, restartsLeft: 0 },
    });

    expect(spent.result.routes[0]?.why).toContain("it wanted `implement`, and `rounds` is spent");

    // The item's ceiling rather than this pass's, and through the other door: a
    // declared judge answering outside the set it was handed.
    const overruled = await pass({
      ...checked(PASSED, REVIEW_REFUSED),
      answers: { judge: { next: "claim", named: "claude-code", why: "the approach is wrong" } },
      ceilings: { rounds: 1, restartsLeft: 0 },
    });

    expect(overruled.result.routes[0]?.why).toContain("it wanted `claim`, and `restarts` is spent");

    // And a destination no number would have offered is not named in the words
    // at all, which is `#271`'s rule: naming a step the arrival could not have
    // taken invites the reader to ask for it. `chose` records it; the card does
    // not.
    const never = await pass({
      steps: { prepared: [{ name: "install", run: "false" }] },
      actions: { prepared: [canned("install", RED)] },
      ceilings: { rounds: 3, restartsLeft: 3 },
    });

    expect(never.result.routes[0]?.chose).toBe("implement");
    expect(never.result.routes[0]?.why).not.toContain("implement");
    expect(never.result.routes[0]?.why).not.toContain("spent");
  });

  /**
   * **And null is a ceiling's absence rather than a gap in the record** — the
   * reading `ceilingFor` is careful about. A failed install refuses before any
   * agent has run, so the built-in's `implement` was on neither half of the
   * offer whatever is left to spend: naming `rounds` here would send a person to
   * raise a number that would refuse the same route again.
   */
  it("names no ceiling where no number would have offered the choice", async () => {
    const { result } = await pass({
      steps: { prepared: [{ name: "install", run: "false" }] },
      actions: { prepared: [canned("install", RED)] },
      ceilings: { rounds: 3, restartsLeft: 3 },
    });

    expect(result.routes).toEqual([
      {
        from: "prepared",
        chose: "implement",
        to: "waiting",
        why: expect.stringContaining("same-worktree"),
        ceiling: null,
      },
    ]);
  });
});

// ------------------------------------------------------------------ merge ----

describe("merge reports a reason and a detail, and decides nothing", () => {
  it("lands, and is handed the head the steps gave their verdicts about", async () => {
    const { result, asked } = await pass();

    // Two facts and no more: the strategy the block declares, and the commit the
    // steps gave their verdicts about — no base, because the base is one value
    // that flows and `land` already has it (0061 §4), and no worktree, which
    // `#268` took off when the cut became a plugin's.
    expect(asked.land).toEqual([{ strategy: "merge-commit", onSha: COMMITTED }]);
    expect(result.steps.find((visit) => visit.step === "merge")?.ending).toEqual({ ending: "passed" });
    expect(outcomeOf(result)).toBe("landed");
  });

  /**
   * **The body is nothing beyond its plugins, and `merge: []` is what that costs
   * being explicit about** (0065 §2–3, `#270`).
   *
   * A recipe that declares nothing there is the case above: the caller substitutes
   * `defaultsAt`'s lane and the change lands. A caller that substitutes *nothing*
   * is this one, and the step passes having landed nothing — which is the
   * substitution rule doing what it says rather than a hole, and is why
   * `conduct.ts` asks `landedAt()` before it writes `WorkItemLanded`.
   */
  it("lands nothing where nothing at all runs at the step", async () => {
    const { result, asked } = await pass({ actions: { merge: [] } });

    expect(asked.land).toEqual([]);
    expect(result.steps.find((visit) => visit.step === "merge")?.ending).toEqual({ ending: "passed" });
  });

  /**
   * Over the whole log the lane has refused 32 times — **26 `verify-failed`, 6
   * `conflict`** — and the common failure is that somebody else's work landed and
   * the diff stopped being true. The step reports the lane's own words and the
   * judge at `proposed` decides what they cost: a `verify-failed` is mechanical, so
   * the built-in sends it back to `implement` with the new base.
   */
  it("reports the lane's `reason` and `detail`, and the judge decides", async () => {
    let refuses = true;
    const { result, asked } = await pass({
      answers: {
        land: () => {
          const answer: LandAnswer = refuses
            ? { notMerged: { reason: "verify-failed", detail: "pnpm test failed on the new base" } }
            : { merged: MERGED };
          refuses = false;
          return answer;
        },
      },
      ceilings: { rounds: 1, restartsLeft: 0 },
    });

    /**
     * **The reason survived becoming an action's, which is the whole of `#270`.**
     *
     * The pipeline knows only that *something the recipe declared refused* and
     * `endingOf` spells that `action-refused`; a `merge:` action puts the lane's
     * own word on `ActionResult.because` and `becauseFrom` carries it here, so the
     * direction is still `verify-failed` and the round is still bought. `at` is
     * the action's name now rather than `null`, which is 0058 §3c's *what refused*
     * gaining an answer it did not have.
     */
    expect(result.steps.find((visit) => visit.step === "merge")?.ending).toEqual({
      ending: "refused",
      because: "verify-failed",
      at: "land the branch",
      detail: "pnpm test failed on the new base",
    });
    expect(asked.judge[0]).toMatchObject({
      when: "verify-failed",
      evidence: "pnpm test failed on the new base",
    });
    expect(result.routes).toMatchObject([{ from: "merge", to: "implement" }]);
    expect(outcomeOf(result)).toBe("landed");
  });

  /**
   * **Every path into `end` has been through `build` and `review`**, and the edge
   * from `merge` back to `build` is what buys it: an agent that resolves a
   * conflict writes code *after* the review passed, so both run again before
   * anything lands.
   *
   * A declared judge is what chooses it. `conflict` has no built-in, and that is
   * deliberate — **the intent conflict is the row an agent must not take**: two
   * changes that edited the same decision differently produce text an agent can
   * merge and an intent it cannot know.
   */
  it("takes a conflict back through `build` and `review` when a judge says so", async () => {
    let refuses = true;
    const { result } = await pass({
      answers: {
        land: () => {
          const answer: LandAnswer = refuses
            ? { notMerged: { reason: "conflict", detail: "both changed doc/design/the-pipeline.md" } }
            : { merged: MERGED };
          refuses = false;
          return answer;
        },
        judge: { next: "build", named: "claude-code", why: "the text resolves; the intent is one file" },
      },
      ceilings: { rounds: 1, restartsLeft: 0 },
    });

    expect(walk(result).slice(8)).toEqual([
      "merge:refused",
      "proposed:routed",
      "build:passed",
      "review:passed",
      "proposed:passed",
      "merge:passed",
      "end:passed",
    ]);
    expect(result.routes).toEqual([
      {
        from: "merge",
        chose: "build",
        to: "build",
        why: "the text resolves; the intent is one file",
        ceiling: null,
      },
    ]);
    expect(outcomeOf(result)).toBe("landed");
  });

  /**
   * The lane's other five reasons are not directions: they stop the lane before
   * the diff is what is in doubt, and *offering a judge a direction nothing can
   * arrive by is the same mistake as offering it a step nothing can run*
   * (`JudgeWhen`). So they reach a person, which is where they go today.
   */
  it("holds a lane reason no judge answers for a person, without asking one", async () => {
    const { result, asked } = await pass({
      answers: { land: { notMerged: { reason: "pending-migration", detail: "1 migration file" } } },
      ceilings: { rounds: 3, restartsLeft: 3 },
    });

    expect(asked.judge).toEqual([]);
    expect(result.routes[0]).toMatchObject({ from: "merge", to: "waiting" });
    expect(result.routes[0]?.why).toContain("pending-migration");
    expect(result.rested).toBe("waiting");
    expect(result.stoppedAt?.step).toBe("merge");
    expect(outcomeOf(result)).toBe("blocked");
  });
});

// ------------------------------------------------- every reason is reported ----

/**
 * 0058 §3c's third thing, read across the whole file: **which step** the loop
 * stamps, **what refused** is on the ending, and **a reason** is what this
 * asserts. A route that forgets leaves a person reading *waiting on you* with no
 * way to learn why without opening a run log.
 *
 * `never-ran` is the one ending with no `because`, and that is its own argument:
 * it is the wall about the *account* rather than about the diff, told apart by a
 * field rather than by a sentence (0031 §1). **`held` is the other**, and it is
 * the same argument: the recipe asked a person, so the question is on the ending
 * and there is nothing to report a reason *about*. A question at `admit` is one
 * of those since `#268` — it is the `worktree:` plugin's `needs-approval` — so
 * what the row below asserts for it is the question rather than a `because`.
 */
describe("every step that does not simply pass reports a reason", () => {
  it.each([
    { what: "a claim nobody could take", answers: { take: { passedOver: "no kind label" } } as Answers },
    { what: "a tree that was not cut", answers: { cut: { notCut: "no such base ref" } } as Answers },
    { what: "a question at `implement`", answers: { dispatch: { asked: "which file?" } } as Answers },
    { what: "an agent with no receipt", answers: { dispatch: { stopped: "the budget went" } } as Answers },
    {
      what: "a merge the lane refused",
      answers: { land: { notMerged: { reason: "conflict", detail: "both changed one file" } } } as Answers,
    },
  ])("names a reason for $what", async ({ answers }) => {
    const { result } = await pass({ answers });

    const reported = result.steps
      .map((visit) => visit.ending)
      .filter((ending) => ending.ending === "refused" || ending.ending === "did-not-finish");

    expect(reported.length).toBeGreaterThan(0);
    for (const ending of reported) expect(ending.because).not.toBe("");
  });

  /** And the two that report a question instead, which is the same obligation. */
  it("names the question where a step held instead of reporting", async () => {
    const { result } = await pass({ answers: { cut: { asked: "which base?" } } });

    const held = result.steps.map((visit) => visit.ending).filter((e) => e.ending === "held");
    expect(held).toEqual([{ ending: "held", at: "cut the branch", question: "which base?" }]);
    expect(outcomeOf(result)).toBe("blocked");
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
