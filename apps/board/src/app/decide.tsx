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
 * approving and dresses Approve as the same weight as Requeue is asking the
 * question #83 says it should stop asking: *work out what to do.*
 *
 * `reject` is still a value the log can hold, and no button carries it any more
 * (#150). What a person agreeing with a refusal wants is a new run, so it reads
 * as `requeue` — see `primaryMove`.
 */
export type Recommended = "approve" | "reject" | "requeue" | null;

/**
 * Which of the two moves wears the amber. Amber appears once per screen.
 *
 * Not exported: this is a client module, and a server component calling a
 * function from one gets a reference rather than the function.
 */
function primaryMove(recommended: Recommended | undefined): "approve" | "requeue" {
  return recommended === "reject" || recommended === "requeue" ? "requeue" : "approve";
}

/**
 * Approve, and the reason it needs when a gate still refuses.
 *
 * **One button, and the waiver is inside it** (#150). There were three beside
 * it: Reject appended `ApprovalRevoked` and the run asked again; Waive appended
 * `GateWaived`, which `approve()` never read — so explaining an overruled
 * refusal took two clicks and not explaining it took one. Now `approve()` reads
 * the refusing gates off the run itself, waives each with this reason in the
 * same append, and refuses without one. Nothing here names a gate.
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
   * The sha the run is *asking* about. `approve()` compares this against the
   * run's own `onSha` — so sending what the run produced instead refused
   * approvals `lingtai approve` accepted (#92).
   */
  onSha: string;
  /**
   * Whether the card knows of a gate that refused, so the reason is asked for
   * before the click rather than after a refusal. A hint, and only that: the
   * server decides from the run, and if it asks for a reason the card did not
   * expect to need, the field opens with its sentence.
   */
  refusing: boolean;
  /**
   * What the diagnosis recommends, when it recommends anything. Amber stays on
   * Approve unless the recommendation is to run it again.
   */
  recommended?: Recommended;
}) {
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [, startTransition] = useTransition();

  const approve = (withNote: string) => {
    // Optimistic: the button reports the intent straight away.
    setPending(true);
    setRefusal(null);
    startTransition(async () => {
      const result: ActionResult = await approveCard({ project, issue, onSha, note: withNote });
      setPending(false);
      if (result.ok) {
        setDone(result.detail);
        return;
      }
      // Reverted. The card goes back to undecided and the operator is told the
      // server's actual reason, because "it didn't work" sends them nowhere.
      // A refusal for want of a reason opens the field it wants.
      if (result.detail.startsWith("reason-required")) setAsking(true);
      setRefusal(result.detail);
    });
  };

  if (done) return <p className="decided">{done}</p>;

  if (asking) {
    return (
      <div className="decide">
        <label className="reason">
          {/* Approving over a refusal waives it, and a waiver with no reason is a
              silent waiver by another name — so the button stays disabled
              without one. */}
          <span>Why merge over the refusal?</span>
          <input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="unrelated flake in the importer suite"
          />
        </label>
        <div className="btnrow">
          <button className="btn pri" disabled={!note.trim() || pending} onClick={() => approve(note)}>
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
          className={primaryMove(recommended) === "approve" ? "btn pri" : "btn"}
          disabled={pending}
          onClick={() => (refusing ? setAsking(true) : approve(""))}
        >
          {pending ? "merging…" : "Approve"}
        </button>
      </div>
      {refusal ? <p className="refusal">{refusal}</p> : null}
    </div>
  );
}

/**
 * The move that ends a wait with a new run — on every blocked card (#150).
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
 * **And it sits beside Approve, not in its place** (#150). It was the else of
 * *is there an approval open*, so it was missing exactly where a person reading
 * a disagreement agrees with the reviewer and wants the ticket run again.
 */
export function Requeue({
  project,
  issue,
  recommended,
}: {
  project: string;
  issue: number;
  /**
   * A recommendation to run it again — `requeue`, or a `reject` from before
   * #150 — promotes the button to primary (`primaryMove`). Without one the
   * button stays as it was: the move is available, and nothing is telling you
   * to take it.
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
            className={primaryMove(recommended) === "requeue" ? "btn pri" : "btn"}
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
 * **Beside it, the move that is not sending.** *Leave blocked* is here, and it
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
