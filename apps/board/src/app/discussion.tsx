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
 * goes — the task page re-renders on every append (`Follow`, in `live.tsx`), so
 * this needs no poller and no second reducer.
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
 * **The box has one height.** The moves sat under it and under the outgoing
 * prompt beside it, so a conversation that grew with its content pushed the
 * button you were deciding with off the screen. The conversation scrolls in
 * `.chatscroll`, the input box is under it, and neither moves (#132) — and the
 * moves are above the pair now, so nothing in here is before them (#152).
 *
 * **Turns, not a transcript** (#152): a bubble each, with who said it, pinned
 * to the newest line, and an answer being written grows under a caret.
 *
 * The optimistic state is `decide.tsx`'s and so is the trap: a result shown
 * that did not happen is worse than no result, so every action reverts on
 * refusal and says the server's own sentence.
 */
import { useEffect, useRef, useState, useTransition } from "react";
import { askDiscussion, concludeChat } from "./actions.ts";
import { useLogTail, type TailState } from "./run-log.tsx";
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

/** A question this page sent, and how many turns the fold held when it was sent. */
export interface Echo {
  question: string;
  turns: number;
}

/**
 * The question to echo, or null once the fold holds it.
 *
 * **The person sees their own words land before the log does** (#172). The
 * append is what makes a question real, and it is a round trip and then a
 * re-render away; a box that shows nothing in between reads as a button that did
 * nothing, and the answer to that is to press it again. So the words are shown
 * the moment Ask is pressed, and stop being shown the moment the fold has one
 * more turn than it had then — which is the question, arrived, in its place.
 * Not matched on its text: the same question asked twice is two turns.
 */
export function echoing(discussions: readonly DiscussionView[], echo: Echo | null): string | null {
  if (echo === null) return null;
  return turnsIn(discussions) > echo.turns ? null : echo.question;
}

function turnsIn(discussions: readonly DiscussionView[]): number {
  return discussions.reduce((n, d) => n + d.turns.length, 0);
}

/**
 * The sentence above a turn nothing has answered yet, for each state its trace
 * can be in.
 *
 * Separated from the follow so that **this is a value and not a connection**: a
 * test can hand it every state, where it could not hand `Thinking` an
 * `EventSource`.
 *
 * **No state here says the turn is dead, and none says to ask again.** Both were
 * tried and both were wrong. A question with no daemon to answer it is queued on
 * the log and will be answered when one starts. Telling a reader it had died sent
 * them to ask again, which buys a second agent for a question that was going to
 * be answered anyway — the exact cost #132 is about.
 *
 * **And a deleted trace is not said to be an answer.** `answerDiscussion`
 * deletes the file twice: in its `finally`, after the answer is recorded, and at
 * the *start* of a turn, to clear what a daemon killed mid-answer left behind.
 * Both look the same to a follower, and only the first has an answer behind it,
 * so the sentence claims neither — and the follower asks again (`asksAgain`), so
 * a second daemon's trace replaces this one as soon as it is opened.
 *
 * **And an open trace is not said to be work unless its writer is touching it.**
 * A daemon killed mid-answer leaves its file, and nothing removes it while the
 * item is blocked: a follower opens it, reports `reading`, and tails a file
 * nobody writes. The daemon's beacon cannot tell the two apart — a
 * `--no-conduct` daemon beats and answers nothing, and a page reads the beacon
 * once, so a daemon killed under an open page is still up on it. The file's own
 * mtime can: the daemon answering bumps it every `RUN_LOG_BEAT_MS`, and the route
 * says, while the page is open, when it stops (`writing`). False means what is
 * on screen is what a daemon wrote before it stopped. Null, before the route has
 * said, keeps the ordinary sentence rather than accusing a daemon that may be
 * writing.
 */
export function traceSays(state: TailState, lines: number, writing: boolean | null = null): string {
  switch (state) {
    case "reading":
      if (writing === false) {
        return (
          "nothing is writing this trace, so nothing is answering this now · what is here is what a daemon wrote " +
          "before it stopped. The question is answered when a conducting daemon starts, and asking again would buy a second one"
        );
      }
      return lines === 0
        ? "the daemon has started on this — nothing written yet"
        : `answering · ${lines} line${lines === 1 ? "" : "s"} so far`;
    case "queued":
      return (
        "no daemon has started on this yet. The question is on the log and is answered " +
        "when one runs; the answer appears here when it lands, and asking again would buy a second one"
      );
    case "removed":
    case "landed":
    case "did not land":
      // The trace ended. That is an answer being recorded, or a daemon starting
      // this turn over after one died — and this page cannot tell which, so it
      // says what it is doing about both.
      return (
        "the trace this page was following has ended · the answer appears here when it is " +
        "recorded, and if a daemon starts this turn over its trace appears here instead"
      );
    case "trouble":
    case "gone":
      // The follow failed, not the turn. The answer re-renders the page when
      // it is appended whether or not anything here is following.
      return "this page stopped following the answer as it is written — it still appears here when it lands; reload to follow it again";
    case "off":
    case "waiting":
      return "waiting for the daemon to answer";
  }
}

/**
 * What the box shows for a turn nothing has answered yet — the sentence, and the
 * trace under it once there is one.
 *
 * `data-trace` is the state the sentence was chosen from, on the element, so
 * what the box is following is a fact of the page and not only of its words.
 */
export function Trace({
  lines,
  state,
  writing = null,
}: {
  lines: readonly string[];
  state: TailState;
  /** Whether the file's writer is still touching it, as the route last said. See `traceSays`. */
  writing?: boolean | null;
}) {
  const tail = useRef<HTMLDivElement | null>(null);

  // Pinned to the bottom of its own scroller, which is where the newest line
  // is. The box's height is `.chat`'s and does not grow with this — a pane that
  // grew with its content would have pushed the moves off the screen when they
  // sat under it, and still pushes the input box.
  useEffect(() => {
    tail.current?.scrollTo({ top: tail.current.scrollHeight });
  }, [lines]);

  // **The answer grows under a caret** (#152), and only while something could
  // be writing it: a trace nobody is touching (`writing === false`) or one that
  // has ended is not a cursor, and a blinking one there would say *answering*
  // over a sentence that says it is not.
  const caret = state === "reading" && writing !== false;

  return (
    <>
      <p className="chatwait" data-trace={state}>
        {traceSays(state, lines.length, writing)}
      </p>
      {lines.length > 0 ? (
        <div className="chattrace" ref={tail}>
          {/* Never markdown and never a paragraph: it is a log (design §6). */}
          <pre className="hdoctext">
            {lines.join("\n")}
            {caret ? <span className="caret" aria-hidden="true" /> : null}
          </pre>
        </div>
      ) : caret ? (
        <span className="caret" aria-hidden="true" />
      ) : null}
    </>
  );
}

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
 * The mechanism is 0034's and it is unchanged: the daemon writes the turn's
 * trace to a file named for the `chatId`, and this follows it over the route the
 * ledger's run logs already use. Nothing new is in the log, and the one thing
 * new on the wire is `writer` — whether the file is still being touched.
 *
 * **It is a trace and never the answer** (0034 §8). The answer is
 * `DiscussionAnswered` — with its cost, its `read` list and its proposal — and
 * when that lands the page re-renders and this is gone. What is on screen here
 * settles nothing; it says the thing is alive.
 *
 * `awaited`, because the file is *coming*: the board appended the question a
 * moment ago and the daemon has not opened the file yet. A 404 here means not
 * yet, where on a landed attempt it means never — and it is asked about again,
 * less often each time, for as long as the turn is on screen, because a
 * question asked with no daemon running is still going to be answered
 * (`againAfter`).
 *
 * **One per chat, on the oldest unanswered turn.** The file is the chat's and
 * `answerOutstanding` answers a chat's turns one at a time, oldest first, so the
 * trace on disk is always that turn's. A follow-up asked while the first is
 * still being answered does not follow it — it would open the same file and
 * print the first question's trace under the second, called live.
 */
function Thinking({ chatId }: { chatId: string }) {
  const { lines, state, writing } = useLogTail(chatId, true, true);
  return <Trace lines={lines} state={state} writing={writing} />;
}

/**
 * A question this page has sent and the fold does not hold yet. See `echoing`.
 *
 * Says where it is and nothing else: *asking* while the append is in flight,
 * *on the log* once it has returned. What happens to it after that is the
 * turn's own trace, which replaces this the moment the page re-renders.
 */
export function Echoed({ question, busy }: { question: string; busy: boolean }) {
  return (
    <div className="chatturn" data-echo="">
      <div className="bubble asked">
        <p className="chatwho">you</p>
        <p className="chatq">{question}</p>
      </div>
      <p className="chatwait">{busy ? "asking…" : "on the log · waiting for the daemon to answer"}</p>
    </div>
  );
}

export function Discussion({
  taskId,
  attempt,
  discussions,
  quiet = false,
}: {
  taskId: string;
  /** The attempt a new question is about — the newest one, or null. */
  attempt: number | null;
  discussions: DiscussionView[];
  /**
   * No brass in the box. Brass is *a person is being waited on*, and while an
   * item is running nobody is, so on that page Ask and a proposal's buttons are
   * ordinary buttons (#152). They still work; nothing is asking you to press
   * them.
   */
  quiet?: boolean;
}) {
  const pri = quiet ? "btn" : "btn pri";
  const [question, setQuestion] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<Echo | null>(null);
  const [, startTransition] = useTransition();
  const conversation = useRef<HTMLDivElement | null>(null);

  // The one still going, if any. A second conversation is opened by asking a
  // question when there is none open, which is why there is no New button: the
  // box is the New button.
  const open = discussions.find((d) => d.held === null) ?? null;
  const echoed = echoing(discussions, echo);

  /**
   * The reply is at the bottom of its own scroller, and that is where the box
   * stays: every append re-renders the page, so a turn arriving scrolls to
   * itself rather than waiting to be scrolled to (#132).
   *
   * **Which page is the fact that matters.** `/` re-renders on append because it
   * mounts `Live`, and `/task/<id>` — the only page this pane is on — because
   * its route mounts `Follow`; both are in `live.tsx`. This comment used to say
   * *the board*, which was true of `/` and false here, and every reader after it
   * believed the task page was subscribed when it was not: a question, the
   * trace's sentence and the answer each waited for a reload (#172).
   *
   * **Keyed on what the scroller holds, not on how many turns there are.** The
   * count does not change when an *answer* lands — the turn was already there,
   * asked and unanswered — and that is the one moment the content grows, and the
   * moment the reader is waiting for. So the key is every fact this pane renders
   * off: which chats, how many turns each, which of them are answered, and
   * whether a chat has been concluded.
   *
   * The live trace inside a turn is not in here: it is client state this fold
   * never sees, and it has its own bounded scroller (`.chattrace`) that pins
   * itself. What it *does* change is this pane's height — a trace box mounting
   * under an unanswered turn grows the turn by up to 9rem — and that is the
   * observer below.
   */
  const shown = discussions
    .map(
      (d) =>
        `${d.chatId}:${d.turns.length}:${d.turns.filter((t) => t.answer !== null).length}:${d.held ?? ""}`,
    )
    .join("|") + (echoed === null ? "" : "|echo");
  /** Whether the reader is at the end, so growth follows them and never pulls them back. */
  const atEnd = useRef(true);
  useEffect(() => {
    const pane = conversation.current;
    if (!pane) return;
    pane.scrollTo({ top: pane.scrollHeight });
    atEnd.current = true;

    // **Growth the key cannot see** (#132): the trace mounting under a turn, and
    // its box growing to its bound. Watched on the chats themselves, because a
    // scroller's own box does not change size when its content does. Only while
    // the reader is at the end — somebody who scrolled up to reread is left
    // where they are.
    if (typeof ResizeObserver === "undefined") return;
    const follow = new ResizeObserver(() => {
      if (atEnd.current) pane.scrollTo({ top: pane.scrollHeight });
    });
    for (const child of Array.from(pane.children)) follow.observe(child);
    return () => follow.disconnect();
  }, [shown]);

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
      // A refused ask did not happen, so its words come back off the pane.
      setEcho(null);
      setRefusal(result.detail);
    });
  };

  return (
    <div className={quiet ? "chat quiet" : "chat"}>
      <p className="chathead">
        <span className="chatname">discussion</span>
        {/* Live without a poller: every append re-renders this page
            (`Follow`, in `live.tsx`), so the figure on screen is the figure on
            the log. */}
        <span className="chatfact">
          {open === null ? closedMeter(discussions) : openMeter(open)}
        </span>
      </p>

      {/* The conversation, in its own scroller. The box has one height and this
          is the part of it that grows, so a long exchange scrolls here instead
          of moving the input box under it (#132). */}
      <div
        className="chatscroll"
        ref={conversation}
        onScroll={(event) => {
          const pane = event.currentTarget;
          // A pixel of slack: fractional scroll positions never reach exactly.
          atEnd.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 1;
        }}
      >
      {discussions.map((d) => (
        <div key={d.chatId} className={d.held === null ? "chatlog" : "chatlog done"}>
          {d.turns.map((t, i) => (
            <div key={t.at} className="chatturn">
              {/* **Turns, not a transcript** (#152): who said it, and a bubble
                  each. The question is the person's and the answer is the
                  assistant's, and a reader scanning up the pane reads the
                  authors before the words. */}
              <div className="bubble asked">
                <p className="chatwho">{t.by}</p>
                <p className="chatq">{t.question}</p>
              </div>

              {/* Lingtai's sentence, not the assistant's, and shown before the
                  answer for that reason — between the two bubbles, in neither.
                  An attempt that left no branch is a fact about what was read;
                  leaving it to the answer to mention is exactly what killed
                  #89's repair. */}
              {t.reading.length > 0 ? (
                <ul className="chatreading">
                  {t.reading.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}

              <div className="bubble answer">
              <p className="chatwho">assistant</p>
              {t.answer === null ? (
                // Only the turn being answered follows the chat's trace; see
                // `Thinking`. A later one waits its turn, and says so.
                i === d.turns.findIndex((u) => u.answer === null) ? (
                  <Thinking chatId={d.chatId} />
                ) : (
                  <p className="chatwait" data-trace="behind">
                    asked after the question above · answered once that one is, and its trace appears here then
                  </p>
                )
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
                          className={t.answer.proposal.kind === "prompt" ? pri : "btn"}
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
                          className={t.answer.proposal.kind === "ticket" ? pri : "btn"}
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
            </div>
          ))}

          {/* A follow-up, echoed in the conversation it continues. */}
          {echoed !== null && d.chatId === open?.chatId ? (
            <Echoed question={echoed} busy={busy} />
          ) : null}

          {d.held !== null ? <p className="chatheld">{HELD[d.held]}</p> : null}
        </div>
      ))}
      {/* A first question opens a conversation the fold does not have yet. */}
      {echoed !== null && open === null ? (
        <div className="chatlog">
          <Echoed question={echoed} busy={busy} />
        </div>
      ) : null}
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
            className={pri}
            disabled={busy || !question.trim()}
            onClick={() => {
              setEcho({ question, turns: turnsIn(discussions) });
              run(() =>
                askDiscussion({
                  taskId,
                  attempt: open?.attempt ?? attempt,
                  question,
                  ...(open === null ? {} : { chatId: open.chatId }),
                }),
              );
            }}
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
