/**
 * The six bodies, read against the decision rather than against a diff.
 *
 * `pass-steps.ts` is wired to nothing (`#259`), so this file is the whole of
 * what says it works — the same arrangement `pass.test.ts` is in, and for the
 * same reason: *a reviewer reads it against the ADR, which is the one reading a
 * cold reviewer is good at.*
 *
 * Every `it` below is a sentence a body is responsible for, and the sentences are
 * all about **cost**: which of the six endings a given answer is, because that is
 * what decides whether a fix round is bought, whether the item is held, whether
 * the conductor stands down, and whether anybody is asked. Nothing here leaves
 * the system — `PassPorts` is faked and `actionsAt` is replaced — so no process
 * is spawned, no agent is paid and no person is asked, which is what puts it in
 * `unit/` and under the `build` point (0060 §1).
 */
import { STEPS, type Envelope, type PayloadOf, type Step, type ToAppend } from "@lingtai/domain";
import type { Action, ActionContext, ActionEvent, ActionResult } from "@lingtai/actions";
import { StepMap } from "@lingtai/recipe";
import type { Worktree } from "@lingtai/repo";
import { describe, expect, it } from "vitest";
import type { TerminalOutcome } from "../src/end-step.ts";
import {
  NOT_ENDED,
  bodiesFor,
  type Brief,
  type Claimed,
  type Cut,
  type Drafted,
  type PassPorts,
  type SentBack,
  type Taken,
  type Ticket,
  type Worked,
} from "../src/pass-steps.ts";
import {
  NEEDS_INPUT,
  outcomeOf,
  runPass,
  type PassOptions,
  type StepBodies,
  type StepBody,
  type StepWork,
} from "../src/pass.ts";

// --------------------------------------------------------------- fixtures ----

const context: ActionContext = { runId: "run-1", onSha: "caller00base", cwd: "/nowhere", env: {} };

const ticket: Ticket = { ref: "259", title: "T4a — six bodies", body: "the ticket's own text" };
const item: Claimed = { workItemId: "wi-lingtai-259", ticket, kind: "tech-debt" };

const tree: Worktree = {
  path: "/nowhere/worktrees/run-1",
  branch: "agent/259",
  baseSha: "adm1tbasesha",
  plantedAt: "/nowhere/worktrees/run-1/.env.local",
  remoteHead: null,
};

const PASSED: ActionResult = { verdict: "passed", evidence: "green", findings: [] };

const canned = (name: string, result: ActionResult): Action => ({
  name,
  kind: "run",
  run: async () => result,
});

const recipeWith = (steps: Record<string, unknown>): PassOptions["recipe"] => ({
  steps: StepMap.parse(steps),
});

/**
 * Two declared effects at `end`, because a recipe that declares none resolves to
 * no row at all — *the skip is the user's decision, and `GatesResolved` already
 * records it* — and a test asserting `[]` against `[]` would say nothing.
 *
 * Two rather than one, and neither writes a `when:`: `close:`'s defaults to
 * `landed` and `labels:`'s to `any` (`recipe.ts:172`, `:178`). So the pair reads
 * differently at every outcome, and an `end` that ran every declared cell on
 * every ending — `#61`'s failure — closes a ticket that landed nothing.
 */
const AT_END = {
  end: [
    { name: "close it", close: true },
    { name: "say so", labels: ["needs-attention"] },
  ],
};

/**
 * An item with something on its stream already, so the version the append expects
 * is not zero — which is the half of `record` that is about the race.
 */
const claimedAlready: Envelope[] = [
  {
    seq: 1,
    streamId: item.workItemId,
    version: 1,
    type: "WorkItemClaimed",
    actor: "conductor",
    at: new Date(0),
    schemaVer: 1,
    data: {},
  } as unknown as Envelope,
];

const events = (): { emit: PassOptions["emit"]; seen: ActionEvent[] } => {
  const seen: ActionEvent[] = [];
  return { emit: (event) => void seen.push(event), seen };
};

/** Every action the loop built, answering `passed` unless a test says otherwise. */
const actionsFrom = (at: Record<string, readonly Action[]> = {}): PassOptions["actionsAt"] => {
  return (step, actions) => at[step] ?? actions.map((a) => canned(a.name, PASSED));
};

/** What one action was judged against, which is the half a `Brief` cannot see. */
const judging = (seen: { onSha: string; round: number | undefined }[]): Action => ({
  name: "check",
  kind: "run",
  run: async (seenWith) => {
    seen.push({ onSha: seenWith.onSha, round: seenWith.round });
    return PASSED;
  },
});

/** What the ports were asked for, in order, and with what. */
interface Asked {
  took: number;
  cut: Claimed[];
  /** Why `admit` was asked, per call — `null` on the way through. */
  admitted: (SentBack | null)[];
  drafted: Brief[];
  dispatched: Brief[];
  /**
   * Every call to `record` — **one per pass that claimed, whether anything
   * resolved or not**, because the ending is what the call is about and the
   * resolution rides with it.
   */
  endings: { workItemId: string; at: number; outcome: TerminalOutcome; resolved: number }[];
  /** Every `EndActionsResolved` `end` recorded, unwrapped to what it says. */
  recorded: { workItemId: string; at: number; outcome: TerminalOutcome; actions: string[] }[];
}

