"use client";

/**
 * The discussion box, inside the decision column.
 *
 * One of the two objects the layout notes allow a frame in that column — the
 * outgoing prompt is the other — because it is a place you *do* something and
 * not a thing you read.
 *
 * **The meter, and why it is here rather than in a limit.**
 * [0033](../../../../doc/decisions/0033-the-third-kind-of-agent.md) §4: a run
 * is unattended and needs a hard bound; a discussion is attended and the person
 * is the control loop. That is only true if the person can see the number, so
 * the running total sits on the box's own rule and updates as the conversation
 * goes — the board re-renders on every append (`live.tsx`), so this needs no
 * poller and no second reducer.
 *
 * **The two outputs are two buttons, and there is no third.** *Use for the next
 * run* appends `PromptEdited`, which the next claim consumes and discards; *Add
 * to the ticket* appends the sentence to the GitHub issue body, where everybody
 * can see it and every later attempt reads it (0033 §2). *Close* ends the
 * conversation with neither, which is the commonest ending there is.
 *
 * **What it cannot do is printed, not implied.** `reading` is Lingtai's own
 * sentence about what was readable, recorded on the ask before the assistant
 * said anything — so *"attempt 2 left no branch; I am reading main"* appears
 * whether or not the answer mentions it. `cannot` is the assistant's own list
 * of what a command would have been needed for, and it is shown at the same
 * weight as the answer rather than folded into it: `#89` cost two attempts
 * because an inference was presented as a finding, and this is the page that
 * exists so that does not happen again.
 *
 * The optimistic state is `decide.tsx`'s and so is the trap: a result shown
 * that did not happen is worse than no result, so every action reverts on
 * refusal and says the server's own sentence.
 */
import { useState, useTransition } from "react";
import { askDiscussion, concludeChat } from "./actions.ts";
import type { DiscussionView } from "@/lib/task";

/** `$1.20`, or nothing at all when no figure was reported. See `costUsd`. */
function meter(costUsd: number | null): string | null {
  return costUsd === null ? null : `$${costUsd.toFixed(2)}`;
}

/**
 * The meter, on the box's own rule: `this conversation $0.64 · 3 messages · no limit`.
 *
 * **0033 §4 is not implemented without it, it is merely unenforced.** There is
 * no spend limit on a discussion because the person is the control loop — and a
 * person can only be the limit if the person can see the number. The heading
 * carried the boundary (*it cannot run anything*) and no cost at all, so the one
 * agent on this page with no ceiling was the one with no reading (#111).
 *
 * Three facts, in the order a person checks them: what this conversation has
 * cost, how many exchanges bought it, and that nothing will stop it. `no limit`
 * is said rather than implied, because an unstated limit reads as a limit
 * somebody else is keeping.
 *
 * `$0.00` is not printed for a conversation that has not reported a figure yet.
 * A null cost is *nobody said*, not *free* — the same reading `RunFinished`
 * gets — so a first question in flight says `asked` and waits for the number.
 */
function openMeter(open: DiscussionView): string {
  const messages = open.turns.length;
  return [
    `this conversation ${meter(open.costUsd) ?? (open.waiting ? "asked" : "no figure")}`,
    `${messages} message${messages === 1 ? "" : "s"}`,
    "no limit",
  ].join(" · ");
}

/**
 * What the box's rule says when nothing is open.
 *
 * The boundary before the first question, because what it *cannot* do is the
 * thing worth knowing before asking; afterwards the ledger's own shape — how
 * many were held, and what they came to. The total joins the attempts' figures
 * in `totalsFact`, where it is counted into `$13.04` rather than sitting beside
 * it (0033 §4, #111).
 */
function closedMeter(discussions: readonly DiscussionView[]): string {
  if (discussions.length === 0) {
    return "reads the log, the ticket and the code — it cannot run anything";
  }
  const spend = discussions.reduce((n, d) => n + (d.costUsd ?? 0), 0);
  return `${discussions.length} held${spend > 0 ? ` · $${spend.toFixed(2)}` : ""} · no limit`;
}

const HELD: Record<NonNullable<DiscussionView["held"]>, string> = {
  prompt: "used for the next run",
  ticket: "added to the ticket",
  none: "closed",
};

