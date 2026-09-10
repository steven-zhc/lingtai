"use client";

/**
 * One attempt's run log, on the board, when you ask for it.
 *
 * The other half of `#110`, and it sits inside the ledger row (`#102`) because
 * that is where the attempt is: a log belongs to a run, and a run is an
 * attempt. In that row's order it comes second — what the agent was told, then
 * **what it did**, then what it changed and how it was judged.
 *
 * **Off until asked, which is the whole of the design here.** Nothing tails
 * anything on a page load: the `<details>` is closed, and the connection is
 * opened by the first toggle and never before. A task page with six attempts
 * would otherwise hold six file descriptors and six streams for a page nobody
 * scrolled down.
 *
 * **Except the one that is producing output right now** (`live`, #132). That
 * reason is about six attempts nobody asked to see, and it made *the run
 * happening this second* two disclosures deep with nothing on the page saying
 * it was there — `#110` built the stream and the page hid it. A running attempt
 * opens itself and its log opens with it; every finished attempt is closed and
 * reads nothing, which is the reason above, intact.
 *
 * **From the beginning, however late.** The route re-reads the file from byte
 * zero every time, so expanding a run that has been going for four minutes
 * shows the four minutes — the property 0034 chose a file over a socket for.
 * Nothing here is resumed and nothing is remembered between toggles.
 *
 * **It never says how the run went.** The row's own pill already carries that,
 * folded from `events`; the log is a trace and not a record (0034 §8). What
 * `end` says is that there is no more to come.
 *
 * No colour, on purpose — `#107` owns the vocabulary for every surface, and the
 * ticket leaves this outside it rather than have the board invent a second one
 * for the same facts.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLatch } from "./latch.tsx";

/**
 * How much of one log is held in the browser.
 *
 * The file is capped at `RUN_LOG_MAX_BYTES` — eight megabytes — and a `<pre>`
 * of eight megabytes is a tab that stops responding, which is a worse way to
 * fail than showing less. The head is what goes: a log is read forwards from
 * the start, and the interesting end of a run that is still going is the
 * bottom. `lingtai attach` has no such bound and neither does the file.
 */
const KEEP_LINES = 2_000;

/**
 * How long to wait before asking again for a log that is not there yet.
 *
 * Only for a follower that has been told the file is coming — the discussion
 * box, whose question the board appended a moment ago and whose daemon has not
 * opened the file yet (#132). A run's log is never waited for like this: a
 * `<details>` somebody opened on a landed attempt is asking about a file that
 * has been deleted, and retrying that is a poll for something that will never
 * arrive.
 */
const AGAIN_MS = 1_500;

/**
 * How many times, before *not yet* is answered as *not coming*.
 *
 * A bound and not a courtesy. `DiscussionAsked` is appended by the board and
 * answered by whatever daemon is running, and a question asked with none running
 * waits in the stream until one starts — which may be tomorrow (`answerOutstanding`).
 * Unbounded, that is a tab asking for a 404 every second and a half until it is
 * closed, which is the second half of what #132 found: a box that cannot tell a
 * daemon thinking from a daemon that is not there. Thirty seconds is far past
 * the time it takes a running daemon to open the file, so reaching this is the
 * answer rather than an impatience.
 */
const AGAIN_LIMIT = 20;

type Ended = "landed" | "did not land" | "removed";

/**
 * What the follower knows about the file. Never about the run (0034 §8).
 *
 * `waiting` is `gone` seen by a caller that was told the file is coming and is
 * still asking (`awaited`, `AGAIN_LIMIT`). The distinction is the whole of what
 * a reader needs: *it is not there yet* and *it is not coming* are the two
 * sentences a box waiting for an answer has to be able to tell apart.
 */
export type TailState = "off" | "reading" | "waiting" | "gone" | "trouble" | Ended;

/**
 * Follow one log file over the route's SSE, for as long as `following`.
 *
 * The half of this file that is not chrome, extracted because `#132` gives it a
 * second reader: the discussion box tails a chat's log exactly as a ledger row
 * tails a run's, and two copies of an `EventSource` lifecycle is two places for
 * a connection to be left open.
 */
