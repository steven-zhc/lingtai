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

type Ended = "landed" | "did not land" | "removed";

export function RunLog({ runId }: { runId: string }) {
  const [lines, setLines] = useState<readonly string[]>([]);
  const [state, setState] = useState<"off" | "reading" | "gone" | "trouble" | Ended>("off");
  const source = useRef<EventSource | null>(null);
  const tail = useRef<HTMLDivElement | null>(null);

  const stop = useCallback(() => {
    source.current?.close();
    source.current = null;
  }, []);

  // Closing the tab, or navigating away, has to take the connection with it —
  // the route is following a file for as long as somebody is listening.
  useEffect(() => stop, [stop]);

  const start = useCallback(() => {
    if (source.current) return;
    setLines([]);
    setState("reading");

    const es = new EventSource(`/api/run/${encodeURIComponent(runId)}`);
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
  }, [runId, stop]);

  // Follow the bottom, which is where a running log is.
  useEffect(() => {
    tail.current?.scrollTo({ top: tail.current.scrollHeight });
  }, [lines]);

  return (
    <details
      className="alog"
      onToggle={(event) => (event.currentTarget.open ? start() : stop())}
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
function say(state: "off" | "reading" | "gone" | "trouble" | Ended, count: number): string {
  if (state === "off") return "not reading";
  if (state === "gone") return "no log";
  if (state === "trouble") return "the stream failed";
  if (state === "reading") return `${count} lines · following`;
  if (state === "removed") return `${count} lines · the log has been deleted`;
  return `${count} lines · ends here`;
}
