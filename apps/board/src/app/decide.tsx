"use client";

/**
 * The controls on a card that is waiting on you.
 *
 * The optimistic state is the point and also the trap. Showing the result
 * immediately is what makes a queue of 45 feel workable; showing a result that
 * did not happen is worse than showing nothing, because the operator moves on
 * believing the item is handled. So every action **reverts on refusal and says
 * why** — the server's own sentence, not a generic "something went wrong".
 *
 * The commonest refusal is the interesting one: the branch moved between the
 * card rendering and the click, so the diff being approved is not the diff that
 * was read. That has to be visible, not swallowed.
 */
import { useState, useTransition } from "react";
import { approveCard, requeueCard, runNow, sendAttempt } from "./actions.ts";
import type { ActionResult } from "@/lib/diff";

/**
 * The recommended move, as `WorkItemBlocked.diagnosis.recommendation` named it.
 *
 * It decides which button is primary and nothing else. A recommendation is not
 * an action taken — the click is still a person's — but a card that recommends
 * approving and dresses Approve as the same weight as the alternative is asking
 * the question #83 says it should stop asking: *work out what to do.*
 *
 * `reject` is still a value the log can carry, and there is no Reject (#150):
 * it asked the same question again. What a person who agrees with a refusal
 * wants is another attempt, so it promotes Requeue, exactly as `requeue` does.
 */
export type Recommended = "approve" | "reject" | "requeue" | null;

/** Whether a recommendation points away from merging this diff. */
export const againstApproving = (recommended: Recommended | undefined): boolean =>
  recommended === "reject" || recommended === "requeue";

/**
 * Approve — and, over a gate that still refuses, the waiver with it.
 *
 * **One control, not two** (#150). There was a Waive beside it that appended
 * `GateWaived` and changed nothing Approve then did, so the path that explained
 * why a refusal was overruled cost two clicks and the path that did not cost
 * one. Now a card whose gates still refuse asks *why* before it approves, and
 * `approve()` records that sentence as the waiver of each refusing gate in the
 * same append as the approval. Which gates is the run's to say: nothing here
 * names one, so a waived `review` cannot be recorded as a waived `build`.
 *
 * `refusing` only decides whether to ask first. The server is what refuses an
 * approval with no reason, and if the card's count is behind the log, that
 * refusal opens the question here rather than leaving a dead click.
 */
export function Decide({
  project,
  issue,
  onSha,
  refusing,
  recommended,
}: {
  project: string;
  issue: number;
  /**
   * The sha the run is *asking* about. Approve answers that question, and
   * `approve()` compares this against the run's own `onSha` — so sending what
   * the run produced instead refused approvals `lingtai approve` accepted (#92).
   */
  onSha: string;
  /** How many gates still refuse, as the card read them. A count, never names. */
  refusing: number;
  /**
   * What the diagnosis recommends, when it recommends anything.
   *
   * Amber stays on the move that was recommended. Approve keeps it unless the
   * recommendation points to another attempt — which leaves it on every block
   * written before #83, the behaviour those cards have always had.
   */
  recommended?: Recommended;
}) {
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [, startTransition] = useTransition();

  const approve = (note: string | null) => {
    // Optimistic: the button reports the intent straight away.
    setPending(true);
    setRefusal(null);
    startTransition(async () => {
      const result: ActionResult = await approveCard({ project, issue, onSha, ...(note ? { note } : {}) });
      setPending(false);
      if (result.ok) {
        setDone(result.detail);
        return;
      }
      // Reverted. The card goes back to undecided and the operator is told the
      // server's actual reason, because "it didn't work" sends them nowhere.
      setRefusal(result.detail);
      if (result.needsReason) setAsking(true);
    });
  };

  if (done) return <p className="decided">{done}</p>;

  if (asking) {
    return (
      <div className="decide">
        <label className="reason">
          {/* Not optional: merging over a refusal without saying why is the
              silent waiver by another name, so the button stays disabled. */}
          <span>Why merge over it?</span>
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="unrelated flake in the importer suite"
          />
        </label>
        <div className="btnrow">
          <button className="btn pri" disabled={!reason.trim() || pending} onClick={() => approve(reason)}>
            {pending ? "merging…" : "Approve"}
          </button>
          <button className="btn" onClick={() => setAsking(false)} disabled={pending}>
            Cancel
          </button>
        </div>
        {refusal ? <p className="refusal">{refusal}</p> : null}
      </div>
    );
  }

  return (
    <div className="decide">
      <div className="btnrow">
        <button
          className={againstApproving(recommended) ? "btn" : "btn pri"}
          disabled={pending}
          title={refusing > 0 ? "a gate still refuses this diff — approving waives it, with a reason" : undefined}
          onClick={() => (refusing > 0 ? setAsking(true) : approve(null))}
        >
          {pending ? "merging…" : "Approve"}
        </button>
      </div>
      {refusal ? <p className="refusal">{refusal}</p> : null}
    </div>
  );
}

