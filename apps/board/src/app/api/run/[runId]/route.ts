/**
 * One run's log, as it is written.
 *
 * The reading half of [0034](../../../../../../doc/decisions/0034-the-run-log.md)
 * on the board's side, and 0034 said what shape it takes: *the board's live
 * view a tail over the SSE it already has — neither needs a new protocol*. This
 * is that protocol, unchanged — `id`/`event`/`data` frames over
 * `text/event-stream`, the browser reconnecting on its own — pointed at a file
 * instead of at Postgres.
 *
 * **A second route rather than a second job for `/api/stream`.** That one holds
 * a session-mode Postgres connection per open tab and says so; giving it a
 * `?run=` would have bought a subscription to the whole event log for every
 * attempt somebody expands. This opens a file descriptor and nothing else. The
 * two speak the same dialect and share no state, which is the point.
 *
 * **From byte zero, every time.** Late joiners get the file from the start —
 * the reason 0034 chose a file over a socket — and that is also what makes a
 * reconnect harmless: there is no resume to get wrong, because re-reading is
 * the ordinary case. `Last-Event-ID` is deliberately ignored here for that
 * reason, where on `/api/stream` honouring it is the thing that has to be right.
 *
 * **It never says how the run went.** The log is a trace and not a record
 * (§8); the ledger row this sits inside already carries the outcome, folded
 * from `events`. What the `end` frame reports is that the writer let go.
 */
import { findRunLog, followRunLog } from "@lingtai/conductor/run-log";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await context.params;
  const found = await findRunLog(decodeURIComponent(runId));

  if (!found) {
    // 404 and not an empty stream: a landed run has no log (0034 §4) and an
    // `EventSource` given an empty one would reconnect for ever asking for it.
    // The client turns this into a sentence and stops.
    return new Response(`no run log for ${runId}`, { status: 404 });
  }

  const encoder = new TextEncoder();
  // `EventSource` has no way to say "stop"; closing the tab aborts the request,
  // and this is what the follow is watching.
  const detach = new AbortController();
  request.signal.addEventListener("abort", () => detach.abort(), { once: true });

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

      send(`event: at\ndata: ${JSON.stringify({ project: found.project, path: found.path })}\n\n`);

      try {
        for await (const seen of followRunLog({ path: found.path, signal: detach.signal })) {
          if ("line" in seen) {
            // JSON, so a line carrying anything at all — the agent printed it —
            // cannot break the frame it is inside.
            send(`event: line\ndata: ${JSON.stringify(seen.line)}\n\n`);
          } else {
            send(`event: end\ndata: ${JSON.stringify({ ended: seen.ended })}\n\n`);
          }
        }
      } catch (err) {
        send(`event: trouble\ndata: ${JSON.stringify({ message: String(err) })}\n\n`);
      }

      open = false;
      try {
        controller.close();
      } catch {
        // Already closed.
      }
    },

    cancel() {
      detach.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
