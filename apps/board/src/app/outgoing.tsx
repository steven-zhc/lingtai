"use client";

/**
 * The prompt the next attempt will be handed, before it is handed it.
 *
 * The other of the two objects the decision column allows a frame around — the
 * discussion is the first — and for the same reason: it is a place you *do*
 * something, not a thing you read. It sits above the buttons because it is what
 * they will send.
 *
 * **A recommendation is the system's sentence about what it intends; the prompt
 * is what runs** (the settled design §4). Showing it here turns approval from
 * *yes / no* into *yes, but*, which is the answer a person usually has and
 * could not give: `#89` spent two attempts and $13.04 chasing a flag that is
 * absent from `claude --help` and present in the binary, and one editable
 * sentence would have ended it.
 *
 * **Raw, always** (0032 §7). `#88`'s justification for putting the prompt on
 * the log is that the log holds the *exact* document the agent was given, and
 * the same is true one step earlier: what is in this box is what will be sent,
 * byte for byte, so nothing here renders markdown and nothing collapses
 * whitespace.
 *
 * **The edit is a sentence, not a rewrite**, and the box says so. `PromptEdited`
 * says *this attempt needs an extra sentence*; the ticket says *the instruction
 * itself is wrong* (0032 §6). A durable override living only inside Lingtai
 * would be a shadow ticket body — a long-lived instruction nobody outside can
 * see — so this one is stamped `attempt N only` and the next claim consumes it.
 *
 * The diff is here because the box is honest about its own risk. Lingtai's
 * composed prompt is traceable: every part of it hashes back to a ticket body
 * or to a failure. Hand-written prose is not, and an editable box is equally a
 * way to hand an agent something worse. `+4 −0 lines` and the log's own record
 * of the text are what keep that visible.
 *
 * The optimistic state is `decide.tsx`'s, and so is its trap: a result shown
 * that did not happen is worse than no result, so the action reverts on refusal
 * and says the server's own sentence.
 */
import { useState, useTransition } from "react";
import { editPrompt, sendAttempt } from "./actions.ts";
import type { OutgoingView } from "@/lib/prompt";

/** `+4 −0 lines`, or nothing at all when the edit changed no lines. */
function delta(view: OutgoingView): string | null {
  const { added, removed } = view.delta;
  if (added === 0 && removed === 0) return null;
  return `+${added} −${removed} lines against what Lingtai composed`;
}

export function Outgoing({
  taskId,
  outgoing,
  sendable = false,
}: {
  taskId: string;
  outgoing: OutgoingView;
  /**
   * Whether the decision row below is offering Send.
   *
   * When it is, the editor offers it too — on the same click that stages the
   * sentence. Staging and sending as two clicks is a sentence typed into a box
   * and then lost to the button that was meant to send it, which is the dead
   * end `#111` is about one step further in.
   */
  sendable?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const run = (text: string) => {
    setBusy(true);
    setRefusal(null);
    startTransition(async () => {
      const result = await editPrompt({ taskId, text, basedOn: outgoing.basedOn });
      setBusy(false);
      if (result.ok) {
        // The page recomposes on the server and this box is handed the new
        // document, so the editor closes onto the thing that will actually run
        // rather than onto a copy of what was typed.
        setDraft(null);
        return;
      }
      setRefusal(result.detail);
    });
  };

  /** Stage the sentence and send the attempt, in that order. See `sendAttempt`. */
  const send = (text: string) => {
    setBusy(true);
    setRefusal(null);
    startTransition(async () => {
      const result = await sendAttempt({ taskId, text, basedOn: outgoing.basedOn });
      setBusy(false);
      if (result.ok) {
        setDraft(null);
        return;
      }
      // Reverted, and the draft is still here: a refusal that lost what was
      // typed would make clicking again mean typing again.
      setRefusal(result.detail);
    });
  };

  if (outgoing.problem !== null) {
    return (
      <div className="outgoing">
        <p className="outhead">
          <span className="outname">will be sent</span>
        </p>
        {/* Never merely absent. A missing template, an unregistered project and
            a recipe that will not parse all look like "no prompt", and only the
            reason tells them apart (#76). */}
        <p className="refusal">The next attempt&rsquo;s prompt cannot be shown: {outgoing.problem}</p>
      </div>
    );
  }

  const changed = delta(outgoing);

  return (
    <div className="outgoing">
      <p className="outhead">
        <span className="outname">will be sent</span>
        {/* How long the edit lasts, on the box that makes it. The next claim
            consumes it, whoever starts it. */}
        <span className="outonly">attempt {outgoing.attempt} only</span>
        <span className="outfact" title={outgoing.version}>
          {outgoing.text.length} bytes
        </span>
      </p>

      {/* The version names the edit, and the page shows the name. Two runs that
          share a `promptVersion` and did not share a prompt is the log lying
          about what produced a result (0032 §5), so the field is on screen
          rather than only in the payload of a history row. */}
      <p className="outver">{outgoing.version}</p>

      {/* Bounded and scrollable rather than collapsed. A prompt is six thousand
          bytes and a page that opens three screens tall is its own kind of
          unreadable — but a document behind a disclosure is one somebody
          approves without opening, which is what this box exists to stop. */}
      <pre className="outtext">{outgoing.text}</pre>

      {outgoing.edit !== null ? (
        <p className="outedit">
          <span className="outwho">{outgoing.edit.by}</span>
          {changed ?? "added a sentence"}
        </p>
      ) : null}

      {draft === null ? (
        <div className="btnrow">
          <button
            className="btn"
            disabled={busy}
            onClick={() => setDraft(outgoing.edit?.text ?? "")}
          >
            {outgoing.edit === null ? "Edit" : "Change the edit"}
          </button>
          {outgoing.edit !== null ? (
            <button className="btn" disabled={busy} onClick={() => run("")}>
              {busy ? "…" : "Remove the edit"}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="outbox">
          {/* Raw text. No toolbar, no rendering, no escaping: what is typed
              here reaches the agent unaltered, inside a block that names who
              wrote it and says it applies to this attempt only. */}
          <textarea
            autoFocus
            rows={4}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="`claude --help` does not list it; read the shipped bundle instead of guessing."
          />
          <p className="outnote">
            Added to attempt {outgoing.attempt} and to no other. Anything meant to last belongs in
            the ticket, where every later attempt reads it.
          </p>
          <div className="btnrow">
            {/* Send is primary when there is something to send: the commonest
                reason to open this box is that the next attempt needs one more
                sentence, and staging it for a pass nobody has asked for is the
                rarer of the two. */}
            {sendable ? (
              <button
                className="btn pri"
                disabled={busy || draft.trim() === ""}
                onClick={() => send(draft)}
              >
                {busy ? "…" : `Send attempt ${outgoing.attempt}`}
              </button>
            ) : null}
            <button
              className={sendable ? "btn" : "btn pri"}
              disabled={busy || draft.trim() === ""}
              onClick={() => run(draft)}
            >
              {busy ? "…" : `Add to attempt ${outgoing.attempt}`}
            </button>
            <button className="btn" disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {refusal ? <p className="refusal">{refusal}</p> : null}
    </div>
  );
}
