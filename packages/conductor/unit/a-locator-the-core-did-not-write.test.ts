/**
 * **The core must not branch on a locator's shape** —
 * [0066](../../../doc/decisions/0066-a-large-answer-is-a-locator-on-the-log.md)
 * §4, measured (`#303`).
 *
 * §4 says the locator is a string the core never parses, and until this file
 * nothing checked it. `file:` is the only destination, its locator is a
 * repository path, and so **every path-shaped assumption in the pipeline is
 * accidentally correct**: `join`, `resolve`, a `startsWith("doc/")`, a stat —
 * each would work today and each would close the extension point, with no test
 * going red. The fixture is `test/a-url-destination.ts`; the claim is that a
 * string the core did not write survives the pass untouched.
 *
 * ## 0066 §9's own test is retired here, and why it must not be reinstated
 *
 * §9 says: *the test of whether §4 held is the **second** destination. If adding
 * it needs a change in `packages/conductor`, the locator did not stay a string.*
 *
 * **No destination can meet that, and none ever could.** Both that landed needed
 * `conduct.ts`:
 *
 * ```
 * file:       at design      #300, 819941c   +90
 * file-brief: at implement   #301, fa06a7a   +39
 * ```
 *
 * And the 39 are not a parser, they are a **port**:
 *
 * ```ts
 * const read = async (spec: { readonly path: string }): Promise<ReadAnswer> => {
 *   try { return { document: await readFile(join(cwd, spec.path), "utf8") }; }
 *   catch (error) { return { notRead: (error as Error).message }; }
 * };
 * …
 * fileBrief: { read },
 * ```
 *
 * `file:` got `keep`; `file-brief:` got `read`; a `confluence:` would get a
 * `fetch`. **Every plugin that touches the world outside the pass needs one port
 * from the conductor, and a port is additive rather than a parser** — so the
 * diff size was never a proxy for the property §4 protects, and a *real* second
 * destination measures it worse than this fixture does, because the port's lines
 * drown the signal.
 *
 * **The one line that comes closest is worth naming**, so the next reader does
 * not have to find it: `readFile(join(cwd, spec.path))` — the conductor does know
 * `file-brief`'s locator is a path. That is inside a port named for one plugin,
 * handed that plugin's own spec, so it is not the core learning to classify. A
 * test that asserted *no `join` anywhere near a locator* would be wrong. The
 * assertion has to be about **a locator the core did not write**, which is what
 * every `it` below is.
 *
 * So §9's criterion is retired and this file replaces it. §4 stands unchanged
 * and is what these tests guard; there is no superseding ADR, because a check
 * that measures the wrong thing is a correction to a test rather than to a
 * decision. 0066 §9 carries a note saying so, beside the sentence it corrects —
 * `#299`'s arrangement, and for its reason: a correction that lives only in a
 * second file gets reinstated from the first.
 *
 * ## Broken twice on purpose, and what each break cost
 *
 * A test that guards a negative is worth what it catches, so the core was made
 * to do each of the two forbidden things once and the result recorded here
 * rather than remembered:
 *
 * ```
 * resolve   runStep's context: join(reaching.context.cwd, d.locator)   3 of 4 red
 * classify  designFrom: drop a locator containing "://"                3 of 4 red
 * ```
 *
 * The resolve left `/nowhere/https:/example.invalid/design/1` at both ends — the
 * doubled slash collapsed, which is exactly the quiet corruption a path-shaped
 * core does to a URL — and the classify left the locator off the ending
 * altogether. Both were reverted; neither is in the tree.
 *
 * *reaches no event* stayed green through both, and should: it is a claim about
 * what the core writes to the log, not about what it does with the string in
 * memory. Four `it`s, three claims, and the fourth is the board's.
 *
 * ## What is not checked here, and where it goes instead
 *
 * Credentials refused when the recipe resolves, and a real network failure —
 * 0066 §5's *unreachable* versus *needs a person*, which is left to measurement.
 * Both need a real cloud destination and belong to the first one somebody
 * actually wants. Building one to be tested would buy a page under
 * `doc/plugins/`, a `step-matrix` column and a `whyThatPair` branch forever, paid
 * for a probe — which is the bill 0066 §9 itemises.
 *
 * Unit by 0060 §1: no filesystem, no process, no network, no clock.
 */
import type { TheDesign } from "@lingtai/actions";
import { describe, expect, it } from "vitest";
import {
  A_PATH,
  A_URL,
  DOCUMENT,
  NOWHERE,
  carry,
  withoutTheLocator,
  type Carried,
} from "../test/a-url-destination.ts";

/** Both ends of one pass, which is what every assertion below reads. */
const ends = (carried: Carried): readonly (TheDesign | undefined)[] => [
  carried.endedWith,
  carried.briefed,
  carried.handedBack,
];

