"use client";

/**
 * Keeps the board current without a refresh, and says whether it worked.
 *
 * An append reaches Postgres, the trigger notifies, `/api/stream` forwards it,
 * and this asks Next to re-render the route. That last step is deliberate: the
 * board is a *projection*, and folding events into client state here would be a
 * second reducer that can disagree with the first one. Re-reading is cheaper
 * than being subtly wrong.
 *
 * **What it costs is this file's problem too.** A re-read is a whole server
 * render, and on a busy log that is one per append per open board — which is
 * how a 4.7s page became a 4.7s page several times a second (#112). The render
 * itself got faster elsewhere; what is decided here is *how many*: never two at
 * once, and none at all for a tab nobody is looking at. Neither drops an
 * append, because neither judges one — both mark the board stale and re-read
 * once when they can, which is the difference between coalescing and
 * discarding.
 *
 * **The route, and so its filter.** `router.refresh()` re-renders the URL that
 * is showing, so a board narrowed to one project re-reads that same narrowed
 * board and reconciles to the same markup: an append from a project you have
 * filtered out costs a render and moves nothing on the page (#86). Nothing here
 * reads the filter, and that is the choice rather than an omission — skipping an
 * append this component judged irrelevant would trade a re-render nobody can see
 * for a board that silently stops updating, which is the failure `#64` is about.
 * A run's events name a run and not a project, so the judgement would be a guess
 * for most of what arrives during one.
 *
 * `EventSource` reconnects on its own and sends `Last-Event-ID`, so resume is
 * the browser's job and the server's — not this component's. What it does keep
 * is the last seq, so a tab that has been asleep asks for the right place even
 * on a first connection.
 *
 * **The dot reports the projection, not the socket.** It used to report
 * whether this connection was open, which is precisely the thing that was never
 * in doubt on the morning it lied: socket open, chip green, board frozen for
 * the whole of a run (`#64`). Lag is the answer when it is zero. When it is
 * not, the daemon's beacon is what separates *catching up* from *nobody is
 * coming* — and since [0022] a `lingtai run` follows the log itself, so lag
 * without a daemon is ordinary during a run and an accusation after one.
 *
 * **It is a dot, and it carries `#98`'s fact too.** Both of those are
 * `the-bar.md`: a chip is not free, and two boxes for one question — *is the
 * system doing what the code says?* — is two things to learn to read. The
 * currency arrives as a prop because it is git's answer and belongs on a render
 * rather than on the health tick; the fold that weighs the two is `bearing.ts`,
 * and it keeps whichever is not the headline in the title.
 *
 * **It answers whether you are current, never whether anything will move.**
 * Those came apart in `#77`: the projection was at the head, so this said
 * `current` — correctly — for four days in which the conductor was paused and
 * nothing was ever going to run. That fact has its own chip next door
 * (`paused.tsx`), because it is its own fact, it is absent when there is
 * nothing to say, and folding it in would make one dot carry two answers.
 *
 * Several tabs each get their own stream, and all of them update. Nothing here
 * coordinates them, because nothing has to: each one is reading the same
 * projection.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { bearing, type CodeNews } from "@/lib/bearing";
import type { Health } from "@/lib/health";

/**
 * How long to coalesce a burst before re-reading.
 *
 * A run appends steadily — a touched file, a gate verdict — and
 * one round trip per event would make the board re-render dozens of times a
 * second while saying the same thing. This is not polling: nothing fires unless
 * an event arrived.
 *
 * **It bounds the rate and not the cost**, which is the distinction #112 turned
 * on: a render is a fold of the log plus a question to GitHub per project, and
 * four of those a second is four of those a second. Two things below bound the
 * cost instead — a render already in flight is never joined by a second, and a
 * board nobody is looking at does not render at all — and this window keeps
 * doing the one job it was always doing.
 */
const COALESCE_MS = 250;

