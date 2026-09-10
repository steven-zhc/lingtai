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
 * **The answer arrives as it is produced, not when the agent exits.** That is
 * the defect [0034](../../../../doc/decisions/0034-the-run-log.md) opens with,
 * and it was solved for runs and not here — where the silence costs most,
 * because *a discussion is attended and the person is the loop* (0033 §4) and a
 * loop with no feedback is a person asking again and paying twice. `Thinking`
 * below follows the chat's own log while the answer is being written; see it
 * for what that trace is and is not.
 *
 * **The box has one height.** The moves sit under it and under the outgoing
 * prompt beside it, so a conversation that grew with its content pushed the
 * button you were deciding with off the screen. The conversation scrolls in
 * `.chatscroll`, the input box is under it, and neither moves (#132).
 *
 * The optimistic state is `decide.tsx`'s and so is the trap: a result shown
 * that did not happen is worse than no result, so every action reverts on
 * refusal and says the server's own sentence.
 */
import { useEffect, useRef, useState, useTransition } from "react";
import { askDiscussion, concludeChat } from "./actions.ts";
import { useLogTail } from "./run-log.tsx";
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

/**
 * The answer, while it is being produced.
 *
 * **The defect [0034](../../../../doc/decisions/0034-the-run-log.md) opens with,
 * solved for runs and not for discussions** — *the agent produces nothing until
 * it exits* — and a discussion is where the silence costs most: a run is
 * unattended and needs a hard bound, *a discussion is attended and the person is
 * the loop* (0033 §4). The person was the loop and the loop had no feedback, so
 * an assistant thinking for sixty seconds was indistinguishable from one that
 * had died, and the answer was to ask again and pay twice (#132).
 *
 * The mechanism is 0034's and it is unchanged: the daemon writes the chat's
 * trace to a file named for the `chatId`, and this follows it over the route the
 * ledger's run logs already use. Nothing new is on the wire and nothing new is
 * in the log.
 *
 * **It is a trace and never the answer** (0034 §8). The answer is
 * `DiscussionAnswered` — with its cost, its `read` list and its proposal — and
 * when that lands the board re-renders and this is gone. What is on screen here
 * settles nothing; it says the thing is alive.
 *
 * `awaited`, because the file is *coming*: the board appended the question a
 * moment ago and the daemon has not opened the file yet. A 404 here means not
 * yet, where on a landed attempt it means never.
 */
function Thinking({ chatId }: { chatId: string }) {
  const { lines } = useLogTail(chatId, true, true);
  const tail = useRef<HTMLDivElement | null>(null);

  // Pinned to the bottom of its own scroller, which is where the newest line
  // is. The box's height is `.chat`'s and does not grow with this — a pane that
  // grew with its content would push the moves under it off the screen.
  useEffect(() => {
    tail.current?.scrollTo({ top: tail.current.scrollHeight });
  }, [lines]);

  return (
    <>
      <p className="chatwait">
        {lines.length === 0
          ? "waiting for the daemon to answer"
          : `answering · ${lines.length} line${lines.length === 1 ? "" : "s"} so far`}
      </p>
      {lines.length > 0 ? (
        <div className="chattrace" ref={tail}>
          {/* Never markdown and never a paragraph: it is a log (design §6). */}
          <pre className="hdoctext">{lines.join("\n")}</pre>
        </div>
      ) : null}
    </>
  );
}

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
  const conversation = useRef<HTMLDivElement | null>(null);

  // The one still going, if any. A second conversation is opened by asking a
  // question when there is none open, which is why there is no New button: the
  // box is the New button.
  const open = discussions.find((d) => d.held === null) ?? null;

  // The reply is at the bottom of its own scroller, and that is where the box
  // stays: every append re-renders the board (`live.tsx`), so a turn arriving
  // scrolls to itself rather than waiting to be scrolled to (#132).
  const turns = discussions.reduce((n, d) => n + d.turns.length, 0);
  useEffect(() => {
    conversation.current?.scrollTo({ top: conversation.current.scrollHeight });
  }, [turns]);

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

      {/* The conversation, in its own scroller. The box has one height and this
          is the part of it that grows, so a long exchange scrolls here instead
          of moving the input box under it and the moves under that (#132). */}
      <div className="chatscroll" ref={conversation}>
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
                <Thinking chatId={d.chatId} />
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
      </div>

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
