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
 * `EventSource` reconnects on its own and sends `Last-Event-ID`, so resume is
 * the browser's job and the server's — not this component's. What it does keep
 * is the last seq, so a tab that has been asleep asks for the right place even
 * on a first connection.
 *
 * **The chip reports the projection, not the socket.** It used to report
 * whether this connection was open, which is precisely the thing that was never
 * in doubt on the morning it lied: socket open, chip green, board frozen for
 * the whole of a run (`#64`). Lag is the answer when it is zero. When it is
 * not, the daemon's beacon is what separates *catching up* from *nobody is
 * coming* — and since [0022] a `lingtai run` follows the log itself, so lag
 * without a daemon is ordinary during a run and an accusation after one.
 *
 * **It answers whether you are current, never whether anything will move.**
 * Those came apart in `#77`: the projection was at the head, so this chip said
 * `current` — correctly — for four days in which the conductor was paused and
 * nothing was ever going to run. That fact has its own chip next door
 * (`paused.tsx`), because it is its own fact and folding it in here would make
 * one word carry two answers.
 *
 * Several tabs each get their own stream, and all of them update. Nothing here
 * coordinates them, because nothing has to: each one is reading the same
 * projection.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * How long to coalesce a burst before re-reading.
 *
 * A run appends steadily — a touched file, a gate verdict — and
 * one round trip per event would make the board re-render dozens of times a
 * second while saying the same thing. This is not polling: nothing fires unless
 * an event arrived.
 */
const COALESCE_MS = 250;

interface Health {
  lag: number | null;
  daemon: "up" | "stale" | "never";
  sinceBeatMs: number | null;
  error?: string;
}

/** What the chip says, and why. Ordered worst-first: the first true one wins. */
function read(socket: "connecting" | "open" | "trouble", health: Health | null): {
  label: string;
  tone: "live" | "idle" | "warn";
  title: string;
} {
  // The socket still matters — but as the reason the *numbers* are stale,
  // not as the headline. A dead stream means nothing below can be trusted.
  if (socket === "trouble") {
    return { label: "offline", tone: "warn", title: "the event stream is down; nothing here is updating" };
  }
  if (!health) {
    return { label: socket === "open" ? "…" : "connecting", tone: "idle", title: "asking" };
  }
  if (health.error) {
    return { label: "unknown", tone: "warn", title: `could not read the projection: ${health.error}` };
  }
  if (health.lag === null) {
    return { label: "no board yet", tone: "idle", title: "task_view has never been built — run lingtai daemon" };
  }

  const beat =
    health.daemon === "up"
      ? `daemon beating ${Math.round((health.sinceBeatMs ?? 0) / 1000)}s ago`
      : health.daemon === "stale"
        ? `no beat for ${Math.round((health.sinceBeatMs ?? 0) / 1000)}s`
        : "no daemon has ever run";

  if (health.lag === 0) return { label: "current", tone: "live", title: `task_view is at the head — ${beat}` };

  // Behind, and whether that is temporary depends entirely on the beacon. A
  // `lingtai run` holds a projector of its own, so this is only alarming when
  // it persists.
  if (health.daemon === "up") {
    return { label: `behind ${health.lag}`, tone: "idle", title: `catching up — ${beat}` };
  }
  return {
    label: `behind ${health.lag} · no daemon`,
    tone: "warn",
    title: `${health.lag} event(s) unfolded and ${beat} — start one with: lingtai daemon --no-conduct`,
  };
}

export function Live() {
  const router = useRouter();
  const [socket, setSocket] = useState<"connecting" | "open" | "trouble">("connecting");
  const [health, setHealth] = useState<Health | null>(null);
  const lastSeq = useRef<string>("0");

  useEffect(() => {
    const source = new EventSource(`/api/stream?from=${lastSeq.current}`);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), COALESCE_MS);
    };

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
      refresh();
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
      clearTimeout(timer);
      source.close();
    };
  }, [router]);

  const { label, tone, title } = read(socket, health);
  return (
    <span className={`chip ${tone}`} title={title}>
      {label}
    </span>
  );
}