/** `EndActionsResolved`'s payload, read off what the port was handed. */
const resolvedIn = (appended: ToAppend): { outcome: TerminalOutcome; actions: string[] } => {
  const data = appended.data as PayloadOf<"EndActionsResolved">;
  return { outcome: data.outcome, actions: data.actions.map((a) => a.name) };
};

/**
 * Every port, answering the ordinary thing — and whichever of them a test wants
 * to answer differently.
 *
 * The ordinary thing is *this repository, today*: an item taken, a worktree cut,
 * **no design at all**, an agent that committed, and an item whose stream has
 * nothing on it yet, which is what makes the version the append expects zero.
 *
 * **An override answers; it does not record.** What each port was asked is noted
 * by the wrapper below, so a test that changes one answer still sees every call
 * — which matters at `implement`, where the whole question is what the *second*
 * brief said.
 */
function ports(overrides: Partial<PassPorts> = {}): { ports: PassPorts; asked: Asked } {
  const asked: Asked = { took: 0, cut: [], admitted: [], drafted: [], dispatched: [], endings: [], recorded: [] };
  const ordinary: PassPorts = {
    take: async (): Promise<Taken> => ({ taken: item }),
    cut: async (): Promise<Cut> => ({ worktree: tree }),
    // Every pass today: nothing writes a design yet, so the step produces none.
    draft: async (): Promise<Drafted> => ({ document: "" }),
    dispatch: async (): Promise<Worked> => ({ committed: "c0mm1tted5ha" }),
    // An item with nothing on its stream yet, which is what makes the version
    // the append expects zero.
    read: async (): Promise<readonly Envelope[]> => [],
    record: async () => {},
  };
  const answering: PassPorts = { ...ordinary, ...overrides };
  return {
    asked,
    ports: {
      take: async () => {
        asked.took += 1;
        return answering.take();
      },
      cut: async (claimed, again) => {
        asked.cut.push(claimed);
        asked.admitted.push(again);
        return answering.cut(claimed, again);
      },
      draft: async (brief) => {
        asked.drafted.push(brief);
        return answering.draft(brief);
      },
      dispatch: async (brief) => {
        asked.dispatched.push(brief);
        return answering.dispatch(brief);
      },
      read: async (claimed) => answering.read(claimed),
      record: async (ending) => {
        const { claimed, at, outcome, resolved } = ending;
        asked.endings.push({ workItemId: claimed.workItemId, at, outcome, resolved: resolved.length });
        for (const appended of resolved) {
          asked.recorded.push({ workItemId: claimed.workItemId, at, ...resolvedIn(appended) });
        }
        return answering.record(ending);
      },
    },
  };
}

/**
 * One pass, with the six real bodies and the four the skeleton still has.
 *
 * `bodies` is a partial override rather than a replacement, so a test that needs
 * a judge at `proposed` — the one T4b has not written — puts one there and keeps
 * the six under test.
 */
const pass = (
  options: Omit<Partial<PassOptions>, "bodies"> & { ports: PassPorts; bodies?: Partial<StepBodies> },
) => {
  const { emit } = events();
  const { ports: p, bodies, ...rest } = options;
  return runPass({
    recipe: recipeWith({}),
    context,
    emit,
    actionsAt: actionsFrom(),
    ...rest,
    bodies: { ...bodiesFor(p), ...bodies },
  });
};

/**
 * The judge `Asked` promises and T4b will write: a question answered with *that
 * step again*, rather than with a person.
 *
 * It is here rather than in `pass-steps.ts` because routing is `proposed`'s and
 * `proposed` is not one of these six. What it proves about them is the other end
 * of that edge — that a step the judge sends back is told it was sent back.
 */
const stateYourAssumption: StepBody<"proposed"> = async ({ arriving, offering }) => {
  if (arriving === null) return { ending: "passed" };
  // A judge answers *which of these*, never *what is legal* (0061 §3), so a
  // spent round leaves the asking step off the offer and a person is the answer.
  return offering.includes(arriving.step)
    ? { ending: "routed", to: arriving.step, why: "state your assumption" }
    : { ending: "routed", to: "waiting", why: "the rounds are spent" };
};

/** A round to spend, which is what the edge back into the spine costs. */
const ONE_ROUND: PassOptions["ceilings"] = { rounds: 1, restartsLeft: 0 };

/**
 * One visit, as the loop would hand it — for the two facts `runPass` cannot
 * show, where a body has to be called on its own.
 *
 * The cast is the same one `runStep` pays and for the same reason: `StepWork`'s
 * three conditional fields are written per step, and a helper generic over the
 * step cannot narrow them. Everything here is what the loop hands a step it
 * walked into on the spine — nothing arriving, nothing offered, no outcome.
 */
const visit = <S extends Step>(step: S): StepWork<S> =>
  ({
    step,
    actions: [],
    refuses: false,
    reached: [],
    arriving: null,
    offering: [],
    outcome: null,
    context,
    emit: () => {},
  }) as unknown as StepWork<S>;

