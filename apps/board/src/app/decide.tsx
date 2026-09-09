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
import { approveCard, rejectCard, requeueCard, sendAttempt, waiveGate } from "./actions.ts";
import type { ActionResult } from "@/lib/diff";

type Pending = "approve" | "reject" | "waive" | null;

/**
 * The recommended move, as `WorkItemBlocked.diagnosis.recommendation` named it.
 *
 * It decides which button is primary and nothing else. A recommendation is not
 * an action taken — the click is still a person's — but a card that recommends
 * approving and dresses Approve as the same weight as Reject is asking the
 * question #83 says it should stop asking: *work out what to do.*
 */
export type Recommended = "approve" | "reject" | "requeue" | null;

export function Decide({
  project,
  issue,
  onSha,
  headSha,
  gates,
  recommended,
}: {
  project: string;
  issue: number;
  /**
   * The sha the run is *asking* about. Approve and reject answer that question,
   * and `approve()` compares this against the run's own `onSha` — so sending
   * what the run produced instead refused approvals `lingtai approve` accepted
   * (#92).
   */
  onSha: string;
  /**
   * The sha the run *produced*. A waiver is a verdict about that diff and
   * `waive()` compares against it, which is a different value the moment a
   * branch is repaired and approval re-requested on a new head.
   */
  headSha: string;
  /** Gate names that could be waived, so the reason can name one. */
  gates: string[];
  /**
   * What the diagnosis recommends, when it recommends anything.
   *
   * Amber stays on the move that was recommended. Approve keeps it when nothing
   * was recommended at all — which is every block written before #83, and is
   * the behaviour those cards have always had.
   */
  recommended?: Recommended;
}) {
  const [pending, setPending] = useState<Pending>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [asking, setAsking] = useState<"reject" | "waive" | null>(null);
  const [reason, setReason] = useState("");
  const [, startTransition] = useTransition();

  const run = (kind: Exclude<Pending, null>, action: () => Promise<ActionResult>) => {
    // Optimistic: the button reports the intent straight away.
    setPending(kind);
    setRefusal(null);
    startTransition(async () => {
      const result = await action();
      setPending(null);
      if (result.ok) {
        setDone(result.detail);
        setAsking(null);
        setReason("");
        return;
      }
      // Reverted. The card goes back to undecided and the operator is told the
      // server's actual reason, because "it didn't work" sends them nowhere.
      setRefusal(result.detail);
    });
  };

  if (done) return <p className="decided">{done}</p>;

  if (asking) {
    const label = asking === "reject" ? "Reject" : "Waive";
    return (
      <div className="decide">
        <label className="reason">
          {/* A waiver with no reason is a silent waiver by another name, so the
              field is not optional and the button stays disabled without it. */}
          <span>Why?</span>
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={asking === "waive" ? "unrelated flake in the importer suite" : "wrong approach"}
          />
        </label>
        <div className="btnrow">
          <button
            className="btn pri"
            disabled={!reason.trim() || pending !== null}
            onClick={() =>
              run(asking, () =>
                asking === "reject"
                  ? rejectCard({ project, issue, onSha, reason })
                  : waiveGate({ project, issue, gate: gates[0] ?? "build", onSha: headSha, reason }),
              )
            }
          >
            {pending ? "…" : label}
          </button>
          <button className="btn" onClick={() => setAsking(null)} disabled={pending !== null}>
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
          className={recommended === "reject" ? "btn" : "btn pri"}
          disabled={pending !== null}
          onClick={() => run("approve", () => approveCard({ project, issue, onSha }))}
        >
          {pending === "approve" ? "merging…" : "Approve"}
        </button>
        <button
          className={recommended === "reject" ? "btn pri" : "btn"}
          disabled={pending !== null}
          onClick={() => setAsking("reject")}
        >
          Reject
        </button>
        {gates.length > 0 ? (
          <button className="btn" disabled={pending !== null} onClick={() => setAsking("waive")}>
            Waive
          </button>
        ) : null}
      </div>
      {refusal ? <p className="refusal">{refusal}</p> : null}
    </div>
  );
}

/**
 * The move that is left when there is no diff to approve.
 *
 * A card in "Waiting on you" whose run is not actually asking anything —
 * because its approved merge hit a conflict, and the approval went with it —
 * used to render Approve, and Approve could not work: `approve()` accepts only
 * `awaiting-approval` and the run is back to `gating`. Three items sat like
 * that, one of them for four days (#84).
 *
 * So the card offers what it really has. Putting it back in the queue means the
 * next attempt is cut from a base that has since moved, which for the
 * commonest case — a conflict nobody chose to repair — is the fix. The reason
 * is required for the same reason a waiver's is: a person overruling a block
 * without saying why is how a system stops being able to explain itself.
 */
export function Requeue({
  project,
  issue,
  recommended,
}: {
  project: string;
  issue: number;
  /**
   * `requeue` is the one value that means anything here — it is the only move
   * this control has — and it promotes the button to primary. Without a
   * recommendation the button stays as it was: the move is available, and
   * nothing is telling you to take it.
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
            className={recommended === "requeue" ? "btn pri" : "btn"}
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
 * **Beside it, the two moves that are not sending.** *Reject* is `Decide`'s and
 * stays there: it withdraws an approval, so it is offered exactly where there
 * is one to withdraw, which is the rule #84 cost four days to learn — a card
 * must never offer only a control that refuses. *Leave blocked* is here, and it
 * appends nothing on purpose: *I read it and I am not acting* is an answer, and
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
