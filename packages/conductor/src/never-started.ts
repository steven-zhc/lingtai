/**
 * What a run that never started costs the conductor, and for how long.
 *
 * [0031](../../../doc/decisions/0031-a-run-that-never-started.md) §3 and §4.
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
 * A miss falls back to the recipe's backoff (0028) and the conductor waits
 * longer than it had to. A miss in the other direction — resuming too early —
 * meets the same wall, appends the same `never-started`, and pauses again. No
 * reading of this string can make the system do the wrong thing; it can only
 * make it slower. That is why the same brittle text is safe here and unsafe in
 * `neverStarted`.
 *
 * Nothing here does I/O and nothing here appends. `run-once.ts` is where the
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
 *   a wall clock     `resets 11pm (America/Chicago)`, `resets at 3:30am` — a
 *                    time of day, and a zone when the sentence names one.
 *
 * A wall clock with no zone is read in this host's zone. That is a guess, and
 * it is allowed to be one for the reason in the header: guessing wrong resumes
 * at the wrong moment and costs a pass, not a decision.
 *
 * Anything further out than a week is refused. A `seven_day` limit is the
 * longest thing this can legitimately be describing, and a match beyond it is
 * more likely to be a number that was not a time at all.
 */
export function parseResetAt(detail: string, now: Date = new Date()): Date | null {
  const iso = /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/.exec(
    detail,
  );
  if (iso) return within(new Date(iso[1]!.replace(" ", "T")), now);

  // `resets`, optionally `at`, then a time; then a parenthesised zone if the
  // sentence carries one. Deliberately narrow — a looser pattern would start
  // reading times out of tickets, file names and shas.
  const clock = /\bresets?\b(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(detail);
  if (!clock) return null;

  const zoned = /\(([A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+)*)\)/.exec(
    detail.slice(clock.index + clock[0].length, clock.index + clock[0].length + 40),
  );

  let hour = Number(clock[1]);
  const minute = clock[2] === undefined ? 0 : Number(clock[2]);
  const meridiem = clock[3]?.toLowerCase();
  if (minute > 59) return null;
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }

  const zone = zoned?.[1] ?? hostZone();
  if (!knownZone(zone)) return null;
  return within(nextWallClock(now, zone, hour, minute), now);
}

/**
 * Which agent never started — the run's own, or the one inside a gate.
 *
 * The pause is the same and the sentence is not, which is the whole reason this
 * is a parameter rather than a constant
 * ([0038](../../../doc/decisions/0038-a-gate-that-never-ran.md) §3). A run that
 * never started took no turns and spent nothing, and 0031's sentence says so. A
 * *gate's* agent that never started sits inside a run that **did** start, took
 * turns and was paid for — the implementer produced the diff the reviewer was
 * being asked about. Telling a person `no turns taken, nothing spent` about that
 * pass is the same species of false sentence `#133` is against, one screen along
 * from the card it started on: the board's chip and `lingtai doctor` are exactly
 * where somebody woken at 2am reads it.
 */
export type NeverStarted =
  | { readonly of: "run" }
  /** The point's action, as `point:action` — what the card and the chip name. */
  | { readonly of: "gate"; readonly gate: string };

/** What each opens with, and whose words the quote at the end is. */
function subject(what: NeverStarted): { opening: string; whose: string } {
  if (what.of === "run") {
    return {
      opening: "a run ended without ever starting — no turns taken, nothing spent",
      whose: "The run said",
    };
  }
  return {
    opening:
      `the ${what.gate} gate's agent never started, so nothing judged the diff — ` +
      `the run that reached it did start, and was paid for`,
    whose: `The ${what.gate} gate's agent said`,
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
  const reset = parseResetAt(input.detail, now);
  const until = reset ?? new Date(now.getTime() + input.backoffMs);
  const said = input.detail.trim().replace(/\s+/g, " ").slice(0, 200);
  const from =
    reset === null
      ? "it named no reset time, so this is the recipe's backoff"
      : "read from the message itself";
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
 * The next instant whose wall clock in `zone` reads `hour:minute`.
 *
 * The offset is applied twice because the first application can cross a
 * daylight-saving boundary and change which offset was the right one. Two
 * passes settle every ordinary case, and the residue — the hour that does not
 * exist on a spring-forward morning — is off by an hour, which the header's
 * asymmetry already says is affordable.
 */
function nextWallClock(now: Date, zone: string, hour: number, minute: number): Date {
  const today = partsIn(now, zone);
  const at = (day: number): Date => {
    const naive = Date.UTC(today["year"]!, today["month"]! - 1, day, hour, minute);
    const once = new Date(naive - offsetAt(new Date(naive), zone));
    return new Date(naive - offsetAt(once, zone));
  };
  const candidate = at(today["day"]!);
  // Date.UTC normalises the overflow, so "the 32nd" is the 1st of next month.
  return candidate.getTime() > now.getTime() ? candidate : at(today["day"]! + 1);
}
