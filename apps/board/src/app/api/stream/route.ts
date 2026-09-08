/**
 * Live updates for the board.
 *
 * The board runs on localhost for one person, so Server-Sent Events are the
 * right shape: one direction, text, and the browser reconnects on its own.
 * Postgres already broadcasts every append on the `lingtai` channel, so this
 * is a bridge and not a poller — **`setInterval` appears exactly once in this
 * file and it sends a keep-alive comment**, which is the only timer the design
 * permits anywhere in this path.
 *
 * **Resume is the part that has to be right.** The client sends its last seq
 * back as `Last-Event-ID` — the browser does this on its own for an EventSource
 * — and the subscription starts from there, exclusive. A reconnect therefore
 * replays what was missed rather than skipping it, which is the difference
 * between a board that is behind and a board that is quietly wrong. The seq is
 * also the SSE event id, so this is the same number in both directions.
 *
 * Each connection gets its own subscription. That means each open tab holds a
 * session-mode Postgres connection, which is fine for a console one person has
 * open and would not be for anything larger — said here because the tradeoff is
 * invisible otherwise.
 *
 * **It also carries the board's own health**, on the same socket, because that
 * is the one place a client is already listening. The chip used to report
 * whether this connection was open — the fact never in doubt on the morning it
 * lied (`#64`) — and now reports the projection's lag and the daemon's beacon.
 * A `health` frame goes out on connect, on the keep-alive tick, and shortly
 * after a burst of appends settles.
 */
import { subscribe } from "@lingtai/event-store";
import { readHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

/** Sent to a client so it knows the board it is looking at may be stale. */
interface Frame {
  seq: string;
  type: string;
  streamId: string;
}

export function GET(request: Request): Response {
  // The browser sends this on a reconnect. `?from=` is the manual escape hatch
  // for a first connection that already knows where it is.
  const header = request.headers.get("last-event-id");
  const query = new URL(request.url).searchParams.get("from");
  const raw = header ?? query ?? "0";

  let fromSeq: bigint;
  try {
    fromSeq = BigInt(raw);
  } catch {
    // A client that sends nonsense gets the whole log rather than an error: the
    // board is derived state and replaying it is cheap, while a 400 here would
    // leave a tab silently dead.
    fromSeq = 0n;
  }

  const encoder = new TextEncoder();
  let subscription: { close(): Promise<void> } | null = null;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  // A `setTimeout`, not a second interval: it fires once after a burst of
  // appends stops, so a run that writes fifty events costs one health read.
  let healthSoon: ReturnType<typeof setTimeout> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The client went away between the check and the write.
          open = false;
        }
      };

      send(": connected\n\n");

      /**
       * Two reads against Postgres, so it is never on the append path.
       *
       * A failure is swallowed rather than reported as `trouble`: not knowing
       * the lag is not a reason to tear down a stream that is delivering
       * events perfectly well, and the client keeps showing the last answer.
       */
      const sendHealth = async () => {
        if (!open) return;
        try {
          send(`event: health\ndata: ${JSON.stringify(await readHealth())}\n\n`);
        } catch {
          // The next tick asks again.
        }
      };

      void sendHealth();

      // Proxies and browsers drop an idle event stream; a comment frame is the
      // conventional way to say "still here" without inventing an event type.
      // The health read rides along on the same tick, so a board nobody is
      // appending to still notices a daemon that died.
      keepAlive = setInterval(() => {
        send(": ping\n\n");
        void sendHealth();
      }, 25_000);

      const stop = () => {
        open = false;
        clearInterval(keepAlive);
        clearTimeout(healthSoon);
        void subscription?.close();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      request.signal.addEventListener("abort", stop, { once: true });

      try {
        subscription = subscribe({
          fromSeq,
          name: "lingtai-board",
          onEvent: (event) => {
            const frame: Frame = {
              seq: event.seq.toString(),
              type: event.type,
              streamId: event.streamId,
            };
            // `id:` is what comes back as Last-Event-ID. The payload is
            // deliberately thin — the board re-reads the projection rather than
            // trying to fold events client-side, so this only has to say
            // *something changed* and how far the client has got.
            send(`id: ${frame.seq}\nevent: append\ndata: ${JSON.stringify(frame)}\n\n`);
            // After the burst, not during it. The projector is folding these
            // as they arrive, so the lag worth reporting is the one left when
            // the writing stops.
            clearTimeout(healthSoon);
            healthSoon = setTimeout(() => void sendHealth(), 600);
          },
          onError: (error, phase) => {
            // A connection error retries inside `subscribe`. A handler error
            // stops it, and a client left holding an open socket that will
            // never send again is worse than a closed one.
            send(`event: trouble\ndata: ${JSON.stringify({ phase, message: String(error) })}\n\n`);
            if (phase === "handler") stop();
          },
        });
      } catch (err) {
        send(`event: trouble\ndata: ${JSON.stringify({ phase: "connection", message: String(err) })}\n\n`);
        stop();
      }
    },

    cancel() {
      clearInterval(keepAlive);
      clearTimeout(healthSoon);
      void subscription?.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nothing in front of this on localhost, but a proxy that buffers an
      // event stream turns live updates into a batch every few seconds.
      "x-accel-buffering": "no",
    },
  });
}