/**
 * Back to the queue — on every blocked card, beside Approve where there is one.
 *
 * A card in "Waiting on you" whose run is not actually asking anything —
 * because its approved merge hit a conflict, and the approval went with it —
 * used to render Approve, and Approve could not work: `approve()` accepts only
 * `awaiting-approval` and the run is back to `gating`. Three items sat like
 * that, one of them for four days (#84).
 *
 * So the card offers what it really has. Putting it back in the queue means the
 * next attempt is cut from a base that has since moved, which for the
 * commonest case — a conflict the pass could not resolve — is the fix. The
 * reason is required for the same reason a waiver's is: a person overruling a
 * block without saying why is how a system stops being able to explain itself.
 *
 * **And this is the move for every refused merge now** (`#143`). A lane refusal
 * used to buy a whole new run for some of them; nothing does, so the button is
 * what answers the commonest failure in the system rather than the leftover it
 * was written as.
 *
 * **And it is Approve's peer, not its alternative** (#150). It was rendered
 * only where there was nothing to approve — which is exactly when a
 * disagreement is *not* being adjudicated — so on the card where *I agree with
 * the reviewer, run it again* was the right move, it was the one move missing.
 */
export function Requeue({
  project,
  issue,
  recommended,
}: {
  project: string;
  issue: number;
  /**
   * A recommendation against approving — `requeue`, or a `reject` from before
   * #150 — promotes the button to primary, and takes the amber off Approve.
   * Without one the button stays as it was: the move is available, and nothing
   * is telling you to take it.
   */
  recommended?: Recommended;
}) {
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [, startTransition] = useTransition();

  if (done) return <p className="decided">{done}</p>;

  if (!asking) {
    return (
      <div className="decide">
        <div className="btnrow">
          <button
            className={againstApproving(recommended) ? "btn pri" : "btn"}
            onClick={() => setAsking(true)}
          >
            Back to the queue
          </button>
        </div>
        {refusal ? <p className="refusal">{refusal}</p> : null}
      </div>
    );
  }

  return (
    <div className="decide">
      <label className="reason">
        <span>Why?</span>
        <input
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="main has moved; a fresh branch should merge"
        />
      </label>
      <div className="btnrow">
        <button
          className="btn pri"
          disabled={!note.trim() || pending}
          onClick={() => {
            setPending(true);
            setRefusal(null);
            startTransition(async () => {
              const result = await requeueCard({ project, issue, note });
              setPending(false);
              if (result.ok) {
                setDone(result.detail);
                return;
              }
              // Reverted, with the server's own sentence. "It didn't work"
              // sends an operator nowhere.
              setRefusal(result.detail);
            });
          }}
        >
          {pending ? "…" : "Requeue"}
        </button>
        <button className="btn" onClick={() => setAsking(false)} disabled={pending}>
          Cancel
        </button>
      </div>
      {refusal ? <p className="refusal">{refusal}</p> : null}
    </div>
  );
}

/**
 * The move the decision column ends in: send the next attempt.
 *
 * **The whole of design §5, and it was missing.** `WILL BE SENT` rendered the
 * composed prompt and offered Edit, and nothing sent it — so a person could
 * compose exactly the right instruction and then had only *Back to the queue*,
 * a button named for a queue rather than for the document it hands over. An
 * editable control with no commit action is a dead end (#111).
 *
 * Named for what it sends, and numbered: `Send attempt 3` agrees with the box
 * above it, which is stamped `attempt 3 only` because that is how long the edit
 * lasts (0032 §5). The click appends `PromptEdited` — when the editor handed a
 * sentence with it — and then `WorkItemUnblocked`; `sendAttempt` keeps that
 * order, and why.
 *
 * **Beside it, the moves that are not sending.** *Approve* is `Decide`'s, offered
 * exactly where there is an approval open, which is the rule #84 cost four days
 * to learn — a card must never offer only a control that refuses. Sending is
 * itself a requeue, so this is Approve's peer on the page (#150). *Leave
 * blocked* is here, and it appends nothing on purpose: *I read it and I am not acting* is an answer, and
 * a row of two buttons that does not contain it is a row that makes walking
 * away the third option.
 */
