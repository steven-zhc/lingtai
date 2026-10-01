/**
 * What a run that never started costs the conductor, and for how long.
 *
 * [0031](../../../doc/decisions-archive/0031-a-run-that-never-started.md) §3 and §4.
 * Two decisions live here and they are different in kind, which is the whole
 * reason the file exists rather than an `if` beside the append:
 *
 * **How long.** A run that never started met something account-wide — a quota,
 * a signed-out runtime — and every other item in the queue would meet it
 * identically. Six of them proved that in ninety-two seconds, eighty events,
 * six worktrees and six branches, at a cost of nothing. So the conductor stops
 * rather than the item backing off, and the question is when it starts again.
 *
 * **Read the message for a time, never for a verdict.** The prose said `resets
 * 11pm (America/Chicago)` and the system waited out a flat hour instead, idle
 * for twelve minutes after the limit had already lifted. Reading it is worth
 * doing; reading it *for the classification* is not, and the difference is the
 * asymmetry: **a parse that misses costs efficiency and never correctness.**
 * A miss falls back to the recipe's backoff (0028), and resuming too early
 * meets the same wall, appends the same `never-started`, and pauses again. No
 * reading of this string can make the system do the wrong thing; it can only
 * make it slower. That is why the same brittle text is safe here and unsafe in
 * `neverStarted`.
 *
 * **Which way the cost runs depends on the wall, and that is what hid #210.**
 * A miss means waiting *longer* only while the true reset is sooner than the
 * backoff — a `five_hour` limit and a one-hour backoff. When the reset is
 * further out than the backoff, a miss means resuming early, meeting the wall
 * and pausing again, once per backoff until it lifts: a `seven_day` limit
 * worded `resets Sep 19 at 9am` was met forty-five times across a 45-hour wall,
 * because this file could read the session limit's wording and not the weekly
 * one's. Still correct; never cheap.
 *
 * And a miss is said as a miss. A message that named a reset this file could
 * not read is not a message that named none, and `standDown` tells the two
 * apart — the first is a fault in this parser, and the sentence quotes the
 * fragment so a reader is pointed at it rather than away from it.
 *
 * Nothing here does I/O and nothing here appends. `conduct.ts` is where the
 * pause is written, and it is one call.
 */

/**
 * A reset time read out of a runtime's own message, or null.
 *
 * The forms it knows are the ones that have actually been seen, and it knows
 * them in the order of how much they can be trusted:
 *
 *   an ISO instant   `"resets_at":"2026-09-09T04:00:00Z"` — unambiguous, so it
 *                    is tried first and taken as it stands.
 *   a dated clock    `resets Sep 19 at 9am (America/Chicago)` — the weekly
 *                    limit's wording: a month and a day, then a time of day.
 *   a wall clock     `resets 11pm (America/Chicago)`, `resets at 3:30am` — a
 *                    time of day, and a zone when the sentence names one.
 *
 * A wall clock with no zone is read in this host's zone. That is a guess, and
 * it is allowed to be one for the reason in the header: guessing wrong resumes
 * at the wrong moment and costs a pass, not a decision.
 *
 * Anything further out than a week is refused. A `seven_day` limit is the
 * longest thing this can legitimately be describing — the dated form is that
 * limit's own — and a match beyond it is more likely to be a number that was
 * not a time at all.
 *
 * Null covers two different facts, a message that named no reset and one that
 * named a reset this could not read; `standDown` needs them apart and uses
 * `readReset` for it.
 */
export function parseResetAt(detail: string, now: Date = new Date()): Date | null {
  const read = readReset(detail, now);
  return read !== null && "at" in read ? read.at : null;
}

/** What a message said about when the wall lifts. */
type Reset =
  /** A time was read. */
  | { readonly at: Date }
  /** A reset was named and nothing usable came out of it — the fragment, clipped. */
  | { readonly named: string }
  /** Nothing in the message was about a reset. */
  | null;

/**
 * Where a message talks about its reset: `resets`, a `resets_at` field, or
 * Codex's `Try again in 3 hours`. The last is not parsed — a relative duration
 * is its own ticket — but it is a reset that was named, and saying otherwise is
 * the false sentence #210 is about.
 */
const RESET_MARKER = /\bresets?\b|\bresets_at\b|\btry again in\b/i;

/** English month names and their abbreviations, as the runtime writes them. */
const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;

function readReset(detail: string, now: Date): Reset {
  const iso = /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/.exec(
    detail,
  );
  const at = iso ? within(new Date(iso[1]!.replace(" ", "T")), now) : clockReset(detail, now);
  if (at) return { at };

  const marker = RESET_MARKER.exec(detail);
  if (!marker) return null;
  const named = detail
    .slice(marker.index, marker.index + 60)
    .split("\n")[0]!
    .trim();
  return { named };
}

