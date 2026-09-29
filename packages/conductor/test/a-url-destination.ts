/**
 * **A second destination, whose locator is a URL** — the scaffolding, and no
 * test in it (`#303`).
 *
 * [0066](../../../doc/decisions/0066-a-large-answer-is-a-locator-on-the-log.md)
 * §4 says the locator is a string the core never parses, and until this file
 * nothing checked it. One destination shipped, `file:`, whose locator is a
 * repository path — so **every path-shaped assumption anywhere in the pipeline
 * is accidentally correct**, and §4 could erode with no test going red.
 *
 * ## Why this is a fixture and not a plugin
 *
 * 0066 §9 itemises what a plugin costs: a column in `step-matrix.test.ts`, a
 * branch in `whyThatPair`, and a page under `doc/plugins/` that `#280`'s test
 * makes a red test rather than a memory. **A destination built to be tested
 * would pay that bill forever for a probe**, and it would be a key nobody ever
 * writes in a recipe — `#61`'s shape, declared and never emitted.
 *
 * So there is no key, no schema and no `at`. This is an `Action` handed to
 * `runPass` through `actionsAt`, which is the seam
 * `unit/what-a-destination-costs.test.ts` already uses for the same reason it
 * gives there: *nothing in the tree can be the subject yet, so what is pinned is
 * what the first one will meet*.
 *
 * ## What it replaces, and why the old check could never have passed
 *
 * 0066 §9's own test was *the second destination: if adding it needs a change in
 * `packages/conductor`, the locator did not stay a string.* Both destinations
 * that landed needed `conduct.ts` — `file:` +90 lines (`819941c`), `file-brief:`
 * +39 (`fa06a7a`) — and the 39 are not a parser but a **port**: `read`, beside
 * `file:`'s `keep`, the way a `confluence:` would want a `fetch`. Every plugin
 * that touches the world outside the pass needs one port from the conductor, and
 * a port is additive. So the diff size measured the wrong thing, and a real
 * second destination measures it *worse* than this does, because the port's
 * lines drown the signal. `unit/a-locator-the-core-did-not-write.test.ts` is
 * what measures it instead, and its header carries the retirement.
 *
 * **What §4 forbids is the core branching on what a locator looks like**, which
 * is a property of the code and is what these two actions make checkable: a
 * string the core did not write, carried in at `design` and read back out at
 * `implement`, with both ends recorded.
 *
 * **What they make checkable is the pass, and not the ports under it.** The two
 * seams below — `actionsAt` and all ten bodies — are exactly what keeps this
 * unit, and exactly what puts `conduct.ts` outside the module graph: nothing
 * here imports it, so a port taught to classify a locator leaves every arm of
 * every comparison identical. That is not a caveat on the retirement, it is
 * half of what replaces it — `readWhatAFileKept` in `src/file-port.ts` is the
 * port as a value a test can call, *hands the locator to the filesystem
 * unclassified* is the `it` that calls it, and *is the port `conduct.ts` wires*
 * is the one that reads the wiring off `conduct.ts` — because a value nothing
 * calls guards nothing. Adding an arm here does not cover either, and never
 * will.
 *
 * ## What it deliberately does not stand in for
 *
 * Two halves of a real cloud destination are **not** simulated here, because
 * simulating them would assert a fixture rather than the system: credentials
 * refused when the recipe resolves ([0021](../../../doc/decisions/0021-the-recipe-decides-the-environment.md)'s
 * layers on their hardest case) and a real network failure, which is the first
 * data on the line 0066 §5 left to measurement — *unreachable* versus *needs a
 * person*. Both belong to the first real cloud destination somebody actually
 * wants.
 *
 * ## Unit, and it stays unit
 *
 * Nothing here opens a file, spawns a process, reads the clock or asks the
 * network; `runPass`'s two seams — the ten bodies and how a declared list
 * becomes runnable actions — are both replaced (0060 §1). That is the property
 * to check before adding to this file.
 */
import { STEPS, type Step } from "@lingtai/domain";
import type { Action, ActionContext, ActionEvent, ActionResult, TheDesign } from "@lingtai/actions";
import { StepMap } from "@lingtai/recipe";
import {
  outcomeOf,
  runPass,
  type PassOptions,
  type StepBodies,
  type StepEnding,
  type StepWork,
} from "../src/pass.ts";

/** The document the destination keeps, and the thing a locator locates. */
export const DOCUMENT = "## The shape\n\nSix bodies, and the fifth is the one that asks.\n";

/** What every step but the two under test answers. */
const PASSED: ActionResult = { verdict: "passed", evidence: "green", findings: [] };

