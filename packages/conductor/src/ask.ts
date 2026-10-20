/**
 * Asking a person something **before** a run, and recording what they said.
 *
 * `WorkItemLifecycle` has carried `runId: string | null` since the beginning,
 * and all three callers that start a wait ran inside a pass (#147). So the
 * one question that must be asked before anything is spent — *which of these
 * designs?* — was the one the model could not ask: every path to `blocked`
 * began by claiming the ticket and cutting a worktree. What stood in for it was
 * the GitHub issue body, edited by hand, which is how the choice of a
 * credential guard came to live outside `events` entirely (#51).
 *
 * **Not a gate point.** A `human:` action at `admit` cannot be written at all —
 * `human:` declares no `at.admit`, so the pair is refused by name — and even
 * run it would hold at a point
 * with no branch and no diff — the person is asked to answer, not to review. The
 * decision belongs before the claim, which makes it a queue fact: the queue
 * subtracts every row the log says is not `backlog` (`queue.ts`), so a block
 * that belongs to no run is passed over by machinery that already exists.
 *
 * **No GitHub call**, for `requeue`'s reason: the event is the whole of the
 * decision, and the answer reaches the agent through the prompt
 * (`nextPrompt`), not through the issue.
 */
import { parsePayload, reduceWorkItem, waitsOf, type WaitId, ticketStream } from '@lingtai/domain'
import { allowedResolutions } from '@lingtai/domain/wait'
import { ConcurrencyError, type EventStore, eventStore } from '@lingtai/event-store'

import { resolveWaitHolding } from './resolve-wait.ts'

export interface AskOutcome {
  ok: boolean
  ticketId: string
  detail: string
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
  project: string
  issue: number
  question: string
  by: string
  store?: EventStore
}): Promise<AskOutcome> {
  const store = options.store ?? eventStore
  const ticketId = ticketStream(options.project, options.issue)

  if (!options.question.trim()) {
    return { ok: false, ticketId, detail: 'a question needs a question' }
  }

  const item = reduceWorkItem(await store.read(ticketId))
  if (item.lifecycle.status !== 'backlog') {
    // The state it is in, for the reason `requeue` names it: "cannot ask" sends
    // nobody anywhere, and "it is already running" answers why.
    return {
      ok: false,
      ticketId,
      detail: `${ticketId} is ${item.lifecycle.status} — a question before a run can only be asked of an item nothing holds`,
    }
  }

  try {
    await store.append(ticketId, item.version, [
      {
        type: 'WaitStarted',
        actor: options.by,
        data: parsePayload('WaitStarted', {
          waitId: crypto.randomUUID(),
          reason: { _tag: 'OwnQuestion', question: options.question, by: options.by },
        }),
      },
    ])
  } catch (err) {
    // A conductor claimed it between the read and the append. The claim won,
    // which is the right outcome: say so rather than retrying onto a run.
    if (err instanceof ConcurrencyError) {
      return { ok: false, ticketId, detail: `${ticketId} changed while asking — read it again` }
    }
    throw err
  }

  return { ok: true, ticketId, detail: `asked, by ${options.by} — the queue passes over it until it is answered` }
}

/**
 * Answers a question asked before a run, and hands the item back to the queue.
 *
 * The same event `requeue` appends — resolving the wait, whose `note` is the
 * answer — and the fold keeps it, so a replay can say what was decided and
 * every later attempt's prompt carries it. A question that should not have been
 * asked is withdrawn instead — `requeue()`, which writes the unblock
 * `withdrawn` and keeps no answer.
 *
 * **Refused on a block a run is holding.** That block is about an attempt: a
 * diff waiting at a gate is approved or rejected (`lingtai approve`), and a
 * failure is acknowledged by `lingtai requeue`. Answering one of those as though
 * it were a question about the ticket would throw the diff away and put a
 * sentence about one attempt into every attempt after it.
 */
export async function answer(options: {
  project: string
  issue: number
  answer: string
  /**
   * The question the person was shown, and is answering — refused when the
   * item is asking something else now. Without it, a question withdrawn and
   * asked again under an open page takes the answer to the old wording, and
   * every later attempt is told a pairing nobody made: the append is against
   * the current version, so no ConcurrencyError catches it. The board always
   * passes it; the CLI, which shows nothing first, passes none.
   */
  question?: string
  /**
   * The wait the caller was shown, and is resolving — checked against the
   * one currently open rather than trusted from the fold (#465), the same
   * reason `question` above is. Omitted by the CLI, which reads and resolves
   * inside one command; the board always sends it.
   */
  waitId?: WaitId
  by: string
  store?: EventStore
}): Promise<AskOutcome> {
  const store = options.store ?? eventStore
  const ticketId = ticketStream(options.project, options.issue)

  if (!options.answer.trim()) {
    return { ok: false, ticketId, detail: 'an answer needs an answer' }
  }

  const events = await store.read(ticketId)
  const item = reduceWorkItem(events)
  if (item.lifecycle.status !== 'blocked') {
    return { ok: false, ticketId, detail: `${ticketId} is ${item.lifecycle.status}, not asking anything` }
  }

  // **Only an `OwnQuestion` offers `AnswerQuestion`** (`wait.ts`'s own table)
  // — every other wait carries a run, which is exactly `life.runId !== null`
  // today: a hold with no `run` field is `Question`'s alone.
  const wait = waitsOf(events).at(-1)
  if (wait === undefined) {
    return { ok: false, ticketId, detail: `${ticketId} is not asking anything` }
  }
  const reason = wait.reason
  if (!allowedResolutions(reason).includes('AnswerQuestion')) {
    const runId = 'run' in reason ? reason.run.runId : null
    return {
      ok: false,
      ticketId,
      detail: `${ticketId} is held by ${runId}, not asking before a run — lingtai approve or lingtai requeue`,
    }
  }
  if (reason._tag === 'OwnQuestion' && options.question !== undefined && options.question !== reason.question) {
    return {
      ok: false,
      ticketId,
      detail: `${ticketId} is asking a different question now — "${reason.question}" — read it again`,
    }
  }

  // The append itself, and the version check that guards it, are
  // `resolveWait`'s now (#465) — every check above this line is `answer`'s
  // own reading of what a question may be answered at all, which
  // `resolveWaitHolding`'s generic `allowedResolutions` check re-asks and
  // agrees with by construction. `answer` never took the decide-lock
  // `approve`/`requeue` do (#150 was never its problem), so it calls the
  // unlocked half directly rather than gaining one now.
  const resolved = await resolveWaitHolding(
    {
      ticketId,
      issue: options.issue,
      waitId: options.waitId ?? wait.waitId,
      resolution: { _tag: 'AnswerQuestion', choice: options.answer },
      by: options.by,
      note: options.answer,
      store,
    },
    ticketId,
  )
  if (!resolved.ok) {
    return { ok: false, ticketId, detail: resolved.detail }
  }

  return { ok: true, ticketId, detail: `answered, by ${options.by} — back in the queue, and every attempt is told` }
}
