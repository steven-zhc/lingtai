/**
 * **A hundred and ten cells, and each one runs or refuses by name.** There
 * is no third answer, and for a year ten of them gave it: an action at `admit`, or
 * anything but an effect at `end`, was accepted by the schema, resolved into
 * `GatesResolved`, printed by `lingtai add`, drawn on the board, and never
 * called (`#61`).
 *
 * **It was thirty until the vocabulary went from five names to ten** (0058 §3),
 * sixty until the closed set grew `worktree:` and `merge:` (`#235`), eighty
 * until it grew `queue:` and `assignee:` (`#236`), a hundred until it grew
 * `judge:` (`#238`) and a hundred and twenty until it grew `backlog:` (`#237`)
 * — and a hundred and ten again when 0063 §3 made `assignee` a field of
 * `queue:` rather than a plugin beside it (`#244`). **A column that goes is
 * the same event as a column that arrives**: the cells it had have to stop
 * existing rather than stop being walked.
 * Eleven of the hundred and ten cells run and **ninety-nine
 * refuse**; sixty-six of those are the six steps with no call site, and
 * fifty are the five plugins no step reads — overlapping each other by
 * thirty, because a `worktree:` action at `design` is both at once.
 *
 * That is the property this file is here to hold, and it holds it down both
 * axes: **naming a thing is not wiring it.** The five steps 0058 named and the
 * pipeline has not yet constructed must refuse every kind until it has, and the
 * five plugins that are names for code the conductor calls itself must be
 * refused at every step until the recipe is what tells it to. A `design:` block
 * a recipe could write and nothing would run is `#61` with a new spelling; so
 * is a `worktree:` one, and so is a `backlog:` one.
 *
 * This walks every step × kind pair and asserts one of exactly two things:
 *
 * - **runs** — the thing that consumes that point builds a gate for it, with
 *   the dependencies that point's own call site supplies; or
 * - **refuses** — the recipe does not resolve, and the refusal names the
 *   action, its kind, the point and why.
 *
 * It is the thing that keeps `doc/reference.md`'s matrix true: the last
 * hand-maintained copy of it was wrong about `merge` within three weeks of
 * being written, which is why the last test here reads the document and
 * compares it to `KINDS_AT` rather than trusting it.
 */
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { type Finding, SEVERITIES, STEPS, type Severity, type Step } from "@lingtai/domain";
import {
  type ActionKind,
  type GateAction,
  StepMap,
  KINDS_AT,
  PLUGINS,
  whyNoKindAt,
} from "@lingtai/recipe";
import {
  type AgentGateDeps,
  GateActionUnavailableError,
  type GateDeps,
  gatesFromRecipe,
  verdictFor,
} from "@lingtai/actions";
import { resolveEndActions } from "../src/end-point.ts";
import { BUILT_IN_FOR } from "../src/judge.ts";
import { decideBacklog } from "../src/backlog.ts";

/**
 * The closed set's kinds, one action each, exactly as a resolved recipe would
 * hold them — **and the last five are actions no resolved recipe can hold**,
 * because `worktree:`, `merge:`, `queue:`, `judge:` and
 * `backlog:` are refused at all ten steps. That is the point of writing them: the cell has to be
 * *refused by name* rather than *unrepresentable*, and an action the schema
 * never sees is a column this file would walk with nothing in it.
 */
const ACTION: Record<ActionKind, GateAction> = {
  run: { name: "build", run: "pnpm verify", timeout: "15m", env: [] },
  agent: { name: "review", agent: "claude-code", prompt: "read the diff" },
  watch: { name: "tamper", watch: ["**/gates.yml"], then: "fail" },
  human: { name: "approve", human: "merge this?" },
  close: { name: "close the ticket", close: true, when: "landed" },
  labels: { name: "label it", labels: ["shipped"], when: "any" },
  worktree: { name: "cut the branch", worktree: { base: "main", submodules: false } },
  merge: { name: "land the branch", merge: { strategy: "merge-commit" } },
  queue: {
    name: "what this machine works on",
    queue: {
      kinds: ["bug", "feature"],
      exclude: ["agent:hold"],
      backoff: "1h",
      // `assignee:` was a twelfth column until 0063 §3 made it this plugin's
      // fourth field (`#244`), so the cell it had is gone and what it decides
      // is walked here instead.
      assignee: { login: "steven-zhc", take: "mine" },
    },
  },
  judge: { name: "the lines or the approach", judge: "claude-code", when: "findings" },
  backlog: { name: "the minors", backlog: "minor" },
};