/**
 * **The locator the core did not write**, and the whole point of this file.
 *
 * A URL, so that every path-shaped thing the core could do to it is visible in
 * the string that comes out the other end: `join(cwd, …)` on this produces
 * `/nowhere/https:/Example.INVALID/design/1%20a/` — the doubled slash collapses
 * and so does the `..`, so even a resolve that "worked" is caught. `.invalid` is
 * the reserved TLD (RFC 2606), so a test that accidentally grew a fetch would
 * fail to resolve rather than reach somebody's server.
 *
 * **And it is deliberately not in canonical URL form**, which is the half that a
 * plain `https://example.invalid/design/1` got wrong: a core that parsed the
 * locator and re-serialised it — `new URL(locator).toString()`, the cheapest
 * thing a validating core does — is a no-op on a canonical literal, so the one
 * guard this file exists to provide would have missed it. Four separate
 * rewrites are observable on this string, one per way of parsing:
 *
 * ```
 * Example.INVALID   a lower-cased host        URL, and every HTTP client
 * /v2/..            a normalised `..`         URL, and path.join / path.resolve
 * %20               a percent-decoded space   decodeURIComponent, a naive unescape
 * trailing /        a trimmed slash           the usual "tidy the URL" helper
 * ```
 *
 * `new URL(A_URL).toString()` performs the first two together and is therefore
 * caught; *is a string no round trip through `URL` leaves alone* in
 * `unit/a-locator-the-core-did-not-write.test.ts` pins that, so this literal
 * cannot be tidied into canonical form without a red test saying why not.
 */
export const A_URL = "https://Example.INVALID/design/v2/../1%20a/";

/**
 * **The shape `file:` returns**, as the arm to compare against.
 *
 * The two-arm comparison is not one function here and is worth saying so: the
 * test calls `carry` once per locator and compares the two through
 * `withoutTheLocator` below — *takes the same route through the pass that a
 * repository path takes*, in `unit/a-locator-the-core-did-not-write.test.ts`.
 * `carry` runs a pass; `withoutTheLocator` blanks the locator out of what one
 * recorded. Neither runs both arms, so the claim they make together — *the two
 * differ in the locator string and in nothing else*, which is what *the core
 * does not branch on a locator's shape* means written as something `toEqual`
 * can answer — is the `it`'s and is stated there.
 *
 * It is the literal `file-action.test.ts` uses.
 */
export const A_PATH = "doc/design/x.md";

/**
 * **A cwd the locator has nothing to do with.**
 *
 * `carry` takes it as an argument so that the same URL can be run under two of
 * them: a core that resolved the locator against the worktree would answer
 * differently at each, and a core that treats it as opaque answers identically.
 * That is the direct check on the one line 0066 §4 comes closest to — the
 * conductor's `readFile(join(cwd, spec.path))`, which is legal because it sits
 * inside a port named for one plugin and is handed that plugin's own spec.
 */
export const NOWHERE = "/nowhere";

/**
 * The line a recipe writes to declare each end of a destination, as near as the
 * schema can say it today.
 *
 * `agent:` serves both `design` and `implement` (`agentPlugin.at`), and a real
 * destination's key will not be `agent:` — 0066 §5 makes each destination its
 * own plugin. The key is not what is being measured: the step, the list it sits
 * in and everything the pass does with what it answers are the same whatever
 * word declares it, and those are the subject. `what-a-destination-costs.test.ts`
 * makes the same substitution and says so in the same words.
 */
const DECLARED = {
  design: [{ name: "keep it", agent: "claude-code", prompt: "write the shape down" }],
  implement: [{ name: "read it back", agent: "claude-code", prompt: "build it" }],
};

/**
 * **The destination**: keeps the document nowhere, and answers with the locator
 * it was built with.
 *
 * It is `createFileAction`'s shape with the writing taken out — `document` and
 * `locator` off one result, which is 0069 §5's rule and the reason `designFrom`
 * can read them without deciding which document a location belongs to.
 *
 * **`evidence` does not name the locator, and that is the one place this differs
 * from `file:` on purpose.** The real plugin's card says *wrote a 2.4 kB design
 * to `doc/design/x.md`*, because a person reads the card for the location. Here
 * the locator is kept off `evidence` so that finding it in an emitted event
 * means the **core** put it there — which is what makes *nothing the board folds
 * has parsed it* a fact a test can check rather than a claim about a sentence a
 * plugin chose.
 */
export const keeping = (locator: string): Action => ({
  name: DECLARED.design[0]!.name,
  kind: "agent",
  run: async (): Promise<ActionResult> => ({
    verdict: "passed",
    evidence: "kept the design at the destination",
    findings: [],
    document: DOCUMENT,
    locator,
  }),
});

/**
 * **The reading counterpart**, `file-brief:`'s shape: it is handed a locator,
 * answers with the document and hands the same locator back unchanged.
 *
 * It resolves nothing. A real reading plugin resolves the locator its own
 * destination understands — that is what `whyThePathEscapes` does in
 * `file-brief-action.ts` — and doing it here would make this fixture assert
 * itself. What it records instead is **what it was handed**, which is the far
 * end of the only claim this file exists to support.
 */
