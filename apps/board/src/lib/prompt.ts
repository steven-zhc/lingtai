/**
 * What the next attempt will be handed, before it is handed it.
 *
 * The control on this page used to be *yes* or *no*. The prompt the next
 * attempt would run was composed by the conductor, never shown, and could not
 * be changed — so a person who knew exactly what had gone wrong had nowhere to
 * say it, and `#89` spent two attempts and $13.04 chasing a flag that one
 * sentence would have settled (`#104`, the settled design §4).
 *
 * **This composes nothing itself.** It gathers the four things the composition
 * needs — the template, the ticket, the recipe's budget and the item's own
 * streams — and hands them to `@lingtai/conductor/prompt`, which is the same
 * call `run-once.ts` makes. That is the whole point: a page that built its own
 * approximation would invite somebody to approve a document that is not the one
 * that runs, which is worse than showing nothing at all.
 *
 * Everything that can fail says why rather than going blank, the way
 * `TicketView.problem` does. A missing template, an unregistered project and a
 * recipe that will not parse all render as *no prompt*, and only the reason
 * tells them apart (#76).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { repoRoot } from "@lingtai/env";
import { nextPrompt, renderPrompt } from "@lingtai/conductor/prompt";
import { projectFilter } from "@lingtai/conductor/filter";
import { loadProject } from "@lingtai/conductor/projects";
import type { Envelope } from "@lingtai/domain";
import type { TicketView } from "./task.ts";

/**
 * Lines added and removed against what Lingtai composed.
 *
 * Prefix and suffix, not a full diff, and that is exact for what this can
 * produce: an edit contributes one contiguous block to `{{failure}}`, so the
 * change is a single insertion. A count rather than a rendering, because the
 * page shows the whole document next to it — `+4 −0 lines` says *what your
 * sentence did to it*, and the document itself says what it says.
 */
export function lineDelta(before: string, after: string): { added: number; removed: number } {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  return { removed: a.length - head - tail, added: b.length - head - tail };
}

/** The box above the buttons: what will be sent, and the one part a person owns. */
export interface OutgoingView {
  /**
   * The document the next attempt gets, byte for byte — including the edit, if
   * there is one. Empty when `problem` says why there is none.
   */
  text: string;
  /** `ticket@1924+failure@1c5708ba+human@a91f2e`. Names the edit, or does not. */
  version: string;
  /**
   * The version with no edit in it — what Lingtai composed on its own.
   *
   * Sent back with an edit as `PromptEdited.basedOn`, so the log records what
   * the person was looking at when they typed rather than only what they typed.
   */
  basedOn: string;
  /** 1-based. The box says `attempt 3 only`, because that is how long it lasts. */
  attempt: number;
  /** The sentence standing on the item, and null when nobody has added one. */
  edit: { text: string; by: string } | null;
  /** `+4 −0` against what Lingtai composed. Both zero when there is no edit. */
  delta: { added: number; removed: number };
  /** Why there is no prompt to show, when there is none. */
  problem: string | null;
}

function refused(detail: string): OutgoingView {
  return {
    text: "",
    version: "",
    basedOn: "",
    attempt: 0,
    edit: null,
    delta: { added: 0, removed: 0 },
    problem: detail,
  };
}

/**
 * The next attempt's prompt, for an item that is going to have one.
 *
 * Asked only where a next attempt is possible — `loadTask` decides that — because
 * it costs a file read and a recipe fetch, and neither is worth spending on an
 * item that has landed.
 *
 * `streams` is every attempt's stream as `loadTask` already read them, so the
 * last one costs nothing here. `null` for `lastRun` is *nobody looked*, which
 * is what a first attempt gets and is not the same as an attempt that committed
 * nothing (`nextPrompt`).
 */
export async function outgoingFor(input: {
  own: readonly Envelope[];
  streams: readonly (readonly Envelope[])[];
  ticket: TicketView | null;
}): Promise<OutgoingView> {
  const { ticket } = input;
  if (!ticket) return refused("this id is not a work item, so there is no ticket to fill in");
  if (ticket.body === null) {
    // The body is most of the document. Composing without it would show a
    // prompt shorter than the one that runs, which is the specific lie this
    // page exists to stop telling.
    return refused(
      ticket.problem ?? "the issue body could not be read, so the prompt cannot be composed",
    );
  }

  const path = resolve(repoRoot(), "prompts/ticket.md");
  let template: string;
  try {
    template = await readFile(path, "utf8");
  } catch {
    return refused(`no prompt template at ${path}`);
  }

  const state = await loadProject(ticket.project).catch(() => null);
  if (!state) return refused(`${ticket.project} is not a registered project`);
  // Never throws, and its `problem` is already one line. The recipe is here for
  // `runtime.budget` alone — how much of the earlier attempts this prompt
  // quotes (0029) — and guessing at it would misstate the document's length.
  const filter = await projectFilter(state);
  if (!filter.ok) return refused(`the recipe could not be read: ${filter.problem}`);

  const next = nextPrompt({
    // The same version `conduct.ts` and `lingtai run` pass, computed the same
    // way from the same file.
    base: `ticket@${template.length}`,
    budget: filter.recipe.runtime.budget,
    item: input.own,
    lastRun: input.streams.length === 0 ? null : (input.streams.at(-1) ?? []),
  });

  const filled = { number: Number(ticket.ref), title: ticket.title ?? "", body: ticket.body };
  const text = renderPrompt(template, filled, next.failure);

  return {
    text,
    version: next.version,
    basedOn: next.composed.version,
    attempt: next.attempt,
    edit: next.edit,
    delta:
      next.edit === null
        ? { added: 0, removed: 0 }
        : lineDelta(renderPrompt(template, filled, next.composed.failure), text),
    problem: null,
  };
}