/** One finding of a given severity, with a scenario, so only the severity varies. */
function finding(severity: Severity): Finding {
  return {
    file: "src/a.ts",
    line: 1,
    claim: "the name is wrong",
    failureScenario: "a reader looks for it under the other name and does not find it",
    severity,
  };
}
/**
 * **The columns are the closed set's, in the closed set's order** (`#228`).
 *
 * Read off `PLUGINS` rather than off the object above, so the matrix, this
 * file's every case and `doc/reference.md`'s table all widen together the day a
 * seventh plugin lands — 0059 §5's *the document cannot drift from the code
 * without a red test*, now that the code has one list of plugins to drift from.
 * A plugin added with no row here has no `ACTION` either, and the case below
 * says so by name rather than the matrix quietly walking six of seven.
 */
const KINDS = PLUGINS.map((plugin) => plugin.key);

/**
 * What each gating point hands `gatesFromRecipe`, which is the other half of
 * what it can run: `prepared` gets an environment resolver and nothing else,
 * because there is no diff there for a reviewer to read or globs to match.
 *
 * Pinned against `run-once.ts` itself below, so this cannot drift from the
 * call sites it is describing without a red test.
 */
const EVERY_DEP: GateDeps = {
  env: () => ({}),
  // Built, never run — building is the whole of what this file asserts.
  agent: {} as unknown as AgentGateDeps,
  watch: { changedFiles: async () => [] },
};
const DEPS: Record<"prepared" | "proposed" | "merge", GateDeps> = {
  prepared: { env: () => ({}) },
  proposed: EVERY_DEP,
  merge: EVERY_DEP,
};

/**
 * The steps something actually constructs a pipeline for.
 *
 * **Compared against the conductor's whole `src/` tree** by *is read off the
 * conductor's own source* below, which is what stops it being a list somebody
 * keeps: a `gatesFromRecipe` call site anywhere under `packages/conductor/src`
 * is a red test here rather than a matrix that goes on refusing a step the
 * code has started running. That is `#61` inverted, and it is exactly what
 * 0058's own plan will do — it builds `build` and `review`, and a pipeline
 * constructed in a new module would not have moved a count pinned against
 * `run-once.ts` alone.
 */
const HAS_A_CALL_SITE = ["prepared", "proposed", "merge", "end"] as const;

/** Does the code that consumes this step actually dispatch this action? */
function runsAt(point: Step, kind: ActionKind): boolean {
  if (!(HAS_A_CALL_SITE as readonly string[]).includes(point)) {
    // Nothing constructs a pipeline at `claim`, `admit`, `design`, `implement`,
    // `build` or `review`: no call site, nothing to ask. Five of those six are
    // named by 0058 §3 and built by its next ticket; `admit` has been in the
    // closed set since 0016 with nothing behind it.
    return false;
  }
  // A throw is a refusal and not a run, which is the answer this asks for; the
  // refusals themselves are asserted by name below.
  try {
    if (point === "end") {
      const resolved = resolveEndActions([], [ACTION[kind]], "landed");
      const named = (resolved[0]?.data as { actions: { name: string }[] } | undefined)?.actions ?? [];
      return named.some((a) => a.name === ACTION[kind].name);
    }
    return gatesFromRecipe(point, [ACTION[kind]], DEPS[point as keyof typeof DEPS]).some(
      (gate) => gate.name === ACTION[kind].name,
    );
  } catch {
    return false;
  }
}

/** Does a recipe naming this action at this point resolve? */
function accepted(point: Step, kind: ActionKind): string | null {
  const parsed = StepMap.safeParse({ [point]: [ACTION[kind]] });
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "refused with no message");
}