// ------------------------------------------------------------------ the ten ----

describe("the six bodies fill a contract that already runs", () => {
  it("is ten bodies, four of them still the skeleton's", () => {
    const { ports: p } = ports();
    expect(Object.keys(bodiesFor(p)).sort()).toEqual([...STEPS].sort());
  });

  /** The way through: every step passes, `end` resolves `landed`, nothing stops. */
  it("walks the ten and lands", async () => {
    const { ports: p, asked } = ports();

    const result = await pass({ ports: p, recipe: recipeWith(AT_END) });

    expect(result.steps.map((s) => s.step)).toEqual([...STEPS]);
    expect(result.stoppedAt).toBeNull();
    expect(result.rested).toBeNull();
    expect(outcomeOf(result)).toBe("landed");
    expect(asked).toMatchObject({ took: 1, cut: [item] });
    expect(asked.recorded).toEqual([
      { workItemId: item.workItemId, at: 0, outcome: "landed", actions: ["close it", "say so"] },
    ]);
  });

  /**
   * A recipe that declares nothing at `end` resolves nothing (`end-step.ts`) —
   * **and the item's ending is still recorded**, because the ending is not the
   * effects. The port is called once, with an empty list, which is what makes the
   * outcome's own append the same append.
   */
  it("records no resolution where nothing was declared at end, and the ending anyway", async () => {
    const { ports: p, asked } = ports();

    const result = await pass({ ports: p });

    expect(result.steps.at(-1)).toMatchObject({ step: "end", ending: { ending: "passed" } });
    expect(asked.recorded).toEqual([]);
    expect(asked.endings).toEqual([{ workItemId: item.workItemId, at: 0, outcome: "landed", resolved: 0 }]);
  });
});

// ------------------------------------------------------------------- claim ----

describe("claim picks the ticket, and cannot refuse", () => {
  it("takes the item and hands it to every step after it", async () => {
    const { ports: p, asked } = ports();

    await pass({ ports: p });

    expect(asked.cut).toEqual([item]);
    expect(asked.drafted[0]?.ticket).toEqual(ticket);
    expect(asked.dispatched[0]?.ticket).toEqual(ticket);
  });

  /**
   * 0058 §2: if a `claim` plugin could refuse, not one of a refusal's
   * consequences would mean anything — there is no item to hold and no diff to
   * fix. So an issue GitHub will not offer stops the pass without buying
   * anything, and does not reach the router (`ARRIVE_AT_THE_ROUTER`).
   */
  it("reports an issue it may not take as did-not-finish, and stops", async () => {
    const { ports: p, asked } = ports({
      take: async () => ({ passedOver: "blocked-by" }),
    });

    const result = await pass({ ports: p, recipe: recipeWith(AT_END) });

    expect(result.steps.map((s) => s.step)).toEqual(["claim", "end"]);
    expect(result.stoppedAt).toMatchObject({
      step: "claim",
      ending: { ending: "did-not-finish", because: "passed-over", detail: "blocked-by" },
    });
    expect(result.routes).toEqual([]);
    // Nothing was claimed, so there is no stream for `end` to resolve onto — and
    // `close it` is declared, so this is a resolution withheld rather than absent.
    // No ending is recorded either: there is no item to have ended.
    expect(asked.recorded).toEqual([]);
    expect(asked.endings).toEqual([]);
  });

  /** Losing the append is an ordinary outcome of two schedulers on one queue. */
  it("keeps an item somebody else holds apart from one GitHub passed over", async () => {
    const { ports: p } = ports({
      take: async () => ({ notClaimed: 'held by host:123 as run-9' }),
    });

    const result = await pass({ ports: p });

    expect(result.stoppedAt?.ending).toMatchObject({
      ending: "did-not-finish",
      because: "not-claimed",
      detail: "held by host:123 as run-9",
    });
  });
});

// ------------------------------------------------------ one closure, two passes ----