export function Live({ code }: { code: CodeNews | null }) {
  const router = useRouter();
  const [socket, setSocket] = useState<"connecting" | "open" | "trouble">("connecting");
  const [health, setHealth] = useState<Health | null>(null);
  const lastSeq = useRef<string>("0");

  // The render, as a transition, so this component can tell whether one is
  // still running. `router.refresh()` returns nothing and takes as long as the
  // server component does; without this there is no way to ask, and every
  // coalescing window fired a fresh one into a queue behind the last (#112).
  const [rendering, startRender] = useTransition();
  const inFlight = useRef(false);
  /** An append has arrived that this board has not re-read yet. */
  const stale = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const reread = useCallback(() => {
    stale.current = false;
    // Set here and not only in the effect below, which does not run until after
    // paint: a coalescing window that fired in that gap would see `false` and
    // start a second render into the first one's shadow.
    inFlight.current = true;
    startRender(() => router.refresh());
  }, [router]);

  /**
   * **Never two at once, and never for a tab nobody is looking at.**
   *
   * The flag is the whole mechanism: whatever the reason for not rendering now,
   * the board is marked stale and re-read once when the reason lifts. So a
   * burst during a slow render costs one further render rather than one per
   * event, and a board left open in a background tab costs nothing until it is
   * looked at — which is where most open boards are, and each of them was
   * paying the full price for every append.
   *
   * It cannot silently stop updating, which is the failure `#64` is about: both
   * conditions are events this component is told about, and both wake it.
   */
  const schedule = useCallback(() => {
    stale.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (document.hidden || inFlight.current) return;
      reread();
    }, COALESCE_MS);
  }, [reread]);

  // The render that was in flight has landed. Anything that arrived while it
  // ran is one re-read, now.
  useEffect(() => {
    inFlight.current = rendering;
    if (!rendering && stale.current && !document.hidden) reread();
  }, [rendering, reread]);

  // Coming back to the tab. The board is as old as the last append it ignored.
  useEffect(() => {
    const woken = () => {
      if (!document.hidden && stale.current && !inFlight.current) reread();
    };
    document.addEventListener("visibilitychange", woken);
    return () => document.removeEventListener("visibilitychange", woken);
  }, [reread]);

  useEffect(() => {
    const source = new EventSource(`/api/stream?from=${lastSeq.current}`);

    source.addEventListener("open", () => setSocket("open"));

    source.addEventListener("append", (e) => {
      setSocket("open");
      try {
        const data = JSON.parse((e as MessageEvent).data) as { seq: string };
        // Kept so a first connection after a sleep resumes from here. The
        // browser handles it on an automatic reconnect via Last-Event-ID.
        if (data.seq) lastSeq.current = data.seq;
      } catch {
        // A frame we cannot read still means something changed.
      }
      schedule();
    });

    // The server sends this on connect, on its keep-alive tick, and once a
    // burst of appends has settled. Nothing here polls for it.
    source.addEventListener("health", (e) => {
      setSocket("open");
      try {
        setHealth(JSON.parse((e as MessageEvent).data) as Health);
      } catch {
        // Keep the last answer rather than blanking the chip.
      }
    });

    source.addEventListener("trouble", () => setSocket("trouble"));

    // Fires on a dropped connection too; the browser retries on its own, so
    // this reports rather than reconnects.
    source.addEventListener("error", () => setSocket("trouble"));

    return () => {
      clearTimeout(timer.current);
      source.close();
    };
  }, [schedule]);

  const { label, tone, why, title } = bearing(socket, health, code);
  return (
    <>
      {/* `role="img"` and a label, because the dot is the whole statement in
          the ordinary case and a dot has no text. What a sighted reader gets
          from the colour, a screen reader gets from here. */}
      <span className={`dot ${tone}`} role="img" aria-label={label} title={title} />
      {/* The sentence and the action, and only when there is one. Silence is
          what makes the dot worth glancing at. */}
      {why ? (
        <span className="why" title={title}>
          {why}
        </span>
      ) : null}
    </>
  );
}
