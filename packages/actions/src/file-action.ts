/**
 * The file action: **where a design lands, as a plugin rather than as a place
 * the core knows about**
 * ([0066](../../../doc/decisions/0066-a-large-answer-is-a-locator-on-the-log.md)
 * §5, `#300`).
 *
 * It is the first *destination*. Every other action judges something already
 * there or makes something the pass then works in; this one takes what the step
 * before it in the same list produced and **keeps it**, then answers with the
 * path — which is the locator 0066 §3 buys, and what **this action's own**
 * `evidence` carries in place of the document.
 *
 * **It does not take the document off the log, and 0066 §1 is not closed here.**
 * The drafter is a second action at the same step with a `StepPassed` of its
 * own, and `createDraftAction` still writes the document into that one
 * (`agent-action.ts`, through `boundedEvidence`). §1's *uncapped* has been
 * answered since 0066 §8 — `command.ts`'s 60 lines and 8,000 bytes, pinned by
 * `agent-action.test.ts`'s *clips a design document, and leaves the document
 * itself whole* — so what is left is a clipped copy of the document on an event,
 * replayed with every rebuild. This key buys the locator and a copy somebody can
 * read after the pass; whether a drafter whose document a destination kept should
 * say a sentence instead is a change to `createDraftAction`, and is not made by
 * this file. `file-action.test.ts`'s *the drafter's own event still carries the
 * document* is what keeps that measured rather than remembered.
 *
 * **It writes and it does not decide.** `design` is not one of `REFUSING_STEPS`
 * (0058 §3), so a destination that could not be written reports
 * `did-not-finish` and the pass stops for a person: nothing has been judged, so
 * there is nothing a fix round would fix, and 0066 §7's second row is what that
 * costs.
 *
 * **It wraps and does not reimplement.** The write and the commit are the
 * caller's, handed over as `FileActionDeps.keep` for `createWorktreeAction`'s
 * reason: a filesystem and a `git` binary are things only a caller with a
 * machine under it has, and an action built without one is refused by name
 * rather than quietly keeping nothing (`from-recipe.ts`).
 *
 * ## The locator is a string, and this is the only thing that reads it
 *
 * A repository path, relative to the worktree. Nothing in `@lingtai/actions`
 * above this file and nothing in `@lingtai/conductor` parses it, matches on it or
 * checks it against the plugin at the next step (0066 §4,
 * [0069](../../../doc/decisions/0069-both-the-document-and-the-locator-cross-the-step-boundary.md)
 * §3) — which is the whole of what lets a `confluence:` join beside this without
 * the core learning a second kind of locator.
 *
 * ## It commits, and there is no field for the other answer
 *
 * The argument is on `filePlugin` in `packages/recipe/src/recipe.ts`, where the
 * key is declared. The half worth repeating here, because it is about what this
 * code does: **an uncommitted file does not survive the pass.** `runOnce` adds
 * one finalizer that removes the worktree on every ending, and what gets out
 * past it is what `publishWhatIsCommitted` pushed — commits. So a note that was
 * only written is gone when the pass ends, and the locator this action returns
 * would name a file nobody can open — 0066 §1's *bought, used once, and cannot
 * be kept*, which is the thing this plugin is for.
 *
 * So the keep writes **and** commits, and `evidence` says the note is on the
 * branch because it is.
 */
import type { Action, ActionContext, ActionResult } from "./action.ts";

/**
 * What the keep answers — two branches, because a destination either kept the
 * document or did not.
 *
 * No `asked` branch, unlike `CutAnswer`'s three. 0066 §7's third row — *the
 * destination needs a person* — is a run-time failure this destination cannot
 * have: a path in the worktree needs no space, no credential and no permission
 * a pass does not already hold, so every way this fails is the second row. A
 * branch for an ending nothing can produce is `#61` one layer down, and the
 * destination that *can* ask is the one that makes a network call.
 */
