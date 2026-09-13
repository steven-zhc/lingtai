/**
 * One health, out of the facts that used to be two chips.
 *
 * `#64` put *is what I am looking at current?* on the bar; `#98` put *is the
 * thing that moves it running the code we merged?* beside it. Both are right
 * and both were argued alone, so the bar ended up with two boxes for one
 * question — and a row that is glanced at can afford one thing to learn to
 * read, not two ([the-bar.md](../../../../doc/design/the-bar.md)).
 *
 * So the two are folded here, into a dot and at most one sentence. **Green and
 * silent is the whole of the ordinary case**; anything else says what is wrong
 * and what to do about it, because a health indicator that reports a fault and
 * not the remedy is one you have to go and look something up for.
 *
 * Neither fact is lost: whichever is not the headline is still in the title,
 * which is why `code.said` is appended to **every** branch below — including the
 * two that say nothing about the code at all. A dead stream and a board that has
 * not answered yet are exactly the states in which somebody wants to know what
 * the daemon is running, and they are the two the old `Stale` chip still
 * rendered in, because a chip does not know what its neighbour is doing.
 *
 * Pure, and its own file, for two reasons. `live.tsx` is a client component and
 * `health.ts` next door reaches for the projection and the beacon — a fold
 * shared between them cannot live in either. And the ordering is the thing a
 * later edit can silently get wrong, so it is asserted directly.
 */
import type { Health } from "./health.ts";

/**
 * Pass, fail, or neither — never the accent and never amber.
 *
 * Amber is the headline's, and the headline's alone: it means *a human is the
 * thing being waited on*, and a second amber on the row dilutes the first,
 * which is the entire reason the palette carries the rule. `idle` is for the
 * states that are true, temporary and nobody's fault — catching up, or a
 * projection nothing has built yet.
 */
export type Tone = "pass" | "warn" | "idle";

/**
 * What the server found out about the code the conductor is holding.
 *
 * Server-side because it shells out to git, which has no business on the SSE
 * health tick that every open tab drives every 25 seconds — the reason this
 * arrives as a prop rather than in the health frame.
 *
 * Null, from the component that builds it, when there is no daemon at all:
 * nothing is then holding old modules open, and the lag half below already
 * says nobody is coming.
 */
export interface CodeNews {
  /** What is wrong, in a few words — null when nothing is. */
  wrong: string | null;
  /** What to do about it. Null exactly when `wrong` is. */
  action: string | null;
  /** The whole of it, wrong or not, for the title. */
  said: string;
}

export interface Bearing {
  tone: Tone;
  /** What the dot would say if a dot could speak. Read by a screen reader. */
  label: string;
  /** The sentence and the action, beside the dot. Null when there is nothing to say. */
  why: string | null;
  /** Both facts, always, on hover. */
  title: string;
}

/** How long ago the daemon last said anything, as a phrase. */
function beating(health: Health): string {
  const secs = Math.round((health.sinceBeatMs ?? 0) / 1000);
  if (health.daemon === "up") return `daemon beating ${secs}s ago`;
  if (health.daemon === "stale") return `no beat for ${secs}s`;
  return "no daemon has ever run";
}

/**
 * Worst first: the first true one wins.
 *
 * A dead stream beats everything, because nothing under it can be trusted. A
 * projection that is behind with nobody folding it beats stale code, because
 * the board is then lying about the thing the code would be doing. Everything
 * else is a variety of *fine, and here is the detail*.
 */
export function bearing(
  socket: "connecting" | "open" | "trouble",
  board: Health | null,
  code: CodeNews | null,
): Bearing {
  // The whole sentence carries both facts wherever there are two, so folding
  // the chips did not make either unreachable. Every branch below goes through
  // it, including the two that are about the stream rather than the board: the
  // currency is a server prop and is known whether or not the socket is up, and
  // "nothing here is updating" is the moment somebody most wants the other half.
  const also = (said: string) => (code ? `${said}; ${code.said}` : said);

  if (socket === "trouble") {
    return {
      tone: "warn",
      label: "offline",
      why: "the event stream is down — reload once it is back",
      title: also("the event stream is down, so nothing here is updating"),
    };
  }
  if (!board) {
    return {
      tone: "idle",
      label: socket === "open" ? "asking" : "connecting",
      why: null,
      title: also("asking whether this board is current"),
    };
  }
  if (board.error) {
    return {
      tone: "warn",
      label: "unknown",
      why: "the projection could not be read",
      title: also(`could not read the projection: ${board.error}`),
    };
  }
  if (board.lag === null) {
    return {
      tone: "idle",
      label: "no board yet",
      why: "nothing has been folded yet — run: lingtai daemon",
      title: also("task_view has never been built"),
    };
  }

  const beat = beating(board);

  // Behind with nothing coming for it. Since 0022 a `lingtai run` holds a
  // projector of its own, so lag alone is ordinary during a run — the beacon is
  // the whole difference between *catching up* and *nobody is coming*.
  if (board.lag > 0 && board.daemon !== "up") {
    return {
      tone: "warn",
      label: `behind ${board.lag} · no daemon`,
      why: `${board.lag} event(s) unfolded — start one with: lingtai daemon --no-conduct`,
      title: also(`${board.lag} event(s) unfolded and ${beat}`),
    };
  }
  // Current, and being advanced by a process running code the repository has
  // moved past. #98's thirty-nine minutes: current and unpaused were both true
  // the whole time, and the fix that had landed could not run.
  if (code?.wrong) {
    return {
      tone: "warn",
      label: code.wrong,
      why: `${code.wrong} — ${code.action}`,
      title: also(board.lag === 0 ? `task_view is at the head — ${beat}` : `catching up — ${beat}`),
    };
  }
  if (board.lag > 0) {
    return {
      tone: "idle",
      label: `behind ${board.lag}`,
      why: "catching up",
      title: also(`catching up — ${beat}`),
    };
  }
  // Both true. A dot, and not a word: this is the state the bar is in nearly
  // all the time, and a box that is present and quiet in the ordinary case is
  // one nobody reads when it is not.
  return {
    tone: "pass",
    label: "current",
    why: null,
    title: also(`task_view is at the head — ${beat}`),
  };
}
