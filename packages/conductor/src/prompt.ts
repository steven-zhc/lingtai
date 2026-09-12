/**
 * The document the next attempt will be handed, composed in one place.
 *
 * `run-once.ts` built this inline: the failure block was an array literal in
 * the middle of an `Effect.gen`, and the version came out of it two lines
 * later. That was fine while the conductor was the only thing that ever needed
 * to know what an attempt would be told. `#104` puts the prompt on the page
 * **before it is sent**, so there is now a second reader — and a page that
 * composes its own approximation of the prompt is worse than a page that shows
 * nothing, because it invites a person to approve a document that is not the
 * one that runs.
 *
 * So the composition lives here, and both the conductor and the board call it.
 * The one thing this file will not do is fetch: it takes the streams, the
 * template and the ticket and returns text, which is what keeps it testable
 * without a database and out of the board's server bundle's way.
 *
 * **Two calls and not one**, because the conductor cannot make one. It needs
 * the version *before* it claims — the claim is what consumes the edit — and
 * the ticket only *after*, from inside the scope that has a worktree. So `nextPrompt` settles everything the streams decide, and
 * `renderPrompt` fills the ticket in. The board makes both calls in a row; the
 * conductor makes them minutes apart. What matters is that neither of them
 * writes its own version of either.
 */
import { reduceWorkItem, type Envelope } from "@lingtai/domain";
import {
  attemptBrief,
  attemptOutcome,
  humanBrief,
  priorAttempts,
  promptVersionFor,
  type PromptBudget,
} from "./attempts.ts";

/**
 * Re-exported so that everything about *the document an attempt is handed* has
 * one door. The board writes `PromptEdited.hash` with it and never reaches past
 * this module into the fold that quotes earlier attempts.
 */
export { editHash } from "./attempts.ts";

/** A sentence a person added for one attempt. `WorkItemState.pendingPrompt`. */
export interface PromptEdit {
  text: string;
  by: string;
}

export interface NextPrompt {
  /** 1-based. This prompt is for attempt `n`, and the page says `attempt 3 only`. */
  attempt: number;
  /**
   * `{{failure}}`, whole: the history of the earlier attempts and the human's
   * sentence. Empty on a first attempt with no edit, and on nothing else —
   * which is what makes attempt 1 render byte-identically to the template.
   *
   * There used to be a third block here, the refusal that bought a repair
   * (`repairBrief`). Nothing buys one since `#143`, so what an attempt is told
   * about an earlier failure is `attemptBrief`'s history and only that.
   */
  failure: string;
  /** `ticket@1924+failure@1c5708ba+human@a91f2e`. */
  version: string;
  /** The edit standing on the item, and null when nobody has made one. */
  edit: PromptEdit | null;
  /**
   * The same two values with the human's sentence taken out — **what Lingtai
   * composed on its own**.
   *
   * Two uses, and both are `#104`'s. The page diffs the edited prompt against
   * this one, so an edit's effect is visible rather than asserted; and an edit
   * records this version as `PromptEdited.basedOn`, so the log says what the
   * person was looking at when they typed. Identical to the pair above when
   * nobody has edited, which is the ordinary case.
   */
  composed: { failure: string; version: string };
}

/**
 * Everything about the next attempt's prompt that the streams decide.
 *
 * Called with the work item's events read **before** the claim: the claim is
 * what consumes the edit, so a read taken afterwards finds none and the run is
 * silently told nothing.
 *
 * `lastRun` is the previous attempt's own stream, and `null` means *it was not
 * read*. That distinction is the one `PriorAttempt.outcome` already makes and
 * it is not cosmetic: an empty array says the attempt committed nothing, which
 * `attemptBrief` prints in as many words, and null says nobody looked.
 */
export function nextPrompt(input: {
  /** The template's own version, `ticket@1924`. */
  base: string;
  budget: PromptBudget;
  /** The work item's own events, before the claim this prompt is for. */
  item: readonly Envelope[];
  /** The previous attempt's stream, or null when there is no previous attempt. */
  lastRun: readonly Envelope[] | null;
}): NextPrompt {
  const attempts = priorAttempts(input.item);
  const state = reduceWorkItem(input.item);
  const edit = state.pendingPrompt;

  const previous = attempts[attempts.length - 1];
  if (previous && input.lastRun !== null) {
    previous.outcome = attemptOutcome(input.lastRun, input.budget);
  }

  // Two blocks and not one. The history is what every second attempt has; the
  // human's is what a person is asking *this* attempt to do, which is a
  // different kind of thing from what the earlier ones did. Neither stands in
  // for the other, which is why they are joined rather than merged.
  //
  // There was a third — the refusal that bought a repair, printed verbatim,
  // which the history deferred to so the same output did not appear twice. A
  // refusal buys no run now (`#143`), so `attemptBrief` is the only thing that
  // quotes one and the bound it keeps is no longer undone by composition.
  const history = attemptBrief(attempts, input.budget);
  const failure = join([history, humanBrief(edit)]);

  return {
    attempt: attempts.length + 1,
    failure,
    // `human` is named apart from `failure` even though both are inside the one
    // block: an attempt told a different sentence is a different attempt, and
    // the version has to say which of the two kinds moved (0032 §5).
    version: promptVersionFor(input.base, failure, edit?.text ?? ""),
    edit,
    composed: { failure: history, version: promptVersionFor(input.base, history) },
  };
}

/** The blocks that said something, in order, one blank line apart. */
function join(blocks: readonly string[]): string {
  return blocks.filter((block) => block !== "").join("\n\n");
}

/**
 * Fills the ticket into the prompt.
 *
 * `{{issue}}` was the only placeholder, and a number is not a ticket. The
 * others are substituted whether or not the template uses them, so a project
 * that writes its own prompt can leave any of them out.
 *
 * `{{failure}}` is empty on a **first** attempt with no edit, and on nothing
 * else. It carries what the earlier attempts did (`attempts.ts`, `#82`) and the
 * sentence a person added for this attempt (`#104`). It is the only thing that
 * distinguishes a second attempt from the first one again, which is why it goes
 * through the same substitution as everything else rather than through a second
 * prompt: every attempt *is* a run, and giving one of them its own template
 * would be the beginning of the sixth gate point 0016 closed the set against.
 *
 * **A template with no slot gets it appended, rather than losing it.** That is
 * the one placeholder this is true of, and deliberately: a project writing its
 * own prompt can leave `{{title}}` out and mean it, but an attempt whose
 * history silently did not reach the agent is a run that costs the same and
 * knows nothing — a control the recipe claims and the code does not have, which
 * is `#58`'s shape and the thing this feature must not reintroduce.
 */
export function renderPrompt(
  template: string,
  ticket: { number: number; title: string; body: string },
  failure = "",
): string {
  const filled = template
    .replaceAll("{{issue}}", String(ticket.number))
    .replaceAll("{{title}}", ticket.title)
    .replaceAll("{{body}}", ticket.body)
    .replaceAll("{{failure}}", failure);
  if (failure === "" || template.includes("{{failure}}")) return filled;
  return `${filled}\n\n${failure}\n`;
}