function clockReset(detail: string, now: Date): Date | null {
  // `resets`, optionally a month and a day (and a year), optionally `at`, then
  // a time; then a parenthesised zone if the sentence carries one. Deliberately
  // narrow — a looser pattern would start reading times out of tickets, file
  // names and shas. The date is a month *name*, never a bare number, so
  // `resets 11pm` cannot have its hour read as a day.
  const clock = new RegExp(
    String.raw`\bresets?\b` +
      String.raw`(?:\s+(?:on\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?,?)?` +
      String.raw`(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?`,
    "i",
  ).exec(detail);
  if (!clock) return null;

  const zoned = /\(([A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+)*)\)/.exec(
    detail.slice(clock.index + clock[0].length, clock.index + clock[0].length + 40),
  );

  let hour = Number(clock[4]);
  const minute = clock[5] === undefined ? 0 : Number(clock[5]);
  const meridiem = clock[6]?.toLowerCase();
  if (minute > 59) return null;
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }

  const zone = zoned?.[1] ?? hostZone();
  if (!knownZone(zone)) return null;

  if (clock[1] === undefined) return within(nextWallClock(now, zone, hour, minute), now);

  // A date names *that* day. It is never rolled forward to the next one, which
  // is right for a bare time and wrong for a date: a date already gone by is a
  // message this cannot account for, and says so.
  const month = MONTHS.indexOf(clock[1].slice(0, 3).toLowerCase() as (typeof MONTHS)[number]) + 1;
  const day = Number(clock[2]);
  const thisYear = partsIn(now, zone)["year"]!;
  const named = clock[3] === undefined ? null : Number(clock[3]);
  for (const year of named === null ? [thisYear, thisYear + 1] : [named]) {
    // Date.UTC would read `Feb 30` as the 2nd of March; a day the month does
    // not have is not a date at all.
    if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
    const at = wallClockOn(zone, year, month, day, hour, minute);
    // The next year only for a date with no year that has gone by this one —
    // `resets Jan 2` read on the 30th of December. The week ceiling is what
    // refuses every other reading of it.
    if (at.getTime() > now.getTime()) return within(at, now);
  }
  return null;
}

/**
 * Which agent never started — the run's own, or the one inside a gate.
 *
 * The pause is the same and the sentence is not, which is the whole reason this
 * is a parameter rather than a constant
 * ([0041](../../../doc/decisions-archive/0041-a-gate-that-never-ran.md) §3). A run that
 * never started took no turns and spent nothing, and 0031's sentence says so. A
 * *gate's* agent that never started sits inside a run that **did** start, took
 * turns and was paid for — the implementer produced the diff the reviewer was
 * being asked about. Telling a person `no turns taken, nothing spent` about that
 * pass is the same species of false sentence `#133` is against, one screen along
 * from the card it started on: the board's chip and `lingtai doctor` are exactly
 * where somebody woken at 2am reads it.
 *
 * **A variant is a set of clauses that are all true together, and that is what
 * makes them four rather than one** (`#265`). Each says *which* agent met the wall
 * and *what had already been paid for* by the time it did, so two agents share a
 * variant exactly where those answers are the same — the reviewer and a runtime
 * `judge:` do, both being `{of: "step"}` — and need their own where they differ.
 * A variant stretched over a case it is false about is `#133`.
 */
export type NeverStarted =
  | { readonly of: "run" }
  /** The point's action, as `point:action` — what the card and the chip name. */
  | { readonly of: "step"; readonly step: string }
  /**
   * **The drafting agent, which is the first one a pass can buy** (`#265`) — the
   * `agent:` a recipe declares at `design`, as `design:action`.
   *
   * Its own variant because it is the one agent that sits inside a run that
   * started and has paid for **no** agent yet: `agentPlugin.at` opens at `design`
   * before any other step, so nothing ahead of it dispatches one. `{of: "run"}`
   * would say *no turns taken, nothing spent* about a run that claimed the ticket,
   * cut a worktree and installed; `{of: "step"}` would say *nothing judged the
   * diff*, and there is no diff at `design`.
   */
  | { readonly of: "draft"; readonly step: string }
  /**
   * The agent a refusal bought (0038), which is the last agent in a pass and
   * meets the same wall the others do. `action` is what refused.
   */
  | { readonly of: "fix"; readonly action: string; readonly round: number };