export function useLogTail(
  id: string,
  following: boolean,
  /** Whether a missing file is *not yet* rather than *never*. See `AGAIN_MS`. */
  awaited = false,
): { lines: readonly string[]; state: TailState } {
  const [lines, setLines] = useState<readonly string[]>([]);
  const [state, setState] = useState<TailState>("off");
  // Bumped to ask again for a file that has not been created yet; nothing else
  // restarts a stream, so a follow is one connection per attempt at one.
  const [again, setAgain] = useState(0);
  const source = useRef<EventSource | null>(null);

  const stop = useCallback(() => {
    source.current?.close();
    source.current = null;
  }, []);

  const start = useCallback(() => {
    if (source.current) return;
    setLines([]);
    setState("reading");

    const es = new EventSource(`/api/run/${encodeURIComponent(id)}`);
    source.current = es;

    es.addEventListener("line", (event) => {
      const line = JSON.parse((event as MessageEvent<string>).data) as string;
      setLines((previous) => {
        const next = [...previous, line];
        return next.length > KEEP_LINES ? next.slice(next.length - KEEP_LINES) : next;
      });
    });

    es.addEventListener("end", (event) => {
      const { ended } = JSON.parse((event as MessageEvent<string>).data) as { ended: Ended };
      setState(ended);
      // The server closed its side; without this the browser reconnects on its
      // own and re-reads the whole file for ever.
      stop();
    });

    es.addEventListener("trouble", () => {
      setState("trouble");
      stop();
    });

    // A 404 — a run that landed and took its log with it — arrives here, since
    // `EventSource` reports every failure the same way. Distinguishing them
    // would need a `fetch` first, and the two sentences are close enough that a
    // second round trip is not worth it.
    es.onerror = () => {
      setState((was) => (was === "reading" ? "gone" : was));
      stop();
    };
  }, [id, stop]);

  // One connection for as long as it is followed, and none at all while it is
  // not. The cleanup is also what closing the tab or navigating away runs — the
  // route is following a file for as long as somebody is listening.
  useEffect(() => {
    if (!following) return;
    // `again` is read for the dependency and for nothing else: changing it is
    // what re-runs this effect.
    void again;
    start();
    return stop;
  }, [following, again, start, stop]);

  // The file that is coming rather than gone. Asked for again, while somebody is
  // still waiting for it and while *not yet* is still the likelier reading —
  // past `AGAIN_LIMIT` the state stands as `gone`, which is what a caller shows
  // when nothing is writing.
  useEffect(() => {
    if (!following || !awaited || state !== "gone" || again >= AGAIN_LIMIT) return;
    const timer = setTimeout(() => setAgain((n) => n + 1), AGAIN_MS);
    return () => clearTimeout(timer);
  }, [following, awaited, state, again]);

  // `gone` is only an answer once the asking has stopped. Derived on the way
  // out rather than held, so the retry above keeps keying on the one state the
  // stream actually reported.
  return { lines, state: state === "gone" && awaited && again < AGAIN_LIMIT ? "waiting" : state };
}

export function RunLog({
  runId,
  live = false,
}: {
  runId: string;
  /**
   * Whether this attempt is still going, in which case the log opens with it.
   *
   * Decided by the page from the fold — `run.outcome.state` — and not asked of
   * this component, which knows about a file and never about a run (0034 §8).
   */
  live?: boolean;
}) {
  // Open is latched rather than a bare attribute because it is now two things:
  // a running attempt starts open, and a reader can close it. `useState(live)`
  // would read `live` once — so a log mounted before its run started would
  // never open — and a bare `open={live}` would shut it again when the run
  // ended. See `latch.tsx`.
  const [open, setOpen] = useLatch(live, live);
  const { lines, state } = useLogTail(runId, open);
  const tail = useRef<HTMLDivElement | null>(null);

  // Follow the bottom, which is where a running log is.
  useEffect(() => {
    tail.current?.scrollTo({ top: tail.current.scrollHeight });
  }, [lines]);

  return (
    <details
      className="alog"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="hdocname">run log</span>
        <span className="hdocsize">{say(state, lines.length)}</span>
      </summary>
      {state === "gone" ? (
        <p className="empty">
          No log for this run. A log is deleted when the run&apos;s diff reaches the base branch —
          what is kept is exactly the runs still owed an explanation (0034 §4).
        </p>
      ) : (
        <div className="alogbody" ref={tail}>
          <pre className="hdoctext">{lines.join("\n")}</pre>
        </div>
      )}
    </details>
  );
}

/** What the right of the summary says, and it is about the file, never the run. */
function say(state: TailState, count: number): string {
  if (state === "off") return "not reading";
  // A run's log is never `awaited`, so this is the discussion box's state and
  // not one a ledger row can reach. Said anyway, rather than falling through to
  // `ends here` on a file that has not started.
  if (state === "waiting") return "no log yet";
  if (state === "gone") return "no log";
  if (state === "trouble") return "the stream failed";
  if (state === "reading") return `${count} lines · following`;
  if (state === "removed") return `${count} lines · the log has been deleted`;
  return `${count} lines · ends here`;
}
