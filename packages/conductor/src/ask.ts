/**
 * Asking a person something **before** a run, and recording what they said.
 *
 * `WorkItemLifecycle` has carried `runId: string | null` since the beginning,
 * and all three appenders of `WorkItemBlocked` ran inside a pass (#147). So the
 * one question that must be asked before anything is spent — *which of these
 * designs?* — was the one the model could not ask: every path to `blocked`
 * began by claiming the ticket and cutting a worktree. What stood in for it was
 * the GitHub issue body, edited by hand, which is how the choice of a
 * credential guard came to live outside `events` entirely (#51).
 *
 * **Not a gate point.** A `human:` action at `admit` is declared, printed and
 * never run (`gate-audit.ts`), and even run it would hold at a point with no
 * branch and no diff — the person is asked to answer, not to review. The
 * decision belongs before the claim, which makes it a queue fact: the queue
 * subtracts every row the log says is not `backlog` (`queue.ts`), so a block
 * that belongs to no run is passed over by machinery that already exists.
 *
 * **No GitHub call**, for `requeue`'s reason: the event is the whole of the
 * decision, and the answer reaches the agent through the prompt
 * (`nextPrompt`), not through the issue.
 */
import { parsePayload, reduceWorkItem, workItemStream } from "@lingtai/domain";
import { ConcurrencyError, type EventStore, eventStore } from "@lingtai/event-store";

export interface AskOutcome {
  ok: boolean;
  workItemId: string;
  detail: string;
}

/**
 * Holds an item on a question, before any run has claimed it.
 *
 * Refused on anything but `backlog`. A claimed item has a run that would be
 * holding a worktree while the question sat unanswered — and its block belongs
 * to that run, which is what the three in-pass appenders already write. A
 * blocked item is already asking something; a second question would replace
 * the first unanswered, and the union has room for one.
 */
export async function ask(options: {
  project: string;
  issue: number;
  question: string;
  by: string;
  store?: EventStore;
}): Promise<AskOutcome> {
  const store = options.store ?? eventStore;
  const workItemId = workItemStream(options.project, options.issue);

  if (!options.question.trim()) {
    return { ok: false, workItemId, detail: "a question needs a question" };
  }

  const item = reduceWorkItem(await store.read(workItemId));
  if (item.lifecycle.status !== "backlog") {
    // The state it is in, for the reason `requeue` names it: "cannot ask" sends
    // nobody anywhere, and "it is already running" answers why.
    return {
      ok: false,
      workItemId,
      detail: `${workItemId} is ${item.lifecycle.status} — a question before a run can only be asked of an item nothing holds`,
    };
  }

  try {
    await store.append(workItemId, item.version, [
      {
        type: "WorkItemBlocked",
        actor: options.by,
        data: parsePayload("WorkItemBlocked", {
          question: options.question,
          needsFrom: "human",
          // The null the type always allowed and nothing ever wrote.
          runId: null,
          needs: "judgement",
          diagnosis: null,
        }),
      },
    ]);
  } catch (err) {
    // A conductor claimed it between the read and the append. The claim won,
    // which is the right outcome: say so rather than retrying onto a run.
    if (err instanceof ConcurrencyError) {
      return { ok: false, workItemId, detail: `${workItemId} changed while asking — read it again` };
    }
    throw err;
  }

  return { ok: true, workItemId, detail: `asked, by ${options.by} — the queue passes over it until it is answered` };
}

/**
 * Answers a question asked before a run, and hands the item back to the queue.
 *
 * The same event `requeue` appends — `WorkItemUnblocked`, whose `note` is the
 * answer — and the fold keeps it, so a replay can say what was decided and
 * every later attempt's prompt carries it.
 *
 * **Refused on a block a run is holding.** That block is about an attempt: a
 * diff waiting at a gate is approved or rejected (`lingtai approve`), and a
 * failure is acknowledged by `lingtai requeue`. Answering one of those as though
 * it were a question about the ticket would throw the diff away and put a
 * sentence about one attempt into every attempt after it.
 */
export async function answer(options: {
  project: string;
  issue: number;
  answer: string;
  by: string;
  store?: EventStore;
}): Promise<AskOutcome> {
  const store = options.store ?? eventStore;
  const workItemId = workItemStream(options.project, options.issue);

  if (!options.answer.trim()) {
    return { ok: false, workItemId, detail: "an answer needs an answer" };
  }

  const item = reduceWorkItem(await store.read(workItemId));
  const life = item.lifecycle;
  if (life.status !== "blocked") {
    return { ok: false, workItemId, detail: `${workItemId} is ${life.status}, not asking anything` };
  }
  if (life.runId !== null) {
    return {
      ok: false,
      workItemId,
      detail: `${workItemId} is held by ${life.runId}, not asking before a run — lingtai approve or lingtai requeue`,
    };
  }

  try {
    await store.append(workItemId, item.version, [
      {
        type: "WorkItemUnblocked",
        actor: options.by,
        data: parsePayload("WorkItemUnblocked", { by: options.by, note: options.answer }),
      },
    ]);
  } catch (err) {
    if (err instanceof ConcurrencyError) {
      return { ok: false, workItemId, detail: `${workItemId} changed while answering — read it again` };
    }
    throw err;
  }

  return { ok: true, workItemId, detail: `answered, by ${options.by} — back in the queue, and every attempt is told` };
}
