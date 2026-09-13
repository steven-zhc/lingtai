"use client";

/**
 * Accept or decline one backlog entry (`#137`).
 *
 * **Per entry, and nothing else.** There is no checkbox column and no *accept
 * all*: 0038 §5 refused the rule that decides which minors deserve a ticket,
 * and a batch button is that rule with a person's name on it.
 *
 * Accept asks for the kind, because an issue without one of the recipe's kinds
 * is one the queue never sees, and offers the hold already ticked, because an
 * unheld ticket is one the next pass will claim.
 */
import { useState, useTransition } from "react";
import { acceptBacklogFinding, declineBacklogFinding } from "../actions.ts";

export function DecideFinding({ project, entryKey }: { project: string; entryKey: string }) {
  const [mode, setMode] = useState<"idle" | "accept" | "decline">("idle");
  const [kind, setKind] = useState("tech-debt");
  const [hold, setHold] = useState(true);
  const [reason, setReason] = useState("");
  const [said, setSaid] = useState<{ ok: boolean; detail: string } | null>(null);
  const [pending, startTransition] = useTransition();

  if (said?.ok) return <span className="why">{said.detail}</span>;

  return (
    <span className="btnrow">
      {mode === "idle" ? (
        <>
          <button className="btn pri" onClick={() => setMode("accept")}>
            Accept…
          </button>
          <button className="btn" onClick={() => setMode("decline")}>
            Decline…
          </button>
        </>
      ) : null}
      {mode === "accept" ? (
        <>
          <input aria-label="kind" value={kind} onChange={(e) => setKind(e.target.value)} />
          <label>
            <input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} /> agent:hold
          </label>
          <button
            className="btn pri"
            disabled={pending || !kind.trim()}
            onClick={() =>
              startTransition(async () => {
                setSaid(await acceptBacklogFinding({ project, key: entryKey, kind, hold }));
              })
            }
          >
            {pending ? "…" : "Open the issue"}
          </button>
          <button className="btn" disabled={pending} onClick={() => setMode("idle")}>
            Cancel
          </button>
        </>
      ) : null}
      {mode === "decline" ? (
        <>
          <input aria-label="reason" placeholder="why" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button
            className="btn"
            disabled={pending || !reason.trim()}
            onClick={() =>
              startTransition(async () => {
                setSaid(await declineBacklogFinding({ project, key: entryKey, reason }));
              })
            }
          >
            {pending ? "…" : "Decline"}
          </button>
          <button className="btn" disabled={pending} onClick={() => setMode("idle")}>
            Cancel
          </button>
        </>
      ) : null}
      {said && !said.ok ? <span className="refusal">{said.detail}</span> : null}
    </span>
  );
}

/**
 * Open the issue of an entry already accepted, whose issue the log has not
 * recorded — the store did not answer, or the log did not take the answer.
 *
 * Safe to press twice, or from two tabs, or beside `lingtai backlog accept`:
 * the store finds the issue if one was opened, and opens it if not. There is no
 * decline here, because the entry was accepted.
 */
export function OpenAccepted({ project, entryKey }: { project: string; entryKey: string }) {
  const [said, setSaid] = useState<{ ok: boolean; detail: string } | null>(null);
  const [pending, startTransition] = useTransition();

  if (said?.ok) return <span className="why">{said.detail}</span>;
  return (
    <span className="btnrow">
      <button
        className="btn pri"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setSaid(await acceptBacklogFinding({ project, key: entryKey }));
          })
        }
      >
        {pending ? "…" : "Open the issue"}
      </button>
      {said && !said.ok ? <span className="refusal">{said.detail}</span> : null}
    </span>
  );
}