export const readingBack = (seen: TheDesign[]): Action => ({
  name: DECLARED.implement[0]!.name,
  kind: "agent",
  run: async (context: ActionContext): Promise<ActionResult> => {
    seen.push(context.design ?? { document: "" });
    return {
      verdict: "passed",
      evidence: "briefed the implementer with what the destination held",
      findings: [],
      document: context.design?.document ?? "",
      ...(context.design?.locator === undefined ? {} : { locator: context.design.locator }),
    };
  },
});

/**
 * The ten bodies, each passing.
 *
 * `proposed` passes rather than routing to a person, so the walk is the ordinary
 * one and `implement` is genuinely reached — `pass.test.ts`'s `THROUGH`, for the
 * reason written there. `NOT_BUILT_YET` cannot be used: its `proposed` takes a
 * refusal to a person, which is right for the router's own tests and would stop
 * this pass before the reading side ever ran.
 */
const PASSING: StepBodies = Object.fromEntries(
  STEPS.map((step) => [step, async (_work: StepWork<Step>): Promise<StepEnding> => ({ ending: "passed" })]),
) as unknown as StepBodies;

/** One visit, flattened to the two facts a route is made of. */
export interface Visit {
  readonly step: Step;
  readonly ending: StepEnding;
}

/** One emitted event, flattened to what a fold off the log would see. */
export interface Emitted {
  readonly type: ActionEvent["type"];
  readonly payload: string;
}

/** What one pass did with one locator — both ends, the route, and the log. */
export interface Carried {
  /** What the destination answered with, verbatim. */
  readonly kept: string;
  /** `StepPassed.design` off the `design` visit — the near end. */
  readonly endedWith: TheDesign | undefined;
  /** `ActionContext.design` at `implement` — the far end. */
  readonly briefed: TheDesign | undefined;
  /** And what `implement`'s own ending carried, which is the return leg. */
  readonly handedBack: TheDesign | undefined;
  readonly outcome: ReturnType<typeof outcomeOf>;
  readonly visits: readonly Visit[];
  readonly events: readonly Emitted[];
}

/**
 * **Runs one pass carrying one locator**, and records both ends of it.
 *
 * The destination is declared at `design` and the reader at `implement`, and
 * both are swapped for the fixtures above by `actionsAt` — so what runs between
 * them is the real `runPass`, the real `runActionPipeline`, the real `designOn`
 * and the real `designFrom`. Those four are the pipeline as far as a locator is
 * concerned, and they are what this is asking a question of.
 */
export async function carry(locator: string, cwd: string = NOWHERE): Promise<Carried> {
  const briefed: TheDesign[] = [];
  const events: Emitted[] = [];
  const at: Record<string, readonly Action[]> = {
    design: [keeping(locator)],
    implement: [readingBack(briefed)],
  };
  const actionsAt: PassOptions["actionsAt"] = (step, actions) =>
    at[step] ?? actions.map((action) => ({ name: action.name, kind: "run" as const, run: async () => PASSED }));

  const result = await runPass({
    recipe: { steps: StepMap.parse(DECLARED) },
    context: { runId: "run-1", onSha: "abc1234def", cwd, env: {} },
    emit: (event) => void events.push({ type: event.type, payload: JSON.stringify(event.data) }),
    actionsAt,
    bodies: PASSING,
  });

  const endingAt = (step: Step): StepEnding | undefined =>
    result.steps.filter((visit) => visit.step === step).at(-1)?.ending;
  const designOn = (step: Step): TheDesign | undefined => {
    const ending = endingAt(step);
    return ending?.ending === "passed" ? ending.design : undefined;
  };

  return {
    kept: locator,
    endedWith: designOn("design"),
    briefed: briefed.at(0),
    handedBack: designOn("implement"),
    outcome: outcomeOf(result),
    visits: result.steps.map((visit) => ({ step: visit.step, ending: visit.ending })),
    events,
  };
}

/**
 * **The route with the locator blanked out** — what two arms must agree on.
 *
 * Every occurrence of the locator is replaced by one token, so what is compared
 * is *the shape of the pass* and not the string it carried. Two arms that agree
 * here differ in the locator and in nothing else: not in which steps ran, not in
 * how any of them ended, not in what reached the log. That is *the core did not
 * branch on the shape*, written as something `toEqual` can answer.
 *
 * The substitution is textual, over the whole structure serialised — which is
 * the point rather than a shortcut. A locator the core edited no longer matches,
 * wherever in the structure it ended up, and an arm holding it under a key the
 * other arm does not have disagrees as well. Neither case needs to be
 * anticipated here.
 */
export function withoutTheLocator(carried: Carried): unknown {
  // Matched as it appears *serialised*, not as it appears in memory, so that a
  // third arm carrying a quote or a backslash still matches itself.
  const written = JSON.stringify(carried.kept).slice(1, -1);
  const blank = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value ?? null).split(written).join("<the locator>"));
  return {
    endedWith: blank(carried.endedWith),
    briefed: blank(carried.briefed),
    handedBack: blank(carried.handedBack),
    outcome: carried.outcome,
    visits: blank(carried.visits),
    events: blank(carried.events),
  };
}