describe("a locator the core did not write", () => {
  /**
   * **Byte for byte, at both ends** — the near one is `StepPassed.design` off
   * the `design` visit, and the far one is `ActionContext.design` as the plugin
   * at `implement` was handed it.
   *
   * `toBe` on a string *is* byte equality: it fails on a trimmed slash, a
   * lower-cased host, a normalised `..`, a percent-decoded space. Every one of
   * those is something a core that had learned what a locator is would do, and
   * every one of them is a locator the reading plugin can no longer resolve.
   *
   * The third end is the return leg: `file-brief:` answers with the locator it
   * was handed, unchanged, so the value reaches `implement`'s own ending too and
   * a core that edited it on the way back would be caught there rather than
   * nowhere.
   */
  it("reaches both ends of the pass as the destination wrote it", async () => {
    const carried = await carry(A_URL);

    expect(carried.endedWith).toEqual({ document: DOCUMENT, locator: A_URL });
    expect(carried.briefed).toEqual({ document: DOCUMENT, locator: A_URL });
    for (const end of ends(carried)) expect(end?.locator).toBe(A_URL);
    expect(carried.outcome).toBe("landed");
  });

  /**
   * **The whole claim, as one `toEqual`.**
   *
   * The same pass twice — once carrying a URL, once carrying `file:`'s own
   * repository path — with every occurrence of the locator blanked to one token.
   * What is left is the shape of the pass: which steps ran, how each ended, what
   * each action answered, what reached the log. **They must be identical.**
   *
   * A core that branched on the shape differs here however it branched: a
   * `join(cwd, …)` leaves `/nowhere/https:/example.invalid/design/1` in the URL
   * arm and `/nowhere/doc/design/x.md` in the other, so the token no longer
   * matches and the two blanked routes disagree. A core that dropped a locator
   * it did not recognise leaves `endedWith` with no `locator` key on one arm
   * only. A core that threw on one leaves a different ending. None of them
   * survives this line, and none of them needs its own test.
   *
   * This is the assertion that makes the file worth keeping: it goes red the day
   * something in the core learns to parse, whatever it learned.
   */
  it("takes the same route through the pass that a repository path takes", async () => {
    const [url, path] = await Promise.all([carry(A_URL), carry(A_PATH)]);

    expect(withoutTheLocator(url)).toEqual(withoutTheLocator(path));
  });

  /**
   * **Nothing resolved it against the worktree**, which is the failure the
   * pipeline is closest to having: the conductor genuinely does
   * `readFile(join(cwd, spec.path))`, legally, inside a port named for one
   * plugin and handed that plugin's own spec.
   *
   * Asked by running the same locator under two different `cwd`s. A core that
   * joined would answer differently at each; a core that treats the string as
   * opaque answers identically. That is a sharper question than *does `join`
   * appear anywhere*, and it is the one 0066 §4 actually asks.
   *
   * It is also what says nothing stat'd it. `https://example.invalid/design/1`
   * is not a path that exists under either `cwd`, so a core that stat'd it would
   * throw or report a failure, and the pass would not land.
   */
  it("does not resolve it against the worktree, wherever the worktree is", async () => {
    const elsewhere = "/somewhere/else/entirely";
    const [here, there] = await Promise.all([carry(A_URL, NOWHERE), carry(A_URL, elsewhere)]);

    for (const end of [...ends(here), ...ends(there)]) {
      expect(end?.locator).toBe(A_URL);
      expect(end?.locator).not.toContain(NOWHERE);
      expect(end?.locator).not.toContain(elsewhere);
    }
    expect(withoutTheLocator(here)).toEqual(withoutTheLocator(there));
    expect(here.outcome).toBe("landed");
  });

  /**
   * **And the core wrote it nowhere a replay pays for** (0066 §3, 0069 §6).
   *
   * `WroteTheDesign` is the visit's ending, held in memory; what reaches the log
   * is `evidence`. So the board — `task_view`, a fold over these events — never
   * sees a locator at all, and cannot have parsed one.
   *
   * The fixture's `evidence` names no locator, which is the one place it differs
   * from `file:` on purpose: the real plugin's card says *wrote a 2.4 kB design
   * to `doc/design/x.md`*, because a person reads the card for the location.
   * With the plugin's own sentence carrying none, a locator found in an emitted
   * payload can only have been put there by the core.
   */
  it("reaches no event, so nothing the board folds has parsed it", async () => {
    const carried = await carry(A_URL);

    expect(carried.events.length).toBeGreaterThan(0);
    for (const event of carried.events) expect(event.payload).not.toContain(A_URL);
  });
});
