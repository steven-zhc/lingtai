/**
 * Ending a ticket nobody is going to do (#151).
 *
 * A lifecycle had two ends before this: `landed`, and `blocked` forever.
 * Closing was `gh issue close` by hand, which appends nothing — so the fold
 * went on saying `backlog`, the board went on drawing the card under *Queued*,
 * and the only lever left was `requeue`, which says the item is going to be
 * worked again. Five cards sat like that on 2026-09-14, four of them against
 * issues that had been closed for hours.
 *
 * **This is an append, not a delete.** Nothing is removed and a replay reaches
 * the same place; what changes is that the item now has an end. The queue then
 * passes over it *because the log says it is over* — `queue.ts` subtracts every
 * row the fold does not call `backlog` — rather than because GitHub stopped
 * listing it, which is the offer side and an accident of it.
 *
 * **From any state but a terminal.** A blocked item, a queued one, even one a
 * conductor is holding: deciding a ticket is over is a fact about the ticket,
 * not about the attempt in flight. A claimed item closed mid-pass keeps its run
 * — the run ends on its own and appends what it always would — and the item does
 * not go back to the queue afterwards, because `closed` is not `backlog`.
 *
 * **Nothing lifts it**, which is 0151's decision rather than an omission: a work
 * item's stream is the story of one ticket. Reopening the issue grafts a second
 * story onto the first, and `attempts.ts` would then carry the attempt count,
 * the findings and the spend of work done under an intent that is no longer the
 * intent into every prompt after it. Wanting the work again is a new ticket.
 *
 * **No GitHub call**, for the reason `requeue` gives: the event is the whole of
 * the decision. `labelsFor("closed")` is empty and `converge` writes the
 * difference, so the labels an earlier block left behind come off on their own.
 */
import { parsePayload, reduceWorkItem, workItemStream } from "@lingtai/domain";
import { ConcurrencyError, type EventStore, eventStore } from "@lingtai/event-store";

export interface CloseOutcome {
  ok: boolean;
  workItemId: string;
  detail: string;
}

export async function close(options: {
  project: string;
  issue: number;
  by: string;
  /**
   * Why, on the record. Required for `requeue`'s reason and one more: this is
   * the only decision that cannot be revisited, so the sentence explaining it
   * is the last thing anybody will have.
   */
  reason: string;
  store?: EventStore;
}): Promise<CloseOutcome> {
  const store = options.store ?? eventStore;
  const workItemId = workItemStream(options.project, options.issue);

  if (!options.reason.trim()) {
    return { ok: false, workItemId, detail: "a close needs a reason" };
  }

  const item = reduceWorkItem(await store.read(workItemId));

  if (item.lifecycle.status === "closed") {
    return { ok: false, workItemId, detail: `${workItemId} is already closed` };
  }
  if (item.lifecycle.status === "landed") {
    // Not an error a person needs to work around: it is done, and saying so is
    // more useful than appending a second ending over the first.
    return { ok: false, workItemId, detail: `${workItemId} landed — there is nothing to close` };
  }

  try {
    await store.append(workItemId, item.version, [
      {
        type: "WorkItemClosed",
        actor: options.by,
        data: parsePayload("WorkItemClosed", { by: options.by, reason: options.reason }),
      },
    ]);
  } catch (err) {
    // Something moved between the read and the append — a pass claimed it, or a
    // gate answered. Say so rather than closing over a decision nobody saw.
    if (err instanceof ConcurrencyError) {
      return { ok: false, workItemId, detail: `${workItemId} changed while closing — read it again` };
    }
    throw err;
  }

  return { ok: true, workItemId, detail: `closed by ${options.by} — the queue will not offer it again` };
}
