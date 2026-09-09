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
import { approveCard, rejectCard, requeueCard, waiveGate } from "./actions.ts";
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
