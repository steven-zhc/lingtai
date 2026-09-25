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
import { STEPS, type Envelope, type PayloadOf, type ToAppend } from "@lingtai/domain";
import type { Action, ActionContext, ActionEvent, ActionResult } from "@lingtai/actions";
import { StepMap } from "@lingtai/recipe";
import type { Worktree } from "@lingtai/repo";
import { describe, expect, it } from "vitest";
import type { TerminalOutcome } from "../src/end-step.ts";
import {
  bodiesFor,
  type Brief,
  type Claimed,
  type Cut,
  type Drafted,
  type PassPorts,
  type Taken,
  type Ticket,
  type Worked,
} from "../src/pass-steps.ts";
import { NEEDS_INPUT, outcomeOf, runPass, type PassOptions } from "../src/pass.ts";

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
  drafted: Brief[];
  dispatched: Brief[];
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
 */
function ports(overrides: Partial<PassPorts> = {}): { ports: PassPorts; asked: Asked } {
  const asked: Asked = { took: 0, cut: [], drafted: [], dispatched: [], recorded: [] };
  const ordinary: PassPorts = {
    take: async (): Promise<Taken> => {
      asked.took += 1;
      return { taken: item };
    },
    cut: async (claimed): Promise<Cut> => {
      asked.cut.push(claimed);
      return { worktree: tree };
    },
    draft: async (brief): Promise<Drafted> => {
      asked.drafted.push(brief);
      // Every pass today: nothing writes a design yet, so the step produces none.
      return { document: "" };
    },
    dispatch: async (brief): Promise<Worked> => {
      asked.dispatched.push(brief);
      return { committed: "c0mm1tted5ha" };
    },
    // An item with nothing on its stream yet, which is what makes the version
    // the append expects zero.
    read: async (): Promise<readonly Envelope[]> => [],
    record: async ({ claimed, at, resolved }) => {
      for (const appended of resolved) {
        asked.recorded.push({ workItemId: claimed.workItemId, at, ...resolvedIn(appended) });
      }
    },
  };
  return { ports: { ...ordinary, ...overrides }, asked };
}

/** One pass, with the six real bodies and the four the skeleton still has. */
const pass = (
  options: Partial<PassOptions> & { ports: PassPorts },
) => {
  const { emit } = events();
  return runPass({
    recipe: recipeWith({}),
    context,
    emit,
    actionsAt: actionsFrom(),
    ...options,
    bodies: bodiesFor(options.ports),
  });
};

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

  /** And a recipe that declares nothing at `end` records nothing (`end-step.ts`). */
  it("records no resolution where nothing was declared at end", async () => {
    const { ports: p, asked } = ports();

    const result = await pass({ ports: p });

    expect(result.steps.at(-1)).toMatchObject({ step: "end", ending: { ending: "passed" } });
    expect(asked.recorded).toEqual([]);
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
    expect(asked.recorded).toEqual([]);
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
   * **A resolution that did not happen must not look like one that did**
   * (0016 §4), so this is not swallowed — and it is still not allowed to change
   * what the pass did: the merge landed, `main` moved, and `PassResult.stoppedAt`
   * is never `end`.
   */
  it("reports its own failure as its own ending, and leaves the landing alone", async () => {
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
        because: "threw",
        detail: expect.stringContaining("the store would not append"),
      },
    });
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