describe("a second pass on one closure is its own pass", () => {
  /** Both passes, in order, on the ports and the bodies a daemon would build once. */
  const twice = async (p: PassPorts, options: Partial<PassOptions> = {}) => {
    const bodies = bodiesFor(p);
    const { emit } = events();
    const run = () =>
      runPass({ recipe: recipeWith(AT_END), context, emit, actionsAt: actionsFrom(), ...options, bodies });
    return [await run(), await run()] as const;
  };

  /**
   * **The item is cleared at `claim`, so a pass that took nothing has nothing.**
   *
   * A daemon builds its ports at startup and `bodiesFor(ports)` beside them — the
   * natural reading of a factory over a stateless `PassPorts` — and calls
   * `runPass({ bodies })` once per queue pass. Held facts that were never cleared
   * made the second pass the first one's: `take` declines, the walk stops at
   * `claim`, and `end` resolves `blocked` onto the item the pass before it landed
   * and closed. `tell.ts` then labels a closed issue `needs-attention`, and the
   * log carries a blocked ending for a ticket whose `main` moved.
   */
  it("resolves nothing onto the item the pass before it landed", async () => {
    let takes = 0;
    const { ports: p, asked } = ports({
      take: async () => (takes++ === 0 ? { taken: item } : { passedOver: "excluded-label" }),
    });

    const [first, second] = await twice(p);

    expect(outcomeOf(first)).toBe("landed");
    expect(second.steps.map((s) => s.step)).toEqual(["claim", "end"]);
    expect(second.stoppedAt).toMatchObject({ step: "claim", ending: { because: "passed-over" } });
    // One ending and one resolution between the two passes, and both the first's.
    expect(asked.endings).toEqual([{ workItemId: item.workItemId, at: 0, outcome: "landed", resolved: 1 }]);
    expect(asked.recorded).toMatchObject([{ outcome: "landed", actions: ["close it", "say so"] }]);
  });

  /**
   * **The worktree and the design are cleared with the item — and the spine
   * cannot show it, so this drives the bodies.**
   *
   * `runPass` reaches `implement` only after `admit` and `design` passed *in the
   * same pass*, and both of those overwrite what they hold: a stale tree is
   * replaced by the one just cut and a stale document by the one just drafted.
   * So a second pass that stops at `claim` never reaches either, and one that
   * does not stop overwrites both — which means two `runPass` calls can assert
   * nothing whatever about this clearing, however the assertions are worded.
   *
   * The bodies are the unit and the guarantee is theirs: after a `claim`, a
   * closure that has already conducted a whole pass holds no worktree and no
   * document. Delete `worktree = null;` from `claim` and `implement` dispatches
   * an agent into a tree from a pass that finished hours ago instead of saying
   * it has none; delete `design = "";` and the next agent is briefed on the last
   * ticket's design.
   */
  it("clears the worktree and the design with the item", async () => {
    const { ports: p, asked } = ports({
      draft: async () => ({ document: "# the first pass's design" }),
    });
    const bodies = bodiesFor(p);
    const { emit } = events();

    // One whole pass, so the closure holds an item, a tree and a document.
    await runPass({ recipe: recipeWith(AT_END), context, emit, actionsAt: actionsFrom(), bodies });
    expect(asked.dispatched[0]).toMatchObject({ worktree: tree, design: "# the first pass's design" });

    // The next pass's `claim`, and nothing after it.
    await bodies.claim(visit("claim"));

    // The tree went with the item, so `implement` has nothing to brief on and
    // reports the pass's own bookkeeping rather than dispatching into the last
    // pass's worktree.
    await expect(bodies.implement(visit("implement"))).rejects.toThrow(
      /the `implement` step has no worktree/,
    );
    expect(asked.dispatched).toHaveLength(1);

    // And the document went too: cut a fresh tree, and the brief carries the
    // empty design every pass produces today, not the one before it.
    await bodies.admit(visit("admit"));
    await bodies.implement(visit("implement"));
    expect(asked.dispatched[1]).toMatchObject({ worktree: tree, design: "" });
  });

  /** A second pass that *does* take one is briefed on that one, start to finish. */
  it("carries the second pass's own item through to its ending", async () => {
    const next: Claimed = {
      workItemId: "wi-lingtai-260",
      ticket: { ref: "260", title: "the one after", body: "its own text" },
      kind: "bug",
    };
    let takes = 0;
    const { ports: p, asked } = ports({
      take: async () => ({ taken: takes++ === 0 ? item : next }),
    });

    await twice(p);

    expect(asked.cut).toEqual([item, next]);
    expect(asked.dispatched.map((b) => b.ticket.ref)).toEqual(["259", "260"]);
    expect(asked.endings.map((e) => e.workItemId)).toEqual([item.workItemId, next.workItemId]);
  });
});

// ------------------------------------------------------------------- admit ----

describe("admit cuts the worktree, so the head first has a value here", () => {
  /**
   * `onSha` is *the commit this verdict is about, and the only thing that makes
   * it stale*. A pass that judged the caller's base while the tree stood at the
   * worktree's has paid for every verdict and can show none of them.
   */
  it("judges every step after it against the base the worktree was cut at", async () => {
    const judged: { onSha: string; round: number | undefined }[] = [];
    const { ports: p } = ports();

    await pass({
      ports: p,
      recipe: recipeWith({ prepared: [{ name: "install", run: "pnpm install" }] }),
      actionsAt: actionsFrom({ prepared: [judging(judged)] }),
    });

    expect(judged.map((j) => j.onSha)).toEqual([tree.baseSha]);
  });

  it("briefs the agents on the tree it cut", async () => {
    const { ports: p, asked } = ports();

    await pass({ ports: p });

    expect(asked.drafted[0]?.worktree).toEqual(tree);
    expect(asked.dispatched[0]?.worktree).toEqual(tree);
  });

  /**
   * A clone that did not finish is not a judgement about the change — nothing has
   * been written yet — so it buys no round and the pass stops (0057 §2).
   */
  it("stops the pass when there is no tree to work in, and buys nothing", async () => {
    const { ports: p, asked } = ports({
      cut: async () => ({ notCut: "the mirror has no ref main" }),
    });

    const result = await pass({ ports: p, recipe: recipeWith(AT_END) });

    expect(result.steps.map((s) => s.step)).toEqual(["claim", "admit", "end"]);
    expect(result.stoppedAt).toMatchObject({
      step: "admit",
      ending: { ending: "did-not-finish", because: "worktree" },
    });
    expect(result.stoppedAt?.ending).toMatchObject({
      detail: expect.stringContaining("the mirror has no ref main"),
    });
    expect(result.routes).toEqual([]);
    // `end` ran anyway, for the outcome the pass actually reached.
    expect(asked.recorded).toMatchObject([{ outcome: "blocked", actions: ["say so"] }]);
  });

  /** 0058 §3b draws the edge, so the port has to be able to say it. */
  it("takes a question at admit to the router, carrying needs-input", async () => {
    const { ports: p } = ports({
      cut: async () => ({ asked: "which of the two bases did you mean?" }),
    });

    const result = await pass({ ports: p });

    expect(result.steps.map((s) => s.step)).toEqual(["claim", "admit", "proposed", "end"]);
    expect(result.stoppedAt?.ending).toMatchObject({ because: NEEDS_INPUT });
    expect(result.routes).toMatchObject([{ from: "admit", to: "waiting" }]);
  });
});