export function Send({
  taskId,
  attempt,
  primary,
}: {
  taskId: string;
  /** 1-based, as the outgoing box numbers it. The button says this number. */
  attempt: number;
  /**
   * Whether this is the amber one.
   *
   * Decided by the caller and not by a `Recommended` here, because it takes two
   * facts and this component has one of them: the recommendation, and whether
   * `Decide` is on the row beside it with an Approve already wearing the amber.
   * **Amber appears once per screen** (layout notes), and a row with two primary
   * buttons dilutes it exactly as a second decorative use would.
   */
  primary: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [left, setLeft] = useState(false);
  const [, startTransition] = useTransition();

  if (done) return <p className="decided">{done}</p>;
  // Honest about having written nothing. The class is not `decided`, because
  // green here would claim an append that did not happen.
  if (left) {
    return (
      <p className="undecided">
        left blocked — nothing was appended, and it is still waiting on you
      </p>
    );
  }

  return (
    <div className="decide">
      <div className="btnrow">
        <button
          className={primary ? "btn pri" : "btn"}
          disabled={pending}
          onClick={() => {
            setPending(true);
            setRefusal(null);
            startTransition(async () => {
              const result = await sendAttempt({ taskId });
              setPending(false);
              if (result.ok) {
                setDone(result.detail);
                return;
              }
              // Reverted, with the server's own sentence: a result shown that
              // did not happen is worse than no result (`decide.tsx`'s trap).
              setRefusal(result.detail);
            });
          }}
        >
          {pending ? "sending…" : `Send attempt ${attempt}`}
        </button>
        <button className="btn" disabled={pending} onClick={() => setLeft(true)}>
          Leave blocked
        </button>
      </div>
      {refusal ? <p className="refusal">{refusal}</p> : null}
    </div>
  );
}

/**
 * The move a queued item has: take this one next.
 *
 * `lingtai now`, from the page — an append to `ctl-conductor` and nothing else
 * (`runNow`). It is the only control the Queued column ever had, and it had it
 * only from a terminal: a card there could not be opened at all until `#113`,
 * so the answer to *why is this not moving* and the button that moves it were
 * in two different programs.
 *
 * **It says what pressing it costs when something is holding the item.** A
 * backoff is the recipe's guard against blind retries and this jumps it (0028
 * §3), so the button names that rather than looking like an ordinary Run — the
 * whole reason `#95` put the time on the card is that a held item and a next
 * one read identically, and a control that hid the difference again would undo
 * it. A pause is not jumped by anything: the request lands and waits, and the
 * button says so instead of promising a start.
 */
export function RunNow({
  project,
  issue,
  holding,
  primary = true,
}: {
  project: string;
  /** The issue number as GitHub numbers it, which is what `RunRequested` carries. */
  issue: string;
  /**
   * What is holding this item, in one phrase, or null when nothing is.
   *
   * `queuedStanding`'s own wording, passed down rather than rebuilt here: the
   * card, `lingtai status` and this button say the same thing about the same
   * hold, which is the property `#100` cost a ticket to establish.
   */
  holding: string | null;
  /**
   * Whether this is the amber one. **Amber appears once per screen** (layout
   * notes), and on a queued page this is the move — there is no Approve beside
   * it — so it carries it by default.
   */
  primary?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (done) return <p className="decided">{done}</p>;

  return (
    <div className="decide">
      <div className="btnrow">
        <button
          className={primary ? "btn pri" : "btn"}
          disabled={pending}
          onClick={() => {
            setPending(true);
            setRefusal(null);
            startTransition(async () => {
              const result = await runNow({ project, issue });
              setPending(false);
              if (result.ok) {
                setDone(result.detail);
                return;
              }
              // Reverted, with the server's own sentence: a result shown that
              // did not happen is worse than no result (this file's trap).
              setRefusal(result.detail);
            });
          }}
        >
          {pending ? "asking…" : "Run it now"}
        </button>
      </div>
      {/* Under the button rather than on it. What the click does is one fact and
          what is currently stopping the item is another, and a label that tried
          to be both would be a button whose name changes while you read it. */}
      {holding ? <p className="jumps">{holding}</p> : null}
      {refusal ? <p className="refusal">{refusal}</p> : null}
    </div>
  );
}