export function Discussion({
  taskId,
  attempt,
  discussions,
}: {
  taskId: string;
  /** The attempt a new question is about — the newest one, or null. */
  attempt: number | null;
  discussions: DiscussionView[];
}) {
  const [question, setQuestion] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  // The one still going, if any. A second conversation is opened by asking a
  // question when there is none open, which is why there is no New button: the
  // box is the New button.
  const open = discussions.find((d) => d.held === null) ?? null;

  const run = (action: () => Promise<{ ok: boolean; detail: string }>) => {
    setBusy(true);
    setRefusal(null);
    startTransition(async () => {
      const result = await action();
      setBusy(false);
      if (result.ok) {
        setQuestion("");
        return;
      }
      setRefusal(result.detail);
    });
  };

  return (
    <div className="chat">
      <p className="chathead">
        <span className="chatname">discussion</span>
        {/* Live without a poller: every append re-renders the board
            (`live.tsx`), so the figure on screen is the figure on the log. */}
        <span className="chatfact">
          {open === null ? closedMeter(discussions) : openMeter(open)}
        </span>
      </p>

      {discussions.map((d) => (
        <div key={d.chatId} className={d.held === null ? "chatlog" : "chatlog done"}>
          {d.turns.map((t) => (
            <div key={t.at} className="chatturn">
              <p className="chatq">
                <span className="chatwho">{t.by}</span>
                {t.question}
              </p>

              {/* Lingtai's sentence, not the assistant's, and shown before the
                  answer for that reason. An attempt that left no branch is a
                  fact about what was read; leaving it to the answer to mention
                  is exactly what killed #89's repair. */}
              {t.reading.length > 0 ? (
                <ul className="chatreading">
                  {t.reading.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}

              {t.answer === null ? (
                <p className="chatwait">waiting for the daemon to answer</p>
              ) : (
                <>
                  {t.answer.failure ? (
                    <p className="chatfail">{t.answer.failure}</p>
                  ) : null}
                  {/* Raw. An answer is a log's document by `markdown.tsx`'s
                      rule — nobody wrote it in a box that says markdown — and
                      the default there is never rendered. */}
                  {t.answer.text ? <p className="chata">{t.answer.text}</p> : null}

                  {t.answer.cannot.length > 0 ? (
                    <ul className="chatcannot">
                      {t.answer.cannot.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  ) : null}

                  <p className="chatmeta">
                    {t.answer.read.length > 0 ? (
                      <span className="chatread" title={t.answer.read.join("\n")}>
                        read {t.answer.read.length} file(s)
                      </span>
                    ) : (
                      <span className="chatread">read no files</span>
                    )}
                    {meter(t.answer.costUsd) ? (
                      <span className="chatcost">{meter(t.answer.costUsd)}</span>
                    ) : null}
                  </p>

                  {/* The proposal, and the two places it can go. Nothing is
                      written until one of these is clicked — the assistant
                      proposes, a person decides (0033 §2). */}
                  {t.answer.proposal && d.held === null ? (
                    <div className="chatprop">
                      <p className="chatpropkind">
                        {t.answer.proposal.kind === "prompt"
                          ? "proposed for the next run"
                          : "proposed for the ticket"}
                      </p>
                      <p className="chatproptext">{t.answer.proposal.text}</p>
                      <div className="btnrow">
                        <button
                          className={t.answer.proposal.kind === "prompt" ? "btn pri" : "btn"}
                          disabled={busy}
                          onClick={() =>
                            run(() =>
                              concludeChat({
                                taskId,
                                chatId: d.chatId,
                                outcome: "prompt",
                                text: t.answer?.proposal?.text ?? "",
                              }),
                            )
                          }
                        >
                          Use for the next run
                        </button>
                        <button
                          className={t.answer.proposal.kind === "ticket" ? "btn pri" : "btn"}
                          disabled={busy}
                          onClick={() =>
                            run(() =>
                              concludeChat({
                                taskId,
                                chatId: d.chatId,
                                outcome: "ticket",
                                text: t.answer?.proposal?.text ?? "",
                              }),
                            )
                          }
                        >
                          Add to the ticket
                        </button>
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ))}

          {d.held !== null ? <p className="chatheld">{HELD[d.held]}</p> : null}
        </div>
      ))}

      <div className="chatask">
        <textarea
          rows={2}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={
            open === null ? "why did attempt 2 not produce a branch?" : "ask a follow-up"
          }
        />
        <div className="btnrow">
          <button
            className="btn pri"
            disabled={busy || !question.trim()}
            onClick={() =>
              run(() =>
                askDiscussion({
                  taskId,
                  attempt: open?.attempt ?? attempt,
                  question,
                  ...(open === null ? {} : { chatId: open.chatId }),
                }),
              )
            }
          >
            {busy ? "asking…" : "Ask"}
          </button>
          {/* Closing with neither artefact is an ending and not an absence: a
              question answered that needed nothing written down is the
              commonest discussion there is, and the log says so. */}
          {open !== null && !open.waiting ? (
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                run(() =>
                  concludeChat({ taskId, chatId: open.chatId, outcome: "none", text: "" }),
                )
              }
            >
              Close
            </button>
          ) : null}
        </div>
      </div>

      {refusal ? <p className="refusal">{refusal}</p> : null}
    </div>
  );
}