describe("every step × kind cell runs or refuses", () => {
  const cells = STEPS.flatMap((point) => KINDS.map((kind) => [point, kind] as const));

  /**
   * **The size of the matrix is the closed set's, and it is read rather than
   * remembered.** A plugin added to `PLUGINS` with no action above walks in as
   * a column with nothing to try, and every cell of it would pass by being
   * `undefined` — which is the silent half `#61` is about, arriving through the
   * test rather than through the schema.
   */
  it("has one column per plugin and one action for each", () => {
    expect(Object.keys(ACTION)).toEqual([...KINDS]);
    expect(cells).toHaveLength(STEPS.length * PLUGINS.length);
    for (const kind of KINDS) {
      expect(ACTION[kind], `no action for the "${kind}" plugin`).toBeDefined();
    }
  });

  it.each(cells)("%s × %s", (point, kind) => {
    const refusal = accepted(point, kind);
    if (refusal === null) {
      // Accepted, so it must run. This is the half `#58` and `#61` are about:
      // a recipe the log says was resolved, and a point that never called it.
      expect(whyNoKindAt(point, kind)).toBeNull();
      expect(runsAt(point, kind), `${point} accepts a ${kind} action and nothing runs it`).toBe(
        true,
      );
      return;
    }
    // Refused, so it must refuse by name — the action, its kind, the point, and
    // a reason about the point rather than about a missing dependency.
    expect(refusal).toContain(`"${ACTION[kind].name}"`);
    expect(refusal).toContain(`"${kind}"`);
    expect(refusal).toContain(`"${point}"`);
    expect(whyNoKindAt(point, kind)).not.toBeNull();
    expect(runsAt(point, kind)).toBe(false);
  });

  /**
   * The same refusal one level down, for a caller that builds actions in code
   * rather than reading a recipe — `lingtai doctor`, a test, a future plugin
   * host. 0015's first extension power is a gate action at a point, and it has
   * to answer the same at both doors.
   */
  it.each(
    (["prepared", "proposed", "merge"] as const).flatMap((point) =>
      KINDS.filter((kind) => whyNoKindAt(point, kind) !== null).map(
        (kind) => [point, kind] as const,
      ),
    ),
  )("gatesFromRecipe refuses %s × %s by name", (point, kind) => {
    expect(() => gatesFromRecipe(point, [ACTION[kind]], DEPS[point])).toThrow(
      GateActionUnavailableError,
    );
    expect(() => gatesFromRecipe(point, [ACTION[kind]], DEPS[point])).toThrow(
      new RegExp(`"${kind}" at the "${point}" point`),
    );
  });

  /**
   * **And the fourth door, which is the one `runsAt` cannot watch.** `end`'s
   * consumer is `resolveEndActions` rather than `gatesFromRecipe`, and for it
   * a throw and a silent drop are the same answer — `runsAt` returns false for
   * both, so the cell above passes either way. Every refused kind has to
   * *throw* here, and that is the assertion the row above cannot make.
   *
   * It is not hypothetical. `judge:` is the first plugin outside the two
   * effects to declare a `when:` field (`#238`), and while the guard read
   * `"when" in a` a judge action built in code went past it into the match on
   * the outcome, where `findings` equals neither the outcome nor `any`: `end`
   * resolved, wrote an empty list, and the log said nothing had been declared.
   * That is `#61` for one kind. The guard asks for `KINDS_AT.end`'s two keys
   * instead, so a sixth plugin spelling `when:` is refused rather than dropped.
   */
  it.each(KINDS.filter((kind) => whyNoKindAt("end", kind) !== null))(
    "resolveEndActions refuses end × %s by name, rather than dropping it",
    (kind) => {
      expect(() => resolveEndActions([], [ACTION[kind]], "landed")).toThrow(
        new RegExp(`"${kind}" at the "end" point`),
      );
      expect(() => resolveEndActions([], [ACTION[kind]], "landed")).toThrow(
        new RegExp(`"${ACTION[kind].name}"`),
      );
    },
  );

  /**
   * And the keys that guard reads are the row, not a second list beside it: a
   * kind added to `KINDS_AT.end` whose key `end-point.ts` does not test would
   * be accepted by the schema and thrown out by the point.
   */
  it("refuses at `end` exactly the kinds `KINDS_AT` says it does not run", () => {
    expect(KINDS_AT.end).toEqual(["close", "labels"]);
    for (const kind of KINDS) {
      const resolve = () => resolveEndActions([], [ACTION[kind]], "landed");
      if ((KINDS_AT.end as readonly ActionKind[]).includes(kind)) {
        expect(resolve, kind).not.toThrow();
      } else {
        expect(resolve, kind).toThrow();
      }
    }
  });

  /**
   * **`prepared`'s three refusals are about the point, not about the caller.**
   *
   * The reason is worth pinning rather than just the refusal: `agent:` and
   * `watch:` used to say "no reviewer was supplied", which is a fact about the
   * dependencies `run-once.ts` happens to pass and reads as something that
   * could be fixed by passing them. It cannot: nothing has been committed yet.
   * `human:` is the one that cost a review round — a hold there is turned into
   * a release (`run-once.ts`, section 7), so the person is asked a question
   * that re-asks itself every pass and can never be answered.
   */
  it("says why `prepared` is narrower than `proposed`", () => {
    expect(whyNoKindAt("prepared", "agent")).toMatch(/nothing has been committed/);
    expect(whyNoKindAt("prepared", "watch")).toMatch(/nothing has been committed/);
    expect(whyNoKindAt("prepared", "human")).toMatch(/released back to the queue/);
    expect(whyNoKindAt("prepared", "run")).toBeNull();
  });

  /**
   * **`claim`'s plugin reduces the other way, and the refusal is the only
   * place that says so today** (`#236`).
   *
   * 0061 §2 gives the ordering to the workflow and the *reduction* to the step:
   * at `prepared` a list means every action must pass, and at `claim` it means
   * the first plugin that yields a work item wins. Nothing reads `queue:`
   * yet — `whyNoKindAt` refuses it at all ten steps — so the one
   * moment a person meets it is the refusal, and a reader who has just read
   * `prepared`'s row will otherwise carry that step's reduction across and
   * write the list in an order that means the opposite of what they meant.
   *
   * **0061 §§2–3 used `queue:` and `assignee:` as the worked example, and 0063
   * §3 took the example rather than the rule** (`#244`): `assignee` is one of
   * `queue:`'s four fields now, so what a `claim` list reduces over is several
   * `queue:` entries, and the one refusal names both halves of what the queue
   * does today.
   *
   * Pinned here rather than left as prose because it is the half that is *not*
   * a fact about today's code: the two file references below
   * would go red the day `discover.ts` moved, and this sentence would not.
   */
  it("says how `claim` reduces its plugin, and where it runs today", () => {
    const why = whyNoKindAt("claim", "queue");
    expect(why, "`queue:` is no longer refused at claim").not.toBeNull();
    expect(why).toContain("the first plugin that yields a work item");
    expect(why).toContain("rather than requiring every one to pass");
    expect(why).toContain("`prepared`");
    expect(why).toContain("reordering the list is how a person changes priority");
    // And the same sentence at every other step, because the refusal is a
    // fact about the plugin and not about the step it was written at.
    for (const step of STEPS) expect(whyNoKindAt(step, "queue")).toBe(why);

    expect(why).toContain("packages/conductor/src/discover.ts");
    // `assignee`'s half, which used to be a refusal of its own.
    expect(why).toContain("assigneeSkip");
    expect(why).toContain("packages/conductor/src/claim.ts");
  });

  /**
   * **`proposed`'s judges reduce by `when:`, and the refusal carries the rule
   * that costs money if it is got wrong** (`#238`).
   *
   * The reduction is the same kind of sentence `claim`'s is — one entry per
   * direction, matched against the reason the last step gave, rather than every
   * entry having to pass — but the clause worth pinning is the other one: **the
   * workflow counts and the judge chooses** (0061 §3). A judge that could carry
   * its own `rounds` could answer *back to `implement`* for ever and nothing
   * would report a fault, so the refusal a person meets says which side of the
   * line the ceilings are on, and names the module that computes the set.
   */
  it("says how `proposed` will reduce its judges, and who counts", () => {
    const why = whyNoKindAt("proposed", "judge");
    expect(why, "`judge:` is no longer refused at proposed").not.toBeNull();
    expect(why).toContain("the workflow counts, the judge chooses");
    expect(why).toContain("one judge per direction");
    expect(why).toContain("refused by name");
    expect(why).toContain("not only on what is left to spend");
    // Where the decision is made today, and where the set it will be handed
    // already is — both file references, so they go red if either moves.
    expect(why).toContain("packages/conductor/src/fix.ts");
    expect(why).toContain("packages/conductor/src/restart.ts");
    expect(why).toContain("packages/conductor/src/judge.ts");
    // A fact about the plugin, so it is the same sentence at all ten steps.
    for (const step of STEPS) expect(whyNoKindAt(step, "judge")).toBe(why);
  });

  /**
   * **And the plugin beside it that decides nothing about where the pass goes**
   * (`#237`).
   *
   * `judge:` and `backlog:` will both be written under `proposed`, and a reader
   * who has just read the judge's refusal will carry *this decides the next
   * step* across. It does not: **a step may hold plugins that route and plugins
   * that only act**, and this one is an effect like `end`'s two. The clause
   * that earns the assertion is the money one read the other way round — at or
   * below the bar a finding **buys no round**, because a finding that did not
   * refuse is not a refusal and nothing downstream is ever asked about it.
   *
   * Nearly half of everything a reviewer says arrives there (012 §4), so a
   * recipe that raised the bar believing it bought a round per finding would be
   * sizing its spend off the wrong half of the output.
   */
  it("says how `proposed` will file at or below the bar, and that it routes nothing", () => {
    const why = whyNoKindAt("proposed", "backlog");
    expect(why, "`backlog:` is no longer refused at proposed").not.toBeNull();
    expect(why).toContain("buys no");
    expect(why).toContain("routes nothing");
    expect(why).toContain("plugins that route and plugins that only act");
    // Where the bar is decided today, and where it is a function a recipe will
    // hand a value to — both file references, so they go red if either moves.
    expect(why).toContain("packages/projector/src/backlog.ts");
    expect(why).toContain("packages/conductor/src/backlog.ts");
    // **And the half a reader of the fold alone would miss.** The bar is one
    // comparison written in two packages: the fold decides what is *filed*, and
    // `verdictFor` decides what *refuses*. An implementer who follows this
    // refusal, replaces the fold's literal and stops leaves `verdictFor`
    // returning `failed` for a major — `GateFailed`, no filing, a fix round
    // bought — under a recipe that reads as honoured. The refusal has to name
    // it, so this asserts it does.
    expect(why).toContain("verdictFor");
    expect(why).toContain("packages/actions/src/agent-gate.ts");
    // And the dedup nobody has to build: the refusal says why a second round
    // does not file a second entry, which is the Done-when this ticket asserts
    // against today's behaviour rather than adding machinery for.
    expect(why).toContain("packages/domain/src/backlog.ts");
    // A fact about the plugin, so it is the same sentence at all ten steps.
    for (const step of STEPS) expect(whyNoKindAt(step, "backlog")).toBe(why);
  });

  /**
   * **The two halves of *a severity is an outcome*, asserted where the matrix
   * can see them** (`#237`).
   *
   * `decideBacklog` is the bar as a function, and the property the plugin
   * exists to make configurable is that the two answers are one fact: what is
   * filed is exactly what did not refuse, and `buysARound` is false when
   * nothing did.
   *
   * **Parameterised over the whole ladder, and that is a weaker claim than it
   * reads as.** Every bar in `SEVERITIES` is tried and each finding gets its
   * rung from `indexOf`, so a fourth severity added to the enum holds here *by
   * construction* — this file stays green and says nothing about whether the
   * rest of the code met it. What says that is the ladder's consumers, walked
   * against `SEVERITIES` in `packages/actions/unit/agent-gate.test.ts` and
   * `packages/conductor/unit/fix.test.ts`. This test asserts the bar; those
   * assert that there is one ladder to put a bar on.
   */
  it("files at or below the bar, and nothing filed buys a round", () => {
    for (const bar of SEVERITIES) {
      const all = SEVERITIES.map(finding);
      const { filed, refuses, buysARound } = decideBacklog(all, bar);
      expect([...filed, ...refuses].length, bar).toBe(all.length);
      expect(filed.every((f) => SEVERITIES.indexOf(f.severity) >= SEVERITIES.indexOf(bar)), bar).toBe(true);
      expect(buysARound, bar).toBe(refuses.length > 0);
      // The whole of *buys no round*: nothing at or below the bar refuses, so
      // a run whose findings are all filed has no refusal to buy one with.
      expect(decideBacklog(filed, bar).buysARound, bar).toBe(false);
    }
    // And the default is today's fold: a `minor` is filed, a `major` is not.
    expect(decideBacklog([finding("minor")]).buysARound).toBe(false);
    expect(decideBacklog([finding("major")]).buysARound).toBe(true);
  });

  /**
   * **And the same bar, read off the half that actually refuses** (`#237`).
   *
   * `decideBacklog`'s default and `verdictFor` in
   * `packages/actions/src/agent-gate.ts` are one comparison written twice, in
   * two packages that cannot see each other — so the only thing keeping them
   * the same rule is this assertion. It is what makes *both halves take the
   * recipe's value or neither does* checkable rather than a sentence in a
   * refusal: move one bar and this goes red naming the severity that now
   * disagrees.
   */
  it("agrees, severity by severity, with the half of the bar that refuses", () => {
    for (const severity of SEVERITIES) {
      const one = [finding(severity)];
      expect(decideBacklog(one).buysARound, severity).toBe(verdictFor(one) === "failed");
    }
    expect(verdictFor([])).toBe("passed");
    expect(decideBacklog([]).buysARound).toBe(false);
  });

  /**
   * The deps in this file are a copy of what `run-once.ts` passes, and a copy
   * is a thing to keep correct. Read rather than reasoned about: narrowing
   * `proposed`'s deps would leave the schema accepting an `agent:` action that
   * refused mid-pass and released the item, which is the failure this whole
   * file exists to make impossible.
   */
  it("is the deps run-once passes at each point", async () => {
    const src = await readFile(new URL("../src/run-once.ts", import.meta.url), "utf8");
    expect(src).toMatch(/gatesFromRecipe\(\s*"prepared",\s*recipe\.steps\.prepared,\s*\{\s*env:/);
    expect(src).toMatch(/gatesFromRecipe\(\s*"proposed",\s*recipe\.steps\.proposed,\s*gateDeps\s*\)/);
    expect(src).toMatch(/gatesFromRecipe\(\s*"merge",\s*recipe\.steps\.merge,\s*gateDeps\s*\)/);
    // And nowhere else *in this file*: a fourth call site here is a point this
    // test does not know about, judging with deps it has not been told. The
    // whole tree is the next test's.
    expect(src.match(/gatesFromRecipe\(/g)?.length).toBe(3);
  });

  /**
   * **`HAS_A_CALL_SITE` is read, not kept**, and the reading is over every
   * file under `packages/conductor/src` rather than the one module that
   * happens to hold the call sites today.
   *
   * The matrix, `doc/reference.md` and `KINDS_AT` all refuse a `build:` action
   * because nothing constructs a pipeline at `build`. When 0058's plan builds
   * that step, it may well construct it somewhere other than `run-once.ts` —
   * and a count pinned against `run-once.ts` alone would stay 3, every test
   * here would stay green, and the recipe would go on refusing an action at a
   * step the code had started running. That is `#61` with the sign flipped,
   * and this file exists to make it a red test.
   *
   * `end` by its resolver and not by `gatesFromRecipe`: its actions are
   * effects, so the thing that is proof the step is built is
   * `resolveEndActions` existing, which is what `runsAt` calls for it.
   */
  it("is read off the conductor's own source, not kept by hand", async () => {
    const src = new URL("../src/", import.meta.url);
    // Recursive, because "the module the call sites are in today" is exactly
    // the assumption this test exists to stop being made.
    const files = (await readdir(src, { recursive: true })).filter((f) => f.endsWith(".ts"));
    const built = new Set<string>();
    let calls = 0;
    let literals = 0;

    for (const file of files) {
      const text = await readFile(new URL(file, src), "utf8");
      calls += text.match(/gatesFromRecipe\(/g)?.length ?? 0;
      for (const m of text.matchAll(/gatesFromRecipe\(\s*"([a-z]+)"/g)) {
        literals += 1;
        built.add(m[1]!);
      }
      if (/export function resolveEndActions\b/.test(text)) built.add("end");
    }

    // A call site whose point is a variable would be invisible to the regex
    // above, so the two counts have to agree before the set means anything.
    expect(literals, "a gatesFromRecipe call site names its step with a variable").toBe(calls);
    expect(
      [...built].sort(),
      "HAS_A_CALL_SITE is stale — the matrix, doc/reference.md and KINDS_AT move with it",
    ).toEqual([...HAS_A_CALL_SITE].sort());
  });
});

/**
 * `doc/reference.md` carries the matrix, and this is what keeps it true.
 *
 * Checked rather than generated because the document is prose around the table
 * and the reasons matter as much as the ticks — but the ticks themselves are
 * `KINDS_AT`'s, cell for cell, and a document that disagrees is the document
 * that is wrong.
 */
describe("doc/reference.md's matrix", () => {
  const RUNS = "✅";
  const REFUSES = "✋";

  it("says what the code does, cell for cell", async () => {
    const doc = await readFile(new URL("../../../doc/reference.md", import.meta.url), "utf8");
    const rows = new Map<string, string[]>();
    // The row's own label plus one cell per plugin, read off `PLUGINS` like
    // everything else here: a seventh and eighth column arrived with `#235`,
    // a ninth and tenth with `#236` and an eleventh with `#238`, one of the
    // tenth's two went again with `#244`, and a width
    // written as `7` would have gone on matching the six-wide table it was no
    // longer about and reported *no table at all*.
    const width = KINDS.length + 1;
    let header: string[] | null = null;
    for (const line of doc.split("\n")) {
      const cells = line.trim().startsWith("|")
        ? line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim())
        : null;
      if (cells === null) continue;
      if (cells.length === width && cells.slice(1).join(" ") === KINDS.map((k) => `\`${k}:\``).join(" ")) {
        header = cells;
        continue;
      }
      if (header === null) continue;
      const point = cells[0]?.replace(/[`*]/g, "");
      if (cells.length === width && STEPS.includes(point as Step)) {
        rows.set(point!, cells.slice(1));
      }
    }

    expect(header, "no point × kind table in doc/reference.md").not.toBeNull();
    expect([...rows.keys()]).toEqual([...STEPS]);
    for (const point of STEPS) {
      const drawn = rows.get(point)!;
      KINDS.forEach((kind, i) => {
        const runs = whyNoKindAt(point, kind) === null;
        expect(drawn[i]?.replace(/[`*]/g, ""), `${point} × ${kind} in doc/reference.md`).toBe(
          runs ? RUNS : REFUSES,
        );
      });
    }

    // **And the sentence above the table, which nothing checked.** It said
    // *thirty-six of the sixty are refusals* — the contribution of the six
    // steps with no call site, not the total — while the table below it drew
    // forty-nine, so a reader auditing the closed set counted one number
    // against another and concluded the code or the table had drifted.
    const refusals = STEPS.flatMap((point) =>
      KINDS.map((kind) => whyNoKindAt(point, kind)),
    ).filter((why) => why !== null).length;
    expect(refusals).toBe(99);
    expect(
      doc,
      "doc/reference.md's prose count of the refusals no longer matches whyNoKindAt",
    ).toContain("**Ninety-nine of the\nhundred and ten are refusals**");
  });

  /**
   * **The other table, whose `Needs` column is what a person budgets from.**
   *
   * The kind table is read before the matrix and before the prose, and it said
   * a judge wants an agent *for four of the five directions* while
   * `BUILT_IN_FOR` and the prose two hundred lines lower said two of the five
   * are answered by `same-worktree` and spend nothing. Somebody sizing what
   * judges cost reads the first of those and writes an entry too many, which
   * is a cell nothing walked — the matrix test above reads the ticks and never
   * this column.
   *
   * Derived rather than compared to a literal: the numeral comes from counting
   * the directions with no built-in, so the day a third one gets one the
   * document is red rather than quietly a direction out.
   */
  it("says how many directions a judge needs an agent for", async () => {
    const doc = await readFile(new URL("../../../doc/reference.md", import.meta.url), "utf8");
    const NUMERAL = ["none", "one", "two", "three", "four", "five"] as const;
    const spendsAnAgent = Object.values(BUILT_IN_FOR).filter((built) => built === null).length;
    expect(
      doc,
      "doc/reference.md's `judge:` row disagrees with BUILT_IN_FOR about what a judge costs",
    ).toContain(`for ${NUMERAL[spendsAnAgent]} of the five directions an agent`);
  });
});