// ---------------------------------------------------------------- prepared ----

describe("prepared refuses, and the refusal travels", () => {
  /**
   * **The one of the six whose work is entirely declarable today.** Its plugin is
   * `run:` (0061 §3), `KINDS_AT.prepared` is open, and this repository declares
   * `pnpm install --frozen-lockfile` there. So the body is nothing beyond the
   * plugins and the refusal is the declared action's — and what this asserts is
   * that it *travels*: to `proposed`, carrying its reason, and answered there.
   * A failed install is the cheapest refusal in the pass and the first one a pass
   * can reach.
   */
  it("refuses on a failed install, reaches proposed, and rests with a person", async () => {
    const { ports: p, asked } = ports();

    const result = await pass({
      ports: p,
      recipe: recipeWith({
        ...AT_END,
        prepared: [{ name: "install", run: "pnpm install --frozen-lockfile" }],
      }),
      actionsAt: actionsFrom({
        prepared: [canned("install", { verdict: "failed", evidence: "pnpm install exited 1", findings: [] })],
      }),
    });

    expect(result.steps.map((s) => s.step)).toEqual(["claim", "admit", "prepared", "proposed", "end"]);
    expect(result.stoppedAt).toMatchObject({
      step: "prepared",
      ending: { ending: "refused", at: "install", detail: "pnpm install exited 1" },
    });
    expect(result.routes).toMatchObject([{ from: "prepared", to: "waiting" }]);
    expect(result.rested).toBe("waiting");
    // No money was spent past it: no design was drafted and no agent dispatched.
    expect(asked.drafted).toEqual([]);
    expect(asked.dispatched).toEqual([]);
    expect(asked.recorded).toMatchObject([{ outcome: "blocked", actions: ["say so"] }]);
  });

  /** And a recipe that declares no install has a `prepared` that passes. */
  it("passes when nothing is declared there", async () => {
    const { ports: p, asked } = ports();

    const result = await pass({ ports: p });

    expect(result.steps.find((s) => s.step === "prepared")?.ending).toEqual({ ending: "passed" });
    expect(asked.dispatched).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ design ----

describe("design may produce nothing, and that is an answer", () => {
  /**
   * 0058 §3: the step always runs and its plugin may return an empty document.
   * `implement` is handed the issue's own text and the design, and works from the
   * issue when the design is empty — which is what every pass does today. No
   * conditional step, no skip.
   */
  it("passes on an empty document, and implement is briefed with the issue", async () => {
    const { ports: p, asked } = ports();

    const result = await pass({ ports: p });

    expect(result.steps.find((s) => s.step === "design")?.ending).toEqual({ ending: "passed" });
    expect(asked.dispatched[0]).toMatchObject({ design: "", ticket });
  });

  it("hands implement the document when there is one", async () => {
    const { ports: p, asked } = ports({
      draft: async () => ({ document: "# the shape of it\n\none seam, two callers" }),
    });

    await pass({ ports: p });

    expect(asked.dispatched[0]?.design).toContain("one seam, two callers");
    // And the issue is still there beside it: two things, not one instead of one.
    expect(asked.dispatched[0]?.ticket).toEqual(ticket);
  });

  it("takes a question at design to the router, and buys no round", async () => {
    const { ports: p, asked } = ports({
      draft: async () => ({ asked: "is this a schema change or a rename?" }),
    });

    const result = await pass({ ports: p });

    expect(result.steps.map((s) => s.step)).toEqual(["claim", "admit", "prepared", "design", "proposed", "end"]);
    expect(result.routes).toMatchObject([{ from: "design", to: "waiting" }]);
    expect(asked.dispatched).toEqual([]);
  });

  /** An agent that started and left no receipt has nothing for a judge to route. */
  it("stops the pass on a design that left no receipt", async () => {
    const { ports: p } = ports({
      draft: async () => ({ stopped: "the runtime exited 1 after 4 turns" }),
    });

    const result = await pass({ ports: p });

    expect(result.steps.map((s) => s.step)).toEqual(["claim", "admit", "prepared", "design", "end"]);
    expect(result.stoppedAt?.ending).toMatchObject({
      ending: "did-not-finish",
      because: "did-not-finish",
    });
    expect(result.routes).toEqual([]);
  });
});

// --------------------------------------------------------------- implement ----

describe("implement is one agent, and it reports the head it committed", () => {
  it("moves the head every step after it is judged against", async () => {
    const judged: { onSha: string; round: number | undefined }[] = [];
    const { ports: p } = ports();

    await pass({
      ports: p,
      recipe: recipeWith({ proposed: [{ name: "check", run: "true" }] }),
      actionsAt: actionsFrom({ proposed: [judging(judged)] }),
    });

    expect(judged.map((j) => j.onSha)).toEqual(["c0mm1tted5ha"]);
  });

  /**
   * Three ways not to pass, and the money is why they are three. This is the one
   * that buys a decision: 0058 §3c's `needs-input`, and the only
   * `did-not-finish` with anywhere to go.
   */
  it("takes an agent that asked to the router, carrying needs-input", async () => {
    const { ports: p } = ports({
      dispatch: async () => ({ asked: "the ticket names two files and neither exists" }),
    });

    const result = await pass({ ports: p });

    expect(result.stoppedAt).toMatchObject({
      step: "implement",
      ending: { ending: "did-not-finish", because: NEEDS_INPUT },
    });
    expect(result.routes).toMatchObject([{ from: "implement", to: "waiting" }]);
    expect(outcomeOf(result)).toBe("blocked");
  });

  /**
   * And this is the one that stands the **conductor** down rather than the pass:
   * what it met is about the account and every queued item would meet it
   * identically (0031 §3), so the item is released and the outcome is `failed`.
   */
  it("keeps an agent that never started apart from one that stopped", async () => {
    const { ports: p, asked } = ports({
      dispatch: async () => ({
        neverStarted: { agent: "claude-code", detail: "Credit balance is too low" },
      }),
    });

    const result = await pass({ ports: p, recipe: recipeWith(AT_END) });

    expect(result.stoppedAt).toMatchObject({
      step: "implement",
      ending: { ending: "never-ran", at: "claude-code", detail: "Credit balance is too low" },
    });
    expect(result.routes).toEqual([]);
    expect(outcomeOf(result)).toBe("failed");
    expect(asked.recorded).toMatchObject([{ outcome: "failed", actions: ["say so"] }]);
  });

  /** A crash, a spent turn budget, or a run that committed nothing — 0057 §2. */
  it("reports an agent that left no receipt as did-not-finish, not a refusal", async () => {
    const { ports: p } = ports({
      dispatch: async () => ({ stopped: "150 turns spent, nothing committed" }),
    });

    const result = await pass({ ports: p });

    expect(result.stoppedAt?.ending.ending).toBe("did-not-finish");
    expect(result.routes).toEqual([]);
    expect(outcomeOf(result)).toBe("blocked");
  });

  /** 0038 §2: the round a pass buys is bought on something, and the agent is told. */
  it("briefs the agent in the round the pass is in", async () => {
    const { ports: p, asked } = ports();

    await pass({ ports: p });

    expect(asked.dispatched[0]?.context.round).toBe(0);
    expect(asked.dispatched[0]?.context.onSha).toBe(tree.baseSha);
  });
});

// ----------------------------------------------------------- sent back again ----

describe("a step the judge sent back is told it was sent back", () => {
  /**
   * **A round costs an agent run, so the second brief must not be the first one.**
   *
   * `Asked` promises the judge at `proposed` may answer a question with *that step
   * again with* state your assumption, and `onOffer` implements it by putting the
   * asking step back on the offer. Nothing else on the brief moves on that edge:
   * `context.recheck` is empty, because a question raised no findings, and
   * `context.onSha` is unchanged, because nothing was committed. So a body that
   * ignored `reached` would hand the agent exactly what produced the question, get
   * the question back, and burn every round in `ceilings.rounds` — with the
   * judge's instruction never reaching the agent it was written for.
   */
  it("tells the agent at implement what it asked and what the judge answered", async () => {
    let asks = 0;
    const { ports: p, asked } = ports({
      dispatch: async () =>
        asks++ === 0
          ? { asked: "the ticket names two files and neither exists" }
          : { committed: "c0mm1tted5ha" },
    });

    const result = await pass({
      ports: p,
      ceilings: ONE_ROUND,
      bodies: { proposed: stateYourAssumption },
    });

    expect(result.routes).toEqual([
      { from: "implement", to: "implement", why: "state your assumption" },
    ]);
    expect(asked.dispatched).toHaveLength(2);
    expect(asked.dispatched[0]?.again).toBeNull();
    expect(asked.dispatched[1]?.again).toEqual({
      why: "state your assumption",
      asked: "the ticket names two files and neither exists",
    });
    // And it is the only thing that differs, which is why it has to be there.
    expect(asked.dispatched[1]?.context.recheck).toEqual([]);
    expect(asked.dispatched[1]?.ticket).toEqual(asked.dispatched[0]?.ticket);
    expect(outcomeOf(result)).toBe("landed");
  });

  /**
   * The same edge at `admit` — where it rides beside the item rather than on a
   * `Brief`, because the worktree a brief carries is what this step makes.
   */
  it("tells admit what it asked and what the judge answered", async () => {
    let cuts = 0;
    const { ports: p, asked } = ports({
      cut: async () => (cuts++ === 0 ? { asked: "which of the two bases did you mean?" } : { worktree: tree }),
    });

    const result = await pass({ ports: p, ceilings: ONE_ROUND, bodies: { proposed: stateYourAssumption } });

    expect(result.routes[0]).toEqual({ from: "admit", to: "admit", why: "state your assumption" });
    expect(asked.admitted).toEqual([
      null,
      { why: "state your assumption", asked: "which of the two bases did you mean?" },
    ]);
    expect(outcomeOf(result)).toBe("landed");
  });

  /** And at `design`, which is the third of 0058 §3b's three that can ask. */
  it("tells design what it asked and what the judge answered", async () => {
    let drafts = 0;
    const { ports: p, asked } = ports({
      draft: async () => (drafts++ === 0 ? { asked: "a schema change or a rename?" } : { document: "" }),
    });

    const result = await pass({ ports: p, ceilings: ONE_ROUND, bodies: { proposed: stateYourAssumption } });

    expect(result.routes[0]).toEqual({ from: "design", to: "design", why: "state your assumption" });
    expect(asked.drafted).toHaveLength(2);
    expect(asked.drafted[0]?.again).toBeNull();
    expect(asked.drafted[1]?.again).toEqual({
      why: "state your assumption",
      asked: "a schema change or a rename?",
    });
  });

  /** And a step reached on the way through is told nothing, because nothing sent it. */
  it("says nothing to a step the pass simply walked into", async () => {
    const { ports: p, asked } = ports();

    await pass({ ports: p });

    expect(asked.admitted).toEqual([null]);
    expect(asked.drafted[0]?.again).toBeNull();
    expect(asked.dispatched[0]?.again).toBeNull();
  });
});

// --------------------------------------------------------------------- end ----

describe("end runs on every ending, and the effects never decide whether it happened", () => {
  it("resolves the declared effects against the outcome the pass reached", async () => {
    const { ports: p, asked } = ports();

    const result = await pass({ ports: p, recipe: recipeWith(AT_END) });

    expect(outcomeOf(result)).toBe("landed");
    expect(asked.recorded).toEqual([
      { workItemId: item.workItemId, at: 0, outcome: "landed", actions: ["close it", "say so"] },
    ]);
    // And it passes: `end` cannot refuse.
    expect(result.steps.at(-1)).toMatchObject({ step: "end", ending: { ending: "passed" } });
  });

  /**
   * **The ending and its resolution are one append or they are a window.**
   *
   * `end-step.ts` states the rule its own example is written to show — *one
   * transaction, so the outcome and its resolution cannot come apart; a crash
   * between two appends is the shape of failure this system exists to make
   * impossible, and the version check that guards the outcome guards both* — and
   * every live resolver keeps it (`run-once.ts:3423`, `:3274`).
   *
   * So the port is handed the outcome beside the resolution, at the version the
   * read expects, and appends `[<the outcome's own event>, ...resolved]` there.
   * Handed only the resolution it could not: the terminal event would be a second
   * append at `at + 1`, and a conductor killed by `runtime.limits.wall` in between
   * leaves an item resolved and never ended — claimed for ever to the work-item
   * fold, invisible to `endedWithoutEndActions`, whose audit is the anti-join the
   * other way, and with its issue already closed by `tell.ts`.
   */
  it("hands the outcome to the same call as the resolution, at the version the read expects", async () => {
    const { ports: p, asked } = ports({ read: async () => claimedAlready });

    const result = await pass({ ports: p, recipe: recipeWith(AT_END) });

    expect(outcomeOf(result)).toBe("landed");
    expect(asked.endings).toEqual([
      { workItemId: item.workItemId, at: claimedAlready.length, outcome: "landed", resolved: 1 },
    ]);
    expect(asked.recorded).toMatchObject([{ at: claimedAlready.length, outcome: "landed" }]);
  });

  it("resolves blocked when a step refused, on the same declared list", async () => {
    const { ports: p, asked } = ports();

    await pass({
      ports: p,
      recipe: recipeWith({ ...AT_END, prepared: [{ name: "install", run: "pnpm install" }] }),
      actionsAt: actionsFrom({
        prepared: [canned("install", { verdict: "failed", evidence: "exited 1", findings: [] })],
      }),
    });

    expect(asked.recorded).toMatchObject([{ outcome: "blocked", actions: ["say so"] }]);
  });

  /**
   * **`when:` is the whole safety of `refs:`** (`#240`): an ending that is not a
   * landing resolves those to nothing, and for an item that did not land they are
   * the only surviving account of what was tried. Nothing downstream re-derives
   * the list, so a body that ran every declared cell on every ending would delete
   * exactly the refs a person needs.
   */
  it("filters the declared list by when, rather than running every cell", async () => {
    const { ports: p, asked } = ports({
      dispatch: async () => ({ stopped: "no receipt" }),
    });

    await pass({
      ports: p,
      recipe: recipeWith({
        end: [
          { name: "keep the refs", refs: true, branch: true, when: "landed" },
          { name: "label it", labels: ["needs-attention"], when: "blocked" },
        ],
      }),
    });

    expect(asked.recorded).toMatchObject([{ outcome: "blocked", actions: ["label it"] }]);
  });

  /**
   * **Resolved once per outcome, off the item's own stream** — so a pass over an
   * item that already resolved this outcome records nothing, and one that resolved
   * a *different* outcome records again. Two different things to have done to an
   * issue.
   */
  it("does not resolve the same outcome twice", async () => {
    const already: Envelope[] = [
      {
        seq: 1,
        streamId: item.workItemId,
        version: 1,
        type: "EndActionsResolved",
        actor: "conductor",
        at: new Date(0),
        schemaVer: 1,
        data: { outcome: "landed", actions: [] },
      } as unknown as Envelope,
    ];
    const { ports: p, asked } = ports({ read: async () => already });

    await pass({ ports: p, recipe: recipeWith(AT_END) });

    expect(asked.recorded).toEqual([]);
  });

  /**
   * **An append that did not happen must not look like one that did** (0016 §4),
   * so this is not swallowed — and it is still not allowed to change what the
   * pass did: the merge landed, `main` moved, and `PassResult.stoppedAt` is
   * never `end`.
   *
   * **And `because` is `NOT_ENDED` rather than `threw`, which is the whole of
   * what saves the item.** One append cannot be made to always happen: the
   * connection drops, or something else appended between the read and the
   * expected-version append. What the body decides is what the caller learns.
   * With a generic crash token the caller reads `outcomeOf(result) === "landed"`,
   * obeys `PassPorts.record`'s *the caller appends no terminal event of its own*
   * and writes nothing — and the stream then holds neither `WorkItemLanded` nor
   * `EndActionsResolved`: the work-item fold still reads the item as claimed so
   * the queue never re-offers it, `endedWithoutEndActions` cannot see it because
   * that anti-join names only items that *ended*, and the issue stays open with
   * `main` moved. `NOT_ENDED` is the instruction to write the bare terminal
   * event, which puts the item in the one window that already has an audit and
   * `lingtai end replay` to repair it.
   */
  it("names the ending it could not write, so the caller writes it", async () => {
    const { ports: p } = ports({
      record: async () => {
        throw new Error("the store would not append");
      },
    });

    const result = await pass({ ports: p, recipe: recipeWith(AT_END) });

    expect(result.stoppedAt).toBeNull();
    expect(outcomeOf(result)).toBe("landed");
    expect(result.steps.at(-1)).toMatchObject({
      step: "end",
      ending: {
        ending: "did-not-finish",
        because: NOT_ENDED,
        at: null,
        detail: expect.stringContaining("the store would not append"),
      },
    });
    // And the detail says which item has no ending and which ending it has not
    // got, because that is what a person reading the run has to act on.
    const ending = result.steps.at(-1)?.ending;
    expect(ending?.ending === "did-not-finish" && ending.detail).toContain(item.workItemId);
    expect(ending?.ending === "did-not-finish" && ending.detail).toContain("landed");
  });

  /**
   * The read is the other half of the same call, and it leaves the stream in the
   * same state: nothing on it. So it carries the same token — a caller that had
   * to tell `read` failing from `record` failing to decide whether to append
   * would be reading two tokens for one question.
   */
  it("says the same when it could not read the stream to resolve against", async () => {
    const { ports: p, asked } = ports({
      read: async () => {
        throw new Error("the store would not answer");
      },
    });

    const result = await pass({ ports: p, recipe: recipeWith(AT_END) });

    expect(outcomeOf(result)).toBe("landed");
    expect(result.steps.at(-1)).toMatchObject({
      step: "end",
      ending: { ending: "did-not-finish", because: NOT_ENDED },
    });
    // Nothing was recorded, which is the state the token is about.
    expect(asked.endings).toEqual([]);
  });

  /**
   * And a pass whose `end` *did* write says nothing of the kind — otherwise the
   * caller would append a second terminal event after every landing, and the
   * token would mean *look at the stream* rather than *nothing reached it*.
   */
  it("says nothing of the kind when the append went through", async () => {
    const { ports: p } = ports();

    const result = await pass({ ports: p, recipe: recipeWith(AT_END) });

    expect(result.steps.at(-1)?.ending).toEqual({ ending: "passed" });
  });

  it("runs once, last, on every one of the endings a pass can reach", async () => {
    const endings: Partial<PassPorts>[] = [
      {},
      { take: async () => ({ passedOver: "no-kind" }) },
      { cut: async () => ({ notCut: "no mirror" }) },
      { dispatch: async () => ({ asked: "which one?" }) },
      { dispatch: async () => ({ neverStarted: { agent: "claude-code", detail: "signed out" } }) },
      { dispatch: async () => ({ stopped: "no receipt" }) },
    ];

    for (const override of endings) {
      const { ports: p } = ports(override);
      const result = await pass({ ports: p, recipe: recipeWith(AT_END) });
      expect(result.steps.filter((s) => s.step === "end")).toHaveLength(1);
      expect(result.steps.at(-1)?.step).toBe("end");
    }
  });
});
