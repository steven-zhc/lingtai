/**
 * What the board says while the daemon is on its way out.
 *
 * Its own fact, and independent is the whole reason it is its own chip. The
 * health dot answers *is what I am looking at current?* and *is the thing that
 * moves it the code we merged?* (`health.tsx`), `paused.tsx` answers *is
 * anything going to move?* — and a daemon that has been told to stop is
 * current, unpaused and up to date while it finishes the last pass it will ever
 * run. Folding that into `up` is the same mistake #77 made with `paused`: one
 * word cannot carry independent answers.
 *
 * It names the ticket because *stopping* and *stopping, finishing lingtai#94*
 * are different pieces of news — the first invites a second Ctrl+C, and the
 * second is the reason not to
 * ([0030](../../../../doc/decisions/0030-shutting-down-safely.md) §1: the
 * boundary is the pass, not the agent).
 *
 * **Absent when there is nothing to say**, which is what makes a chip
 * affordable at all on a row whose unit is the row (#134). A drain lasts
 * minutes to hours and then the daemon is gone, at which point `live.tsx` says
 * the board is no longer being advanced.
 *
 * A server component: it reads the beacon and the projection, neither of which
 * belongs on the SSE health tick every open tab drives.
 */
import { STALE_AFTER_MS, describeInFlight, inFlight, readStatus } from "@lingtai/daemon/control";

export async function Draining() {
  const status = await readStatus().catch(() => null);
  if (!status) return null;
  // A beacon that says `draining` and stopped beating is a daemon that has
  // finished draining — or died mid-drain. Either way `live.tsx` owns that
  // sentence, and this one would be reporting an intention nobody holds.
  if (Date.now() - status.lastSeenAt.getTime() > STALE_AFTER_MS) return null;
  if (status.state !== "draining") return null;

  const held = await inFlight().catch(() => []);
  const said = `the conductor is finishing the pass in flight and will then stop; it is taking no new work`;

  return (
    <>
      <span className="sep" />
      {/* Held rather than warned: nothing is broken, and a red chip would send
          somebody looking for a fault instead of reading the sentence. */}
      <span className="chip held" title={said}>
        draining
      </span>
      <span className="why" title={said}>
        {describeInFlight(held)}
      </span>
    </>
  );
}