/** What each opens with, and whose words the quote at the end is. */
function subject(what: NeverStarted): { opening: string; whose: string } {
  if (what.of === "run") {
    return {
      opening: "a run ended without ever starting — no turns taken, nothing spent",
      whose: "The run said",
    };
  }
  if (what.of === "draft") {
    return {
      opening:
        `the ${what.step} step's agent never started, so nothing drafted the design — ` +
        `the run that reached it did start, and had paid for no agent yet`,
      whose: `The ${what.step} step's agent said`,
    };
  }
  if (what.of === "fix") {
    return {
      opening:
        `the agent bought to fix ${what.action} (round ${what.round}) never started, so nothing ` +
        `answered the refusal — the run that reached it did start, and was paid for`,
      whose: "The fixing agent said",
    };
  }
  return {
    opening:
      `the ${what.step} step's agent never started, so nothing judged the diff — ` +
      `the run that reached it did start, and was paid for`,
    whose: `The ${what.step} step's agent said`,
  };
}

/**
 * When the conductor takes work again, and the sentence saying why.
 *
 * The sentence is what the board's pause chip shows (#77) and what
 * `lingtai doctor` prints, so it has to carry three things a person woken by it
 * would ask: what happened, until when, and where the time came from. The
 * runtime's own words are quoted rather than summarised — they are the evidence
 * the classification refused to read, and dropping them here would leave the
 * reason for an account-wide stop nowhere at all.
 *
 * *What* happened is `what`, and it is required rather than defaulted: the two
 * callers are the two depths the same wall is met at, and a default would let a
 * third arrive wearing whichever sentence happened to be first.
 */
export function standDown(input: {
  detail: string;
  /** `source.backoff` in milliseconds, for when the message named no time. */
  backoffMs: number;
  what: NeverStarted;
  now?: Date;
}): { until: Date; reason: string } {
  const now = input.now ?? new Date();
  const reset = readReset(input.detail, now);
  const until = reset !== null && "at" in reset ? reset.at : new Date(now.getTime() + input.backoffMs);
  const said = input.detail.trim().replace(/\s+/g, " ").slice(0, 200);
  // Three branches and not two (#210). A reset that was named and could not be
  // read is a fault in `parseResetAt`, not a fact about the account, and it is
  // said as one — quoting the fragment, so the reader is sent to the string
  // rather than told there is nothing to look for.
  const from =
    reset === null
      ? "it named no reset time, so this is the recipe's backoff"
      : "at" in reset
        ? "read from the message itself"
        : `it named a reset time (\`${reset.named}\`) this build could not read, so this is the ` +
          `recipe's backoff — that is a bug in parseResetAt, not the account`;
  const { opening, whose } = subject(input.what);
  return {
    until,
    reason:
      `${opening}. ` +
      `Every queued item would meet the same thing, so the conductor is taking no work ` +
      `until ${until.toISOString()} (${from}). ${whose}: ${said || "nothing at all"}`,
  };
}

// ------------------------------------------------------------------ time ----

/** A week out is the longest a reset can honestly be. See `parseResetAt`. */
const A_WEEK_MS = 7 * 24 * 3_600_000;

function within(at: Date, now: Date): Date | null {
  const ms = at.getTime();
  if (Number.isNaN(ms)) return null;
  if (ms <= now.getTime()) return null;
  if (ms - now.getTime() > A_WEEK_MS) return null;
  return at;
}

function hostZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function partsIn(at: Date, zone: string): Record<string, number> {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(at)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return parts;
}

/** How far `zone` is from UTC at a given instant, in milliseconds. */
function offsetAt(at: Date, zone: string): number {
  const p = partsIn(at, zone);
  return Date.UTC(p["year"]!, p["month"]! - 1, p["day"]!, p["hour"]!, p["minute"]!, p["second"]!) - at.getTime();
}

/**
 * The instant whose wall clock in `zone` reads `hour:minute` on that day.
 * `month` is 1-based, as it is written.
 *
 * The offset is applied twice because the first application can cross a
 * daylight-saving boundary and change which offset was the right one. Two
 * passes settle every ordinary case, and the residue — the hour that does not
 * exist on a spring-forward morning — is off by an hour, which the header's
 * asymmetry already says is affordable.
 */
function wallClockOn(zone: string, year: number, month: number, day: number, hour: number, minute: number): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const once = new Date(naive - offsetAt(new Date(naive), zone));
  return new Date(naive - offsetAt(once, zone));
}

/** The next instant whose wall clock in `zone` reads `hour:minute`. */
function nextWallClock(now: Date, zone: string, hour: number, minute: number): Date {
  const today = partsIn(now, zone);
  const at = (day: number): Date => wallClockOn(zone, today["year"]!, today["month"]!, day, hour, minute);
  const candidate = at(today["day"]!);
  // Date.UTC normalises the overflow, so "the 32nd" is the 1st of next month.
  return candidate.getTime() > now.getTime() ? candidate : at(today["day"]! + 1);
}
