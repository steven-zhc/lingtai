/**
 * What the board says when the daemon is running code the repository has moved
 * past.
 *
 * The third independent fact in the bar. `live.tsx` answers *is what I am
 * looking at current?*, `paused.tsx` answers *is anything going to move?*, and
 * neither could have answered *is the thing that moves it the code we merged?*
 * — which on 2026-09-08 was no, for thirty-nine minutes and 52 lost prompts
 * (`#98`). Node caches a module at import, so a daemon is a deployment of
 * whatever `HEAD` pointed at when it started;
 * [0010](../../../../doc/decisions/0010-source-runs-unbuilt.md) removed the
 * build step and reads as though it removed the restart too.
 *
 * Three chips rather than three states of one, for the reason there were two:
 * a single word cannot carry independent answers, and folding them makes the
 * green one lie about the other.
 *
 * **Absent when there is nothing to say.** Level with the base is the ordinary
 * case, and a chip that is present and quiet in the ordinary case is one nobody
 * reads when it is not.
 *
 * A server component: it shells out to git, which has no business on the SSE
 * health tick that every open tab drives every 25 seconds. It re-reads whenever
 * the board does — an append, or a reload — and the fact it reports only
 * changes when somebody restarts a process.
 */
import { lastBeat, readStatus } from "@lingtai/daemon/control";
import { codeCurrency, describeCurrency } from "@lingtai/daemon/currency";

export async function Stale() {
  const status = await readStatus().catch(() => null);
  // No daemon, or one that stopped: nothing is holding old modules open, and
  // `live.tsx` already says the board is not being advanced.
  if (!status) return null;
  if (!lastBeat(status).up) return null;

  if (!status.codeSha) {
    return (
      <>
        <span className="sep" />
        <span
          className="chip warn"
          title="this daemon started before the beacon carried a commit, so what code it is running cannot be read from here — restart it with: pnpm lingtai daemon"
        >
          code unknown
        </span>
      </>
    );
  }

  const currency = await codeCurrency({ sha: status.codeSha, dirty: status.codeDirty }).catch(
    () => null,
  );
  // Not knowing is the same silence this chip exists to break, so it says so
  // rather than rendering as though the daemon were current.
  if (!currency) {
    return (
      <>
        <span className="sep" />
        <span className="chip warn" title="the daemon's commit could not be compared against the repository">
          code unknown
        </span>
      </>
    );
  }
  if (currency.unknown || currency.behind.length === 0) return null;

  return (
    <>
      <span className="sep" />
      <span className="chip warn" title={describeCurrency(currency)}>
        daemon {currency.behind.length} behind
      </span>
      <span className="why" title={describeCurrency(currency)}>
        running {currency.running?.slice(0, 7)} — restart it to take them
      </span>
    </>
  );
}