export type KeptAnswer =
  /**
   * Kept, at this path — the locator, verbatim, and it is the plugin's own word
   * for where the document went.
   *
   * `head` is where the branch is once the note is on it: `design` leaves the
   * tree somewhere new, which is `LeftTheTreeAt`'s one seam and the reason
   * `onSha` advances rather than the later steps judging a commit that is not
   * the one they are about. Optional, because a keep that could not ask git
   * where the branch is has still kept the file, and the locator is what this
   * action promised.
   */
  | { readonly at: string; readonly head?: string }
  /** Why it was not written, in words a person reads (0043). */
  | { readonly notKept: string };

/**
 * The keep, as the only thing this action needs from its caller.
 *
 * **Writes the file *and* commits it, and both are the contract rather than the
 * caller's choice** — the `at` branch is what this action says *committed to the
 * branch* on, and the two answers were never a field (the header says why). A
 * keep that only wrote would make the evidence false about the one fact the card
 * is read for; it says `notKept` instead.
 *
 * A method on an object rather than a bare function, so the shape matches
 * `WorktreeActionDeps` and `MergeActionDeps` and a reader meets one convention.
 */
export interface FileActionDeps {
  keep(spec: {
    /** Relative to the worktree, and `whyThePathEscapes` has already refused anything else. */
    readonly path: string;
    readonly document: string;
  }): Promise<KeptAnswer>;
}

export interface FileActionSpec {
  name: string;
  /** Where the document goes, relative to the worktree. `filePlugin`'s `file:` field. */
  path: string;
}

/** `2.4 kB`, which is the unit 0066 §3's own example sentence is written in. */
function sizeOf(document: string): string {
  const bytes = Buffer.byteLength(document, "utf8");
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
}

export function createFileAction(spec: FileActionSpec, deps: FileActionDeps): Action {
  return {
    name: spec.name,
    kind: "file",

    async run(context: ActionContext): Promise<ActionResult> {
      const drafted = context.design;
      if (drafted === undefined) {
        // A context nothing filled in, which is one built by hand: `runStep`
        // sets `design` on every verdicts pipeline, and `runActionPipeline`
        // advances it as the step's own list produces one. Reported rather than
        // treated as an empty document, because *nobody drafted* and *the
        // drafter answered that none was needed* are different facts and only
        // the second is an answer (0058 §3).
        return {
          verdict: "did-not-finish",
          evidence:
            `nothing handed "${spec.name}" a design to keep — a \`file:\` keeps what an earlier action ` +
            "at the step made, and no pipeline filled `ActionContext.design` in",
          findings: [],
        };
      }

      // **Silent where there was nothing to keep**, which is the rule on
      // `designFrom` in `packages/conductor/src/pass.ts` read from this side: an
      // empty document is *the drafter answered that this change needs none*
      // (0058 §3), and a file written for it would be an empty file in the diff
      // and a locator pointing at nothing anybody wants. No `document` and no
      // `locator` on the result, so the drafter's own answer is what crosses to
      // `implement` — a destination that kept nothing says so on `evidence` and
      // changes no fact.
      if (drafted.document === "") {
        return {
          verdict: "passed",
          evidence: `nothing to keep at \`${spec.path}\` — the design step answered that none was needed`,
          findings: [],
        };
      }

      const answer = await deps.keep({ path: spec.path, document: drafted.document });
      if ("notKept" in answer) {
        return {
          verdict: "did-not-finish",
          evidence: `the design was not kept at \`${spec.path}\`: ${answer.notKept}`,
          findings: [],
        };
      }

      return {
        verdict: "passed",
        // 0066 §3's own sentence: *wrote a 2.4 kB design to `doc/design/x.md`* —
        // the fact a person reads off the card, in place of the document, on the
        // event this action appends. Not on the drafter's, which still carries
        // the document clipped (0066 §8) — the header says what that leaves open.
        evidence: `wrote a ${sizeOf(drafted.document)} design to \`${answer.at}\`, committed to the branch`,
        findings: [],
        // **Both, off one result**, which is what makes the pair readable: a
        // locator whose document did not survive is a locator nothing carries
        // (0069 §5), so the document is returned beside the path rather than
        // left to the entry that drafted it.
        document: drafted.document,
        locator: answer.at,
        ...(answer.head === undefined ? {} : { head: answer.head }),
      };
    },
  };
}
